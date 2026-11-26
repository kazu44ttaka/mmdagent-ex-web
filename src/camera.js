/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDAgent/src/lib/Render.cpp
 *   Library_MMDFiles/src/lib/CameraController.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * The camera of Library_MMDAgent Render.cpp and Library_MMDFiles
 * CameraController.cpp: a look-at point, angles (degrees), distance and fovy,
 * eased toward their targets (0.9 / 0.1 per frame), moved linearly over a
 * given time (CAMERA|...|time), following a model bone, or driven by a VMD
 * camera motion.
 */

import { interpolate } from './vmd.js';
import { quatMul, quatFromAxisAngle, quatInverse, slerp, vlerp, DEG } from './math.js';

const MIN_MOVE_DIFF = 0.000001; // RENDER_MINMOVEDIFF
const MOVE_SPEED_RATE = 0.9;
const MIN_SPIN_DIFF = 0.000001;
const SPIN_SPEED_RATE = 0.9;
const MIN_DISTANCE_DIFF = 0.1;
const DISTANCE_SPEED_RATE = 0.9;
const MIN_FOVY_DIFF = 0.01;
const FOVY_SPEED_RATE = 0.9;

/** Render::updateRotationFromAngle: Rz * Rx * Ry. @param {number[]} angle degrees */
export function rotationFromAngle(angle) {
  return quatMul(
    quatMul(quatFromAxisAngle([0, 0, 1], angle[2] * DEG), quatFromAxisAngle([1, 0, 0], angle[0] * DEG)),
    quatFromAxisAngle([0, 1, 0], angle[1] * DEG),
  );
}

const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sub4 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
const len2 = (v) => v.reduce((s, x) => s + x * x, 0);

/** VMD camera motion player (CameraController). */
export class CameraMotion {
  /** @param {import('./vmd.js').CameraKey[]} keys */
  constructor(keys) {
    this.keys = keys;
    this.lastKey = 0;
    this.currentFrame = 0;
    this.previousFrame = 0;
    this.distance = 0;
    this.pos = [0, 0, 0];
    this.angle = [0, 0, 0];
    this.fovy = 30;
  }

  control(frameNow) {
    const keys = this.keys;
    const lastFrame = keys[keys.length - 1].frame;
    const frame = Math.min(frameNow, lastFrame);
    let k2 = 0;
    if (frame >= keys[this.lastKey].frame) {
      for (let i = this.lastKey; i < keys.length; i += 1) if (frame <= keys[i].frame) { k2 = i; break; }
    } else {
      for (let i = 0; i <= this.lastKey && i < keys.length; i += 1) if (frame <= keys[i].frame) { k2 = i; break; }
    }
    if (k2 >= keys.length) k2 = keys.length - 1;
    const k1 = k2 <= 1 ? 0 : k2 - 1;
    this.lastKey = k1;
    const a = keys[k1];
    const b = keys[k2];
    const set = (k) => {
      this.distance = k.distance; this.pos = k.pos.slice(); this.angle = k.angle.slice(); this.fovy = k.fovy;
    };
    if (a.frame === b.frame) {
      set(a);
      return;
    }
    let lerp = false;
    if (frame <= a.frame) set(a);
    else if (frame >= b.frame) set(b);
    else if (b.frame - a.frame <= 1) {
      // a cut between successive frames: jump unless the change is small (rot2 reuses angle1.z as in the original)
      const rot1 = rotationFromAngle(a.angle);
      const rot2 = rotationFromAngle([b.angle[0], b.angle[1], a.angle[2]]);
      const diff = quatMul(rot2, quatInverse(rot1));
      const angleDiff = 2 * Math.acos(Math.min(1, Math.max(-1, diff[3])));
      const d2 = (a.pos[0] - b.pos[0]) ** 2 + (a.pos[1] - b.pos[1]) ** 2 + (a.pos[2] - b.pos[2]) ** 2;
      if (d2 > 3 || angleDiff > 0.08 || Math.abs(a.distance - b.distance) > 3 || Math.abs(a.fovy - b.fovy) > 2) set(a);
      else lerp = true;
    } else lerp = true;
    if (!lerp) return;
    const w = (frame - a.frame) / (b.frame - a.frame);
    const t = b.tables;
    const r = (i) => interpolate(t[i], w);
    this.pos = [a.pos[0] + (b.pos[0] - a.pos[0]) * r(0), a.pos[1] + (b.pos[1] - a.pos[1]) * r(1), a.pos[2] + (b.pos[2] - a.pos[2]) * r(2)];
    const ra = r(3);
    this.angle = a.angle.map((v, i) => v + (b.angle[i] - v) * ra);
    this.distance = a.distance + (b.distance - a.distance) * r(4);
    this.fovy = a.fovy + (b.fovy - a.fovy) * r(5);
  }

