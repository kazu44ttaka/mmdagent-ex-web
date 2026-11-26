/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDAgent/src/lib/LipSync.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * LIPSYNC_START: a face motion made from a phoneme sequence, as
 * Library_MMDAgent LipSync.cpp builds it from lip.txt (expressions, and a
 * blend rate of each expression per phoneme).
 */

const INTERPOLATION_MARGIN = 2; // LIPSYNC_INTERPOLATIONMARGIN
const INTERPOLATION_RATE = 0.8; // LIPSYNC_INTERPOLATIONRATE

/**
 * Tokens as MMDAgent_fgettoken reads them: whitespace separated, "#" comments.
 * @param {string} text
 */
function tokens(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const body = line.startsWith('#') ? '' : line;
    for (const t of body.split(/\s+/)) if (t) out.push(t);
  }
  return out;
}

/**
 * @param {string} text contents of lip.txt (or <model>.lip)
 * @returns {{ motions: string[], phones: string[], rates: number[][] } | null}
 */
export function parseLipConfig(text) {
  const t = tokens(text);
  let p = 0;
  const numMotion = parseInt(t[p++], 10);
  if (!(numMotion > 0)) return null;
  const motions = t.slice(p, p + numMotion);
  p += numMotion;
  const numPhone = parseInt(t[p++], 10);
  if (!(numPhone > 0) || motions.length < numMotion) return null;
  const phones = [];
  const rates = [];
  for (let i = 0; i < numPhone; i += 1) {
    const name = t[p++];
    const r = [];
    for (let j = 0; j < numMotion; j += 1) {
      const v = parseFloat(t[p++]);
      if (!(v >= 0)) return null;
      r.push(v);
    }
    if (name === undefined) return null;
    phones.push(name);
    rates.push(r);
  }
  return { motions, phones, rates };
}

/**
 * LipSync::createMotion → a VMD-like object with face key frames only.
 * @param {{ motions: string[], phones: string[], rates: number[][] }} conf
 * @param {string} seq "phone,ms,phone,ms,..."
 * @param {string | null} ignoreList NOLIP morphs, held at 0
 * @returns {import('./vmd.js').Vmd | null}
 */
export function createLipSyncMotion(conf, seq, ignoreList) {
  if (!conf || !seq) return null;
  /** @type {Array<{ phone: number, duration: number, rate: number }>} */
  const keys = [];
  let diff = 0;
  let k = 0;
  seq.split(',').filter((s) => s !== '').forEach((p, i) => {
    if (i % 2 === 0) {
      const j = conf.phones.indexOf(p);
      k = j < 0 ? 0 : j;
    } else {
      const f = 0.03 * (parseFloat(p) || 0) + diff; // ms → frames
      let duration = Math.floor(f + 0.5);
      if (duration < 1) duration = 1;
      diff = f - duration;
      keys.push({ phone: k, duration, rate: 1 });
    }
  });
  if (keys.length) keys[keys.length - 1].duration += 6;
  keys.push({ phone: 0, duration: 1, rate: 0 });
  for (let i = 0; i < keys.length; i += 1) {
    const cur = keys[i];
    if (i + 1 < keys.length && cur.duration > INTERPOLATION_MARGIN) {
      keys.splice(i + 1, 0, { phone: cur.phone, duration: INTERPOLATION_MARGIN, rate: cur.rate * INTERPOLATION_RATE });
      cur.duration -= INTERPOLATION_MARGIN;
      i += 1;
    }
  }
  /** @type {import('./vmd.js').Vmd} */
  const vmd = { modelName: '', maxFrame: 0, bones: new Map(), faces: new Map(), camera: [], cameraMaxFrame: 0, switches: [] };
  conf.motions.forEach((name, m) => {
    let frame = 0;
    const list = [];
    for (const key of keys) {
      list.push({ frame, weight: conf.rates[key.phone][m] * key.rate });
      if (vmd.maxFrame < frame) vmd.maxFrame = frame;
      frame += key.duration;
    }
    vmd.faces.set(name, list);
  });
  if (ignoreList) {
    for (const name of ignoreList.split(',')) if (name) vmd.faces.set(name, [{ frame: 0, weight: 0 }]);
  }
  return vmd;
}
