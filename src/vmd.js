/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDFiles/src/lib/VMD.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * VMD motion files, read as Library_MMDFiles/VMD.cpp does: right-handed
 * coordinates (MMDFILES_CONVERTCOORDINATESYSTEM), key frames sorted per bone
 * / morph, and 256-step Bézier lookup tables for interpolation.
 */

const TABLE_SIZE = 256; // VMD_INTERPOLATIONTABLESIZE

const sjis = new TextDecoder('shift_jis');

/** ipfunc: t → value of the cubic Bézier (0,0) (p1) (p2) (1,1). */
function ipfunc(t, p1, p2) {
  return (1 + 3 * p1 - 3 * p2) * t * t * t + (3 * p2 - 6 * p1) * t * t + 3 * p1 * t;
}

/** ipfuncd: derivative of ipfunc. */
function ipfuncd(t, p1, p2) {
  return (3 + 9 * p1 - 9 * p2) * t * t + (6 * p2 - 12 * p1) * t + 3 * p1;
}

/** VMD::solveInterpolationX: t for which ipfunc(t, x1, x2) == x. */
export function solveInterpolationX(x, x1, x2) {
  let t = x;
  for (let i = 0; i < 8; i += 1) {
    const v = ipfunc(t, x1, x2) - x;
    if (Math.abs(v) < 0.0001) return t;
    const tt = ipfuncd(t, x1, x2);
    if (tt < 1e-6) break;
    t -= v / tt;
  }
  // bisection fallback, as written in VMD.cpp (it reuses x2 for the value)
  let t0 = 0;
  let t1 = 1;
  let t2 = x;
  if (t2 < t0) return t0;
  if (t2 > t1) return t1;
  for (let n = 0; t0 < t1 && n < 200; n += 1) {
    x2 = ipfunc(t2, x1, x2);
    if (Math.abs(x2 - x) < 0.0001) return t2;
    if (x > x2) t0 = t2;
    else t1 = t2;
    t2 = (t1 - t0) * 0.5 + t0;
  }
  return t2;
}

/**
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @returns {Float32Array}
 */
function makeTable(x1, y1, x2, y2) {
  const table = new Float32Array(TABLE_SIZE + 1);
  for (let d = 0; d < TABLE_SIZE; d += 1) {
    const t = solveInterpolationX(d / TABLE_SIZE, x1, x2);
    table[d] = ipfunc(t, y1, y2);
  }
  table[TABLE_SIZE] = 1;
  return table;
}

/**
 * Interpolated rate in [0, 1] for linear position `w` in [0, 1].
 * @param {Float32Array | null} table null for linear
 * @param {number} w
 */
export function interpolate(table, w) {
  if (!table) return w;
  const idx = Math.floor(w * TABLE_SIZE);
  return table[idx] + (table[Math.min(TABLE_SIZE, idx + 1)] - table[idx]) * (w * TABLE_SIZE - idx);
}

/**
 * @typedef {{ frame: number, pos: number[], rot: number[], tables: Array<Float32Array | null> }} BoneKey
 * @typedef {{ frame: number, weight: number }} FaceKey
 * @typedef {{ frame: number, distance: number, pos: number[], angle: number[], fovy: number, noPerspective: boolean, tables: Array<Float32Array | null> }} CameraKey
 * @typedef {{ frame: number, display: boolean, ik: Array<{ name: string, enable: boolean }> }} SwitchKey
 * @typedef {{
 *   modelName: string,
 *   maxFrame: number,
 *   bones: Map<string, BoneKey[]>,
 *   faces: Map<string, FaceKey[]>,
 *   camera: CameraKey[],
 *   cameraMaxFrame: number,
 *   switches: SwitchKey[],
 * }} Vmd
 */

/**
 * @param {ArrayBuffer | Uint8Array} data
 * @returns {Vmd}
 */