  /** @param {number} deltaFrame @returns {boolean} reached the end */
  advance(deltaFrame) {
    if (!this.keys.length) return false;
    this.control(this.currentFrame);
    this.previousFrame = this.currentFrame;
    this.currentFrame += deltaFrame;
    const last = this.keys[this.keys.length - 1].frame;
    if (this.currentFrame >= last) {
      this.currentFrame = last;
      return true;
    }
    return false;
  }
}

export class CameraState {
  constructor() {
    this.angleSet = [0, 0, 0];
    this.transSet = [0, 13, 0];
    this.distanceSet = 100;
    this.fovySet = 16;
    this.angle = [0, 0, 0];
    this.trans = [0, 13, 0];
    this.distance = 100;
    this.fovy = 16;
    this.rot = rotationFromAngle(this.angle);
    this.currentRot = this.rot.slice();
    this.currentTrans = this.trans.slice();
    this.currentDistance = this.distance;
    this.currentFovy = this.fovy;
    this.viewMoveTime = -1;
    this.moveElapsed = 0;
    this.startRot = this.currentRot.slice();
    this.startTrans = this.currentTrans.slice();
    this.startDistance = this.currentDistance;
    this.startFovy = this.currentFovy;
    /** @type {{ getWorldMatrix: () => number[] } | null} 4x4 column-major of the followed bone */
    this.baseBone = null;
    this.baseBoneSet = null;
    this.modelFollow = false;
    this.lastFollowPos = [0, 0, 0];
    /** @type {CameraMotion | null} */
    this.motion = null;
    this.controlledByMotion = false;
  }

  /** Render::setCameraView @param {number[]} trans @param {number[]} angle @param {number} distance @param {number} fovy */
  setView(trans, angle, distance, fovy, baseBone = null, modelFollow = false) {
    this.angleSet = angle.slice();
    this.transSet = trans.slice();
    this.distanceSet = distance;
    this.fovySet = fovy;
    this.baseBoneSet = baseBone;
    this.modelFollow = modelFollow;
    this.lastFollowPos = [0, 0, 0];
    this.reset();
  }

  /** Render::resetCamera */
  reset() {
    this.angle = this.angleSet.slice();
    this.trans = this.transSet.slice();
    this.distance = this.distanceSet;
    this.fovy = this.fovySet;
    this.baseBone = this.baseBoneSet;
    this.rot = rotationFromAngle(this.angle);
  }

  /** Render::setViewMoveTimer; seconds, or < 0 for the 0.9 / 0.1 easing. */
  setMoveTime(sec) {
    this.viewMoveTime = sec;
    this.moveElapsed = 0;
    if (sec > 0) {
      this.startRot = this.currentRot.slice();
      this.startTrans = this.currentTrans.slice();
      this.startDistance = this.currentDistance;
      this.startFovy = this.currentFovy;
    }
  }

  /** Jump to the targets now (first frame of a scene). */
  snap() {
    this.currentRot = this.rot.slice();
    this.currentTrans = this.trans.slice();
    this.currentDistance = this.distance;
    this.currentFovy = this.fovy;
  }

