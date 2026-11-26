/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDAgent/src/lib/BoneFaceControl.cpp
 *   Library_MMDAgent/src/lib/KeyValue.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 */

/**
 * KeyValue store and MODEL_BINDBONE / MODEL_BINDFACE, as in MMDAgent-EX.
 *
 * Follows Library_MMDAgent/src/lib/BoneFaceControl.cpp: a binding maps a
 * KeyValue number in [min, max] to a bone pose (position lerp, rotation slerp)
 * or a morph weight (lerp), and overrides whatever the motion set that frame.
 * Without a key, MODEL_BINDFACE eases the morph to a fixed weight over a duration.
 *
 * Rotations are given in degrees and built like MMDAgent_str2rot:
 * btQuaternion::setEulerZYX(rz, ry, rx). Quaternions here are [x, y, z, w].
 */

import { quatFromEulerDeg, slerp, parseVec3 } from './math.js';

export { quatFromEulerDeg, slerp, parseVec3 };

/** @typedef {import('./math.js').Vec3} Vec3 */
/** @typedef {import('./math.js').Quat} Quat */

export class KeyValue {
  constructor() {
    /** @type {Map<string, string>} */
    this.map = new Map();
  }
  /** @param {string} key */
  get(key) {
    return this.map.get(key);
  }
  /** @param {string} key @param {string} value */
  set(key, value) {
    this.map.set(key, String(value));
  }
  /** atof(getString(key, "0.0")) @param {string} key */
  number(key) {
    const n = parseFloat(this.map.get(key) ?? '0.0');
    return Number.isFinite(n) ? n : 0;
  }
}

/**
 * @typedef {{
 *   kind: 'bone', alias: string, target: string, key: string | null, min: number, max: number,
 *   pos0: Vec3, pos1: Vec3, rot0: Quat, rot1: Quat,
 * }} BoneBinding
 * @typedef {{
 *   kind: 'face', alias: string, target: string, key: string | null, min: number, max: number,
 *   val0: number, val1: number, durationFrame: number, restFrame: number,
 * }} FaceBinding
 */

/** Frame unit of MMDAgent-EX timings (30 fps). */
const FPS = 30;

export class Bindings {
  /** @param {KeyValue} keyValue */
  constructor(keyValue) {
    this.keyValue = keyValue;
    /** @type {Map<string, BoneBinding>} "alias\u0000bone" → binding */
    this.bones = new Map();
    /** @type {Map<string, FaceBinding>} */
    this.faces = new Map();
  }

  /**
   * MODEL_BINDBONE|key|min|max|alias|bone|x1,y1,z1|rx1,ry1,rz1|x2,y2,z2|rx2,ry2,rz2
   * MODEL_BINDBONE|alias|bone|x,y,z|rx,ry,rz
   * @param {string[]} argv
   * @returns {string | null} the event args, or null on a malformed command
   */
  bindBone(argv) {
    if (argv.length === 4) {
      const pos = parseVec3(argv[2]);
      const rot = parseVec3(argv[3]);
      if (!pos || !rot) return null;
      const q = quatFromEulerDeg(rot);
      this.bones.set(`${argv[0]}\u0000${argv[1]}`, {
        kind: 'bone', alias: argv[0], target: argv[1], key: null, min: 0, max: 0,
        pos0: pos, pos1: pos, rot0: q, rot1: q,
      });
      return `${argv[0]}|${argv[1]}`;
    }
    if (argv.length === 9) {
      const pos0 = parseVec3(argv[5]);
      const rot0 = parseVec3(argv[6]);
      const pos1 = parseVec3(argv[7]);
      const rot1 = parseVec3(argv[8]);
      if (!pos0 || !rot0 || !pos1 || !rot1) return null;
      this.bones.set(`${argv[3]}\u0000${argv[4]}`, {
        kind: 'bone', alias: argv[3], target: argv[4], key: argv[0],
        min: parseFloat(argv[1]) || 0, max: parseFloat(argv[2]) || 0,
        pos0, pos1, rot0: quatFromEulerDeg(rot0), rot1: quatFromEulerDeg(rot1),
      });
      return `${argv[3]}|${argv[4]}`;
    }
    return null;
  }