export function parseVmd(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const need = (n) => {
    if (p + n > u8.length) throw new Error('VMD が途中で切れています');
  };
  const str = (n) => {
    need(n);
    let end = p;
    while (end < p + n && u8[end] !== 0) end += 1;
    const s = sjis.decode(u8.subarray(p, end));
    p += n;
    return s;
  };
  const u32 = () => { need(4); const v = dv.getUint32(p, true); p += 4; return v; };
  const f32 = () => { need(4); const v = dv.getFloat32(p, true); p += 4; return v; };
  const u8v = () => { need(1); return u8[p++]; };

  const header = str(30);
  if (!header.startsWith('Vocaloid Motion Data')) throw new Error('VMD ではありません');
  const modelName = str(20);

  /** @type {Vmd} */
  const vmd = { modelName, maxFrame: 0, bones: new Map(), faces: new Map(), camera: [], cameraMaxFrame: 0, switches: [] };

  const numBone = u32();
  for (let i = 0; i < numBone; i += 1) {
    const name = str(15);
    const frame = u32();
    const x = f32(), y = f32(), z = f32();
    const rx = f32(), ry = f32(), rz = f32(), rw = f32();
    need(64);
    const ip = u8.subarray(p, p + 64);
    p += 64;
    /** @type {Array<Float32Array | null>} */
    const tables = [];
    for (let k = 0; k < 4; k += 1) {
      const base = k * 16;
      const linear = ip[base] === ip[base + 4] && ip[base + 8] === ip[base + 12];
      tables.push(linear ? null : makeTable(ip[base] / 127, ip[base + 4] / 127, ip[base + 8] / 127, ip[base + 12] / 127));
    }
    if (vmd.maxFrame < frame) vmd.maxFrame = frame;
    let list = vmd.bones.get(name);
    if (!list) vmd.bones.set(name, (list = []));
    list.push({ frame, pos: [x, y, -z], rot: [-rx, -ry, rz, rw], tables });
  }

  if (p < u8.length) {
    const numFace = u32();
    for (let i = 0; i < numFace; i += 1) {
      const name = str(15);
      const frame = u32();
      const weight = f32();
      if (vmd.maxFrame < frame) vmd.maxFrame = frame;
      let list = vmd.faces.get(name);
      if (!list) vmd.faces.set(name, (list = []));
      list.push({ frame, weight });
    }
  }

  if (p < u8.length) {
    const numCamera = u32();
    for (let i = 0; i < numCamera; i += 1) {
      const frame = u32();
      const distance = f32();
      const x = f32(), y = f32(), z = f32();
      const ax = f32(), ay = f32(), az = f32();
      need(24);
      const ip = u8.subarray(p, p + 24);
      p += 24;
      const fovy = u32();
      const noPerspective = u8v() !== 0;
      /** @type {Array<Float32Array | null>} */
      const tables = [];
      for (let k = 0; k < 6; k += 1) {
        const linear = ip[k * 4] === ip[k * 4 + 2] && ip[k * 4 + 1] === ip[k * 4 + 3];
        tables.push(linear ? null : makeTable(ip[k * 4] / 127, ip[k * 4 + 2] / 127, ip[k * 4 + 1] / 127, ip[k * 4 + 3] / 127));
      }
      const deg = 180 / Math.PI;
      vmd.camera.push({
        frame, distance: -distance, pos: [x, y, -z], angle: [-ax * deg, -ay * deg, az * deg], fovy, noPerspective, tables,
      });
      if (vmd.cameraMaxFrame < frame) vmd.cameraMaxFrame = frame;
    }
    vmd.camera.sort((a, b) => a.frame - b.frame);
  }

  // light and self-shadow frames are skipped (MMDAgent-EX does not use them either)
  if (p < u8.length) p += u32() * 28;
  if (p < u8.length) p += u32() * 9;

  if (p < u8.length) {
    const numSwitch = u32();
    for (let i = 0; i < numSwitch; i += 1) {
      const frame = u32();
      const display = u8v() !== 0;
      const numIk = u32();
      const ik = [];
      for (let k = 0; k < numIk; k += 1) ik.push({ name: str(20), enable: u8v() !== 0 });
      vmd.switches.push({ frame, display, ik });
    }
    vmd.switches.sort((a, b) => a.frame - b.frame);
  }

  for (const list of vmd.bones.values()) list.sort((a, b) => a.frame - b.frame);
  for (const list of vmd.faces.values()) list.sort((a, b) => a.frame - b.frame);
  return vmd;
}

/**
 * Write a VMD (tests and MOTIONCAPTURE): bones and faces only, linear interpolation.
 * Positions / rotations are given in the right-handed coordinates used here.
 * @param {{ bones?: Array<{ name: string, frame: number, pos: number[], rot: number[] }>, faces?: Array<{ name: string, frame: number, weight: number }>, modelName?: string }} motion
 * @returns {Uint8Array}
 */
export function writeVmd(motion) {
  const bones = motion.bones || [];
  const faces = motion.faces || [];
  const size = 30 + 20 + 4 + bones.length * 111 + 4 + faces.length * 23 + 4 + 4 + 4;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let p = 0;
  const sjisBytes = (s) => {
    // encode ASCII directly; other characters through a small table is not available,
    // so callers pass names that round-trip (tests use ASCII or pre-encoded bytes)
    const b = [];
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (c < 0x80) b.push(c);
      else for (const x of encodeSjisChar(ch)) b.push(x);
    }
    return b;
  };
  const putStr = (s, n) => {
    const b = sjisBytes(s);
    for (let i = 0; i < n; i += 1) out[p + i] = i < b.length ? b[i] : 0;
    p += n;
  };
  putStr('Vocaloid Motion Data 0002', 30);
  putStr(motion.modelName || '', 20);
  dv.setUint32(p, bones.length, true); p += 4;
  for (const b of bones) {
    putStr(b.name, 15);
    dv.setUint32(p, b.frame, true); p += 4;
    const v = [b.pos[0], b.pos[1], -b.pos[2], -b.rot[0], -b.rot[1], b.rot[2], b.rot[3]];
    for (const x of v) { dv.setFloat32(p, x, true); p += 4; }
    for (let k = 0; k < 4; k += 1) {
      out[p + k * 16] = 20; out[p + k * 16 + 4] = 20; out[p + k * 16 + 8] = 107; out[p + k * 16 + 12] = 107;
    }
    p += 64;
  }
  dv.setUint32(p, faces.length, true); p += 4;
  for (const f of faces) {
    putStr(f.name, 15);
    dv.setUint32(p, f.frame, true); p += 4;
    dv.setFloat32(p, f.weight, true); p += 4;
  }
  return out;
}

/** Shift_JIS bytes of one character, found by searching the decoder (slow; small use only). */
const sjisCache = new Map();
function encodeSjisChar(ch) {
  if (sjisCache.has(ch)) return sjisCache.get(ch);
  for (let hi = 0x81; hi <= 0xfc; hi += 1) {
    if (hi > 0x9f && hi < 0xe0) continue;
    for (let lo = 0x40; lo <= 0xfc; lo += 1) {
      if (sjis.decode(new Uint8Array([hi, lo])) === ch) {
        sjisCache.set(ch, [hi, lo]);
        return [hi, lo];
      }
    }
  }
  sjisCache.set(ch, [0x3f]);
  return [0x3f];
}