  /** Mouse / key operations change the targets, like MMDAgent-EX's view controls. */
  rotateBy(dx, dy) {
    this.angle = [this.angle[0] + dx, this.angle[1] + dy, this.angle[2]];
    this.rot = rotationFromAngle(this.angle);
  }

  /** @param {number[]} v camera-space offset */
  translateBy(v) {
    const inv = quatInverse(this.rot);
    const q = quatMul(quatMul(inv, [v[0], v[1], v[2], 0]), this.rot);
    this.trans = [this.trans[0] + q[0], this.trans[1] + q[1], this.trans[2] + q[2]];
  }

  setDistance(d) {
    this.distance = d;
  }

  setFovy(f) {
    this.fovy = Math.max(1, Math.min(179, f));
  }

  /** Advance a VMD camera motion by frames (call at each step). */
  stepMotion(frames) {
    if (!this.motion) return false;
    const ended = this.motion.advance(frames) && this.motion.currentFrame === this.motion.previousFrame;
    this.distance = this.motion.distance;
    this.trans = this.motion.pos.slice();
    this.angle = this.motion.angle.slice();
    this.fovy = this.motion.fovy;
    this.rot = rotationFromAngle(this.angle);
    this.controlledByMotion = true;
    if (ended) {
      this.motion = null;
    }
    return ended;
  }

  /** @param {CameraMotion | null} motion */
  setMotion(motion) {
    this.motion = motion;
    this.controlledByMotion = Boolean(motion);
  }

  /** Once per rendered frame: ease the current values toward the targets. @param {number} elapsedSec */
  update(elapsedSec) {
    this.moveElapsed += elapsedSec;
    const immediate = this.viewMoveTime === 0 || this.controlledByMotion;
    const timed = this.viewMoveTime > 0;
    const k = timed ? Math.min(1, this.moveElapsed / this.viewMoveTime) : 0;
    if (!(equal(this.currentRot, this.rot) && equal(this.currentTrans, this.trans))) {
      if (immediate || (timed && k >= 1)) {
        this.currentRot = this.rot.slice();
        this.currentTrans = this.trans.slice();
      } else if (timed) {
        this.currentTrans = vlerp(this.startTrans, this.trans, k);
        this.currentRot = slerp(this.startRot, this.rot, k);
      } else {
        const dt = [this.trans[0] - this.currentTrans[0], this.trans[1] - this.currentTrans[1], this.trans[2] - this.currentTrans[2]];
        this.currentTrans = len2(dt) > MIN_MOVE_DIFF ? vlerp(this.currentTrans, this.trans, 1 - MOVE_SPEED_RATE) : this.trans.slice();
        this.currentRot = len2(sub4(this.rot, this.currentRot)) > MIN_SPIN_DIFF ? slerp(this.currentRot, this.rot, 1 - SPIN_SPEED_RATE) : this.rot.slice();
      }
    }
    if (this.currentDistance !== this.distance) {
      if (immediate || (timed && k >= 1)) this.currentDistance = this.distance;
      else if (timed) this.currentDistance = this.startDistance + (this.distance - this.startDistance) * k;
      else this.currentDistance = Math.abs(this.currentDistance - this.distance) < MIN_DISTANCE_DIFF
        ? this.distance : this.currentDistance * DISTANCE_SPEED_RATE + this.distance * (1 - DISTANCE_SPEED_RATE);
    }
    if (this.currentFovy !== this.fovy) {
      if (immediate || (timed && k >= 1)) this.currentFovy = this.fovy;
      else if (timed) this.currentFovy = this.startFovy + (this.fovy - this.startFovy) * k;
      else this.currentFovy = Math.abs(this.currentFovy - this.fovy) < MIN_FOVY_DIFF
        ? this.fovy : this.currentFovy * FOVY_SPEED_RATE + this.fovy * (1 - FOVY_SPEED_RATE);
    }
  }
}