  /**
   * MODEL_BINDFACE|key|min|max|alias|face|rate1|rate2
   * MODEL_BINDFACE|alias|face|rate[|duration]
   * @param {string[]} argv
   * @param {(alias: string, face: string) => number} [currentWeight] starting weight for eased binds
   * @returns {string | null}
   */
  bindFace(argv, currentWeight) {
    if (argv.length === 3 || argv.length === 4) {
      const durationFrame = argv.length === 4 ? (parseFloat(argv[3]) || 0) * FPS : 0;
      this.faces.set(`${argv[0]}\u0000${argv[1]}`, {
        kind: 'face', alias: argv[0], target: argv[1], key: null, min: 0, max: 0,
        val0: parseFloat(argv[2]) || 0,
        val1: currentWeight ? currentWeight(argv[0], argv[1]) : 0,
        durationFrame, restFrame: durationFrame,
      });
      return `${argv[0]}|${argv[1]}`;
    }
    if (argv.length === 7) {
      this.faces.set(`${argv[3]}\u0000${argv[4]}`, {
        kind: 'face', alias: argv[3], target: argv[4], key: argv[0],
        min: parseFloat(argv[1]) || 0, max: parseFloat(argv[2]) || 0,
        val0: parseFloat(argv[5]) || 0, val1: parseFloat(argv[6]) || 0,
        durationFrame: 0, restFrame: 0,
      });
      return `${argv[0]}|${argv[3]}|${argv[4]}`;
    }
    return null;
  }

  /** @param {string} alias @param {string} bone */
  unbindBone(alias, bone) {
    return this.bones.delete(`${alias}\u0000${bone}`);
  }

  /** @param {string} alias @param {string} face */
  unbindFace(alias, face) {
    return this.faces.delete(`${alias}\u0000${face}`);
  }

  /** Drop every binding of a model (on MODEL_DELETE). @param {string} alias */
  clearModel(alias) {
    for (const [k, b] of this.bones) if (b.alias === alias) this.bones.delete(k);
    for (const [k, b] of this.faces) if (b.alias === alias) this.faces.delete(k);
  }

  /** @param {{ key: string | null, min: number, max: number }} b */
  ratio(b) {
    const value = this.keyValue.number(/** @type {string} */ (b.key));
    if (value > b.max) return 1;
    if (value < b.min) return 0;
    return (value - b.min) / (b.max - b.min);
  }

  /**
   * Current pose of a bone binding.
   * @param {BoneBinding} b
   * @returns {{ pos: Vec3, rot: Quat }}
   */
  bonePose(b) {
    if (b.key === null) return { pos: b.pos0, rot: b.rot0 };
    const f = this.ratio(b);
    return {
      pos: [
        b.pos0[0] + (b.pos1[0] - b.pos0[0]) * f,
        b.pos0[1] + (b.pos1[1] - b.pos0[1]) * f,
        b.pos0[2] + (b.pos1[2] - b.pos0[2]) * f,
      ],
      rot: slerp(b.rot0, b.rot1, f),
    };
  }

  /**
   * Current weight of a face binding; advances eased binds by `elapsedFrame`.
   * @param {FaceBinding} b
   * @param {number} elapsedFrame
   */
  faceWeight(b, elapsedFrame) {
    if (b.key !== null) {
      const f = this.ratio(b);
      return (1 - f) * b.val0 + f * b.val1;
    }
    let v = b.val0;
    if (b.restFrame > 0 && b.durationFrame > 0) {
      const r = b.restFrame / b.durationFrame;
      v = b.val1 * r + b.val0 * (1 - r);
      b.restFrame = Math.max(0, b.restFrame - elapsedFrame);
    }
    return v;
  }
}
