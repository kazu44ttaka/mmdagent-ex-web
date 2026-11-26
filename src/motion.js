/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDFiles/src/lib/MotionManager.cpp
 *   Library_MMDFiles/src/lib/MotionController.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * Motion players, ported from Library_MMDFiles MotionController.cpp and
 * MotionManager.cpp: several VMD motions per model in priority order (later
 * ones override earlier ones), PART motions that skip bones with a single key
 * frame, the "smooth" start / loop / end blending, speed changes
 * (MOTION_ACCELERATE) and per-bone operation modes (MOTION_CONFIGURE).
 *
 * Works on a plain pose (see `Pose`), independent of three.js.
 */

import { interpolate } from './vmd.js';
import { slerp, vlerp, vadd, vsub, vscale, quatMul, quatIdentity } from './math.js';

const BONE_START_MARGIN = 20; // MOTIONCONTROLLER_BONESTARTMARGINFRAME
const FACE_START_MARGIN = 6; // MOTIONCONTROLLER_FACESTARTMARGINFRAME
const BONE_END_MARGIN = 20; // MOTIONCONTROLLER_BONEENDMARGINFRAME
const FACE_END_MARGIN = 6; // MOTIONCONTROLLER_FACEENDMARGINFRAME
export const CENTER_BONE_NAME = 'センター';

const OP_REPLACE = 0;
const OP_ADD = 1;
const OP_MUL = 2;
const OP_NONE = 3;

export const STATUS_RUNNING = 0;
export const STATUS_LOOPED = 1;
export const STATUS_DELETED = 2;

const ACC_CONSTANT = 0;
const ACC_WAITING = 1;
const ACC_CHANGING = 2;
const ACC_ENDED = 3;

/**
 * The pose a motion writes to. Bone `pos` is the offset from the rest
 * position and `rot` the local rotation, both kept between frames.
 * @typedef {{ name: string, pos: number[], rot: number[], independent: boolean }} PoseBone
 * @typedef {{ name: string, weight: number }} PoseFace
 * @typedef {{
 *   bones: PoseBone[], boneIndex: Map<string, number>,
 *   faces: PoseFace[], faceIndex: Map<string, number>,
 *   smearAllBonesToDefault: (rate: number) => void,
 *   setIkEnabled?: (name: string, enable: boolean) => void,
 *   setVisible?: (visible: boolean) => void,
 *   centerRepositionOffset?: () => number[] | null,
 * }} Pose
 */

export class MotionController {
  /**
   * @param {Pose} pose
   * @param {import('./vmd.js').Vmd} vmd
   */
  constructor(pose, vmd) {
    this.setup(pose, vmd);
  }

  /** @param {Pose} pose @param {import('./vmd.js').Vmd} vmd */
  setup(pose, vmd) {
    this.pose = pose;
    this.vmd = vmd;
    this.maxFrame = vmd.maxFrame;
    this.hasCenterBoneMotion = false;
    /** @type {any[]} */
    this.boneCtrl = [];
    for (const [name, keys] of vmd.bones) {
      const index = pose.boneIndex.get(name);
      if (index === undefined) continue;
      this.boneCtrl.push({
        index, name, keys, pos: [0, 0, 0], rot: quatIdentity(), snapPos: [0, 0, 0], snapRot: quatIdentity(),
        lastKey: 0, looped: false, opFlag: OP_REPLACE, opRate: 1,
      });
      if (keys.length > 1 && name === CENTER_BONE_NAME) this.hasCenterBoneMotion = true;
    }
    /** @type {any[]} */
    this.faceCtrl = [];
    for (const [name, keys] of vmd.faces) {
      const index = pose.faceIndex.get(name);
      if (index === undefined) continue;
      this.faceCtrl.push({ index, name, keys, weight: 0, snapWeight: 0, lastKey: 0, looped: false, opFlag: OP_REPLACE, opRate: 1 });
    }
    this.switchLastKey = 0;
    this.boneBlendRate = 1;
    this.faceBlendRate = 1;
    this.ignoreSingleMotion = false;
    this.currentFrame = 0;
    this.previousFrame = 0;
    this.noBoneSmearFrame = 0;
    this.noFaceSmearFrame = 0;
    this.overrideFirst = false;
  }

  reset() {
    for (const c of this.boneCtrl) c.lastKey = 0;
    for (const c of this.faceCtrl) c.lastKey = 0;
    this.switchLastKey = 0;
    this.currentFrame = 0;
    this.previousFrame = 0;
    this.noBoneSmearFrame = 0;
    this.noFaceSmearFrame = 0;
    this.boneBlendRate = 1;
    this.faceBlendRate = 1;
    this.ignoreSingleMotion = false;
    this.overrideFirst = false;
    this.setLoopedFlags(false);
  }

  /** Index pair around `frame`, as calcBoneAt / calcFaceAt find them. */
  static findKeys(keys, c, frame) {
    let k2 = 0;
    if (frame >= keys[c.lastKey].frame) {
      for (let i = c.lastKey; i < keys.length; i += 1) {
        if (frame <= keys[i].frame) {
          k2 = i;
          break;
        }
      }
    } else {
      for (let i = 0; i <= c.lastKey && i < keys.length; i += 1) {
        if (frame <= keys[i].frame) {
          k2 = i;
          break;
        }
      }
    }
    if (k2 >= keys.length) k2 = keys.length - 1;
    const k1 = k2 <= 1 ? 0 : k2 - 1;
    c.lastKey = k1;
    return [k1, k2];
  }

  calcBoneAt(c, frameNow) {
    const keys = c.keys;
    const last = keys[keys.length - 1];
    const frame = Math.min(frameNow, last.frame);
    const [k1, k2] = MotionController.findKeys(keys, c, frame);
    const time1 = keys[k1].frame;
    const time2 = keys[k2].frame;
    let pos1 = keys[k1].pos, rot1 = keys[k1].rot, pos2 = keys[k2].pos, rot2 = keys[k2].rot;
    if (this.overrideFirst && c.looped) {
      if (k1 === 0 || time1 === 0) { pos1 = last.pos; rot1 = last.rot; }
      if (k2 === 0 || time2 === 0) { pos2 = last.pos; rot2 = last.rot; }
    }
    if (time1 !== time2) {
      if (frame <= time1) {
        c.pos = pos1.slice(); c.rot = rot1.slice();
      } else if (frame >= time2) {
        c.pos = pos2.slice(); c.rot = rot2.slice();
      } else {
        const w = (frame - time1) / (time2 - time1);
        const t = keys[k2].tables;
        const ix = interpolate(t[0], w), iy = interpolate(t[1], w), iz = interpolate(t[2], w), ir = interpolate(t[3], w);
        c.pos = [pos1[0] * (1 - ix) + pos2[0] * ix, pos1[1] * (1 - iy) + pos2[1] * iy, pos1[2] * (1 - iz) + pos2[2] * iz];
        c.rot = slerp(rot1, rot2, ir);
      }
    } else {
      c.pos = pos1.slice(); c.rot = rot1.slice();
    }
    if (this.overrideFirst && this.noBoneSmearFrame > 0 && c.opFlag === OP_REPLACE) {
      const w = this.noBoneSmearFrame / BONE_START_MARGIN;
      c.pos = vlerp(c.pos, c.snapPos, w);
      c.rot = slerp(c.rot, c.snapRot, w);
    }
  }

  calcFaceAt(c, frameNow) {
    const keys = c.keys;
    const last = keys[keys.length - 1];
    const frame = Math.min(frameNow, last.frame);
    const [k1, k2] = MotionController.findKeys(keys, c, frame);
    const time1 = keys[k1].frame;
    const time2 = keys[k2].frame;
    let weight1 = keys[k1].weight;
    let weight2 = keys[k2].weight;
    if (this.overrideFirst && c.looped) {
      if (k1 === 0 || time1 === 0) weight1 = last.weight;
      if (k2 === 0 || time2 === 0) weight2 = last.weight;
    }
    if (time1 !== time2) {
      const w = (frame - time1) / (time2 - time1);
      if (time2 - time1 <= 1 && ((weight1 === 0 && weight2 === 1) || (weight1 === 1 && weight2 === 0))) {
        c.weight = w <= 0.5 ? weight1 : weight2;
      } else {
        c.weight = weight1 * (1 - w) + weight2 * w;
      }
    } else {
      c.weight = weight1;
    }
    if (this.overrideFirst && this.noFaceSmearFrame > 0) {
      let smearFrame = FACE_START_MARGIN;
      if (keys.length > 1) smearFrame = Math.min(keys[1].frame, FACE_START_MARGIN);
      if (smearFrame > 1) {
        const cur = FACE_START_MARGIN - this.noFaceSmearFrame;
        if (cur < smearFrame) {
          const w = cur / smearFrame;
          c.weight = c.weight * w + c.snapWeight * (1 - w);
        }
      }
    }
  }

  /** Model switches (show / hide, IK on / off) in the VMD. */
  calcSwitchAt(frameNow) {
    const keys = this.vmd.switches;
    if (!keys.length || (!this.pose.setIkEnabled && !this.pose.setVisible)) return;
    const frame = Math.min(frameNow, keys[keys.length - 1].frame);
    const c = { lastKey: this.switchLastKey };
    const [k1, k2] = MotionController.findKeys(keys, c, frame);
    this.switchLastKey = c.lastKey;
    const current = keys[k1].frame !== keys[k2].frame && keys[k2].frame === frame ? keys[k2] : keys[k1];
    this.pose.setVisible?.(current.display);
    for (const ik of current.ik) this.pose.setIkEnabled?.(ik.name, ik.enable);
  }

  control(frameNow) {
    const pose = this.pose;
    for (const c of this.boneCtrl) {
      const bone = pose.bones[c.index];
      if (this.ignoreSingleMotion && c.keys.length <= 1) {
        if (this.overrideFirst && this.noBoneSmearFrame > 0) {
          const w = this.noBoneSmearFrame / BONE_START_MARGIN;
          bone.pos = vlerp(bone.pos, c.snapPos, w);
          bone.rot = slerp(bone.rot, c.snapRot, w);
        }
        continue;
      }
      this.calcBoneAt(c, frameNow);
      if (c.opRate !== 1) {
        c.pos = vscale(c.pos, c.opRate);
        c.rot = slerp(quatIdentity(), c.rot, c.opRate);
      }
      switch (c.opFlag) {
        case OP_REPLACE:
          if (this.boneBlendRate === 1) {
            bone.pos = c.pos.slice();
            bone.rot = c.rot.slice();
          } else {
            bone.pos = vlerp(bone.pos, c.pos, this.boneBlendRate);
            bone.rot = slerp(bone.rot, c.rot, this.boneBlendRate);
          }
          break;
        case OP_ADD:
          if (this.boneBlendRate === 1) {
            bone.pos = vadd(bone.pos, c.pos);
            bone.rot = quatMul(c.rot, bone.rot);
          } else {
            bone.pos = vadd(bone.pos, vscale(c.pos, this.boneBlendRate));
            bone.rot = quatMul(slerp(quatIdentity(), c.rot, this.boneBlendRate), bone.rot);
          }
          break;
        default:
      }
    }
    for (const c of this.faceCtrl) {
      if (this.ignoreSingleMotion && c.keys.length <= 1) continue;
      this.calcFaceAt(c, frameNow);
      if (c.opRate !== 1) c.weight *= c.opRate;
      const face = pose.faces[c.index];
      switch (c.opFlag) {
        case OP_REPLACE:
          face.weight = this.faceBlendRate === 1 ? c.weight : face.weight * (1 - this.faceBlendRate) + c.weight * this.faceBlendRate;
          break;
        case OP_ADD:
          face.weight += c.weight * this.faceBlendRate;
          break;
        case OP_MUL:
          face.weight += (1 - face.weight) * c.weight * this.faceBlendRate;
          break;
        default:
      }
    }
    this.calcSwitchAt(frameNow);
  }

  /** @param {number[] | null} centerPos */
  takeSnap(centerPos) {
    const pose = this.pose;
    for (const c of this.boneCtrl) {
      const bone = pose.bones[c.index];
      c.snapPos = bone.pos.slice();
      if (centerPos && bone.independent) c.snapPos = vsub(c.snapPos, centerPos);
      c.snapRot = bone.rot.slice();
    }
    for (const c of this.faceCtrl) c.snapWeight = pose.faces[c.index].weight;
  }

  setLoopedFlags(flag) {
    for (const c of this.boneCtrl) c.looped = flag;
    for (const c of this.faceCtrl) c.looped = flag;
  }

  /** Apply the pose at the current frame, then advance. Returns true at the end. */
  advance(deltaFrame) {
    if (!this.boneCtrl.length && !this.faceCtrl.length && !this.vmd.switches.length) return false;
    this.control(this.currentFrame);
    if (this.noBoneSmearFrame > 0) this.noBoneSmearFrame = Math.max(0, this.noBoneSmearFrame - deltaFrame);
    if (this.noFaceSmearFrame > 0) this.noFaceSmearFrame = Math.max(0, this.noFaceSmearFrame - deltaFrame);
    this.previousFrame = this.currentFrame;
    this.currentFrame += deltaFrame;
    if (this.currentFrame >= this.maxFrame) {
      this.currentFrame = this.maxFrame;
      return true;
    }
    return false;
  }

  rewind(targetFrame, frame) {
    this.currentFrame = this.previousFrame + frame - this.maxFrame + targetFrame;
    this.previousFrame = targetFrame;
    if (this.overrideFirst) this.setLoopedFlags(true);
  }

  setOpRate(rate) {
    for (const c of this.boneCtrl) c.opRate = rate;
    for (const c of this.faceCtrl) c.opRate = rate;
  }

  /**
   * MOTION_CONFIGURE keys.
   * @param {string} key
   * @param {string | null} value
   */
  configure(key, value) {
    const v = value ?? '';
    if (key === 'BLEND_RATE') {
      if (!v) return false;
      this.setOpRate(parseFloat(v) || 0);
      return true;
    }
    if (key === 'MODE_REPLACE' || key === 'MODE_ADD' || key === 'MODE_MUL') {
      if (v) this.setOpRate(parseFloat(v) || 0);
      const boneFlag = key === 'MODE_ADD' ? OP_ADD : OP_REPLACE;
      const faceFlag = key === 'MODE_ADD' ? OP_ADD : key === 'MODE_MUL' ? OP_MUL : OP_REPLACE;
      for (const c of this.boneCtrl) c.opFlag = boneFlag;
      for (const c of this.faceCtrl) c.opFlag = faceFlag;
      return true;
    }
    if (!v) return false;
    const table = {
      MODE_BONE_REPLACE: [0, OP_REPLACE], MODE_BONE_ADD: [0, OP_ADD], MODE_BONE_NONE: [0, OP_NONE],
      MODE_FACE_REPLACE: [1, OP_REPLACE], MODE_FACE_ADD: [1, OP_ADD], MODE_FACE_MUL: [1, OP_MUL], MODE_FACE_NONE: [1, OP_NONE],
    };
    const entry = table[key];
    if (!entry) return false;
    const list = entry[0] === 0 ? this.boneCtrl : this.faceCtrl;
    let found = false;
    for (const name of v.split(',')) {
      for (const c of list) {
        if (c.name === name) {
          c.opFlag = entry[1];
          found = true;
        }
      }
    }
    return found;
  }

  /** Snapshot the current pose to blend from at the start of the motion. */
  setOverrideFirst(centerPos) {
    this.takeSnap(centerPos);
    this.setLoopedFlags(false);
    this.overrideFirst = true;
    this.noBoneSmearFrame = BONE_START_MARGIN;
    this.noFaceSmearFrame = FACE_START_MARGIN;
  }
}

/**
 * @typedef {{
 *   name: string, mc: MotionController, vmd: import('./vmd.js').Vmd,
 *   onEnd: number, priority: number, ignoreStatic: boolean, loopAt: number,
 *   enableSmooth: boolean, enableRePos: boolean, motionBlendRate: number,
 *   active: boolean, endingBoneBlend: number, endingFaceBlend: number, statusFlag: number,
 *   targetSpeedRate: number, currentSpeedRate: number,
 *   remainingFramesForStartOfAcceleration: number, remainingFramesForEndOfAcceleration: number,
 *   accelerationStatusFlag: number, wantDeleteFlag: boolean,
 * }} MotionPlayer
 */

export class MotionManager {
  /** @param {Pose} pose */
  constructor(pose) {
    this.pose = pose;
    /** @type {MotionPlayer[]} in priority order */
    this.players = [];
    this.beginningNonControlledBlend = 0;
  }

  terminateEndingMotion(name) {
    for (const m of this.players) {
      if (m.active && (m.endingBoneBlend !== 0 || m.endingFaceBlend !== 0) && m.name === name) m.active = false;
    }
  }

  purgeMotion() {
    this.players = this.players.filter((m) => m.active);
  }

  /** @param {import('./vmd.js').Vmd} vmd @param {MotionPlayer} m */
  startMotionSub(vmd, m) {
    m.mc = new MotionController(this.pose, vmd);
    m.mc.reset();
    m.mc.ignoreSingleMotion = m.ignoreStatic;
    m.vmd = vmd;
    m.active = true;
    m.endingBoneBlend = 0;
    m.endingFaceBlend = 0;
    m.accelerationStatusFlag = ACC_CONSTANT;
    m.wantDeleteFlag = false;
    if (m.enableSmooth) {
      if (m.mc.hasCenterBoneMotion && m.enableRePos && this.pose.centerRepositionOffset) {
        const offset = this.pose.centerRepositionOffset();
        m.mc.setOverrideFirst(offset);
      } else {
        m.mc.setOverrideFirst(null);
      }
    }
  }

  /**
   * @param {import('./vmd.js').Vmd} vmd
   * @param {string} name
   * @param {boolean} full
   * @param {boolean} once
   * @param {boolean} enableSmooth
   * @param {boolean} enableRePos
   * @param {number} priority
   */
  startMotion(vmd, name, full, once, enableSmooth, enableRePos, priority) {
    this.terminateEndingMotion(name);
    this.purgeMotion();
    /** @type {MotionPlayer} */
    const m = {
      name, mc: /** @type {any} */ (null), vmd, onEnd: once ? 2 : 1, priority, ignoreStatic: !full, loopAt: 0,
      enableSmooth, enableRePos, motionBlendRate: 1, active: true, endingBoneBlend: 0, endingFaceBlend: 0,
      statusFlag: STATUS_RUNNING, targetSpeedRate: 1, currentSpeedRate: 1,
      remainingFramesForStartOfAcceleration: -1, remainingFramesForEndOfAcceleration: -1,
      accelerationStatusFlag: ACC_CONSTANT, wantDeleteFlag: false,
    };
    this.startMotionSub(vmd, m);
    if (!m.ignoreStatic) this.beginningNonControlledBlend = 10;
    // insert after the first one with a priority <= this (the base motion is skipped)
    if (!this.players.length || this.players[0].priority > m.priority) {
      this.players.unshift(m);
    } else {
      let i = 1;
      while (i < this.players.length && !(this.players[i].priority > m.priority)) i += 1;
      this.players.splice(i, 0, m);
    }
    return m;
  }

  /** Replace the VMD of a running motion, keeping its settings. */
  swapMotion(vmd, name) {
    this.purgeMotion();
    const m = this.players.find((p) => p.name === name);
    if (!m) return false;
    this.startMotionSub(vmd, m);
    if (!m.ignoreStatic) this.beginningNonControlledBlend = 10;
    return true;
  }

  setMotionSpeedRate(name, speedRate, changeLength, targetFrameIndex) {
    if (speedRate < 0 || changeLength < 0) return false;
    const m = this.players.find((p) => p.active && p.name === name);
    if (!m) return false;
    m.targetSpeedRate = speedRate;
    if (targetFrameIndex < 0) {
      m.remainingFramesForStartOfAcceleration = 0;
      m.remainingFramesForEndOfAcceleration = changeLength;
    } else {
      m.remainingFramesForStartOfAcceleration = targetFrameIndex - m.mc.currentFrame;
      if (m.remainingFramesForStartOfAcceleration < 0) m.remainingFramesForStartOfAcceleration += m.vmd.maxFrame;
      m.remainingFramesForEndOfAcceleration = m.remainingFramesForStartOfAcceleration + changeLength;
    }
    m.accelerationStatusFlag = ACC_WAITING;
    return true;
  }

  deleteMotion(name) {
    const m = this.players.find((p) => p.active && p.name === name);
    if (!m) return false;
    m.wantDeleteFlag = true;
    return true;
  }

  configureMotion(name, key, value) {
    const m = this.players.find((p) => p.active && p.name === name);
    return m ? m.mc.configure(key, value) : false;
  }

  /** Apply every player; returns true if any status changed. @param {number} frame */
  update(frame) {
    if (this.beginningNonControlledBlend > 0) {
      this.beginningNonControlledBlend = Math.max(0, this.beginningNonControlledBlend - frame);
      this.pose.smearAllBonesToDefault(this.beginningNonControlledBlend / 10);
    }
    for (const m of this.players) m.statusFlag = STATUS_RUNNING;
    for (const m of this.players) {
      if (!m.active) continue;
      if (m.endingBoneBlend !== 0 || m.endingFaceBlend !== 0) {
        if (m.wantDeleteFlag) {
          m.statusFlag = STATUS_DELETED;
          m.wantDeleteFlag = false;
        }
        m.mc.boneBlendRate = (m.motionBlendRate * m.endingBoneBlend) / BONE_END_MARGIN;
        m.mc.faceBlendRate = m.endingFaceBlend / FACE_END_MARGIN;
        m.mc.advance(frame * m.currentSpeedRate);
        m.endingBoneBlend = Math.max(0, m.endingBoneBlend - frame);
        m.endingFaceBlend = Math.max(0, m.endingFaceBlend - frame);
        if (m.endingBoneBlend === 0 && m.endingFaceBlend === 0) m.active = false;
      } else {
        m.mc.boneBlendRate = m.motionBlendRate;
        m.mc.faceBlendRate = 1;
        if (m.mc.advance(frame * m.currentSpeedRate)) {
          if (m.onEnd === 1) {
            if (m.mc.maxFrame !== 0) {
              m.mc.rewind(m.loopAt, frame * m.currentSpeedRate);
              m.statusFlag = STATUS_LOOPED;
            }
          } else if (m.onEnd === 2) {
            if (m.enableSmooth) {
              m.endingBoneBlend = BONE_END_MARGIN;
              m.endingFaceBlend = FACE_END_MARGIN;
            } else {
              m.active = false;
            }
            m.statusFlag = STATUS_DELETED;
          }
        }
        if (m.wantDeleteFlag) {
          if (m.enableSmooth) {
            m.endingBoneBlend = BONE_END_MARGIN;
            m.endingFaceBlend = FACE_END_MARGIN;
          } else {
            m.active = false;
          }
          m.statusFlag = STATUS_DELETED;
          m.wantDeleteFlag = false;
        }
      }
    }
    return this.players.some((m) => m.statusFlag !== STATUS_RUNNING);
  }

  /** Returns true if some acceleration just ended. @param {number} frame */
  updateMotionSpeedRate(frame) {
    for (const m of this.players) {
      if (!m.active || m.accelerationStatusFlag === ACC_CONSTANT) continue;
      if (m.accelerationStatusFlag === ACC_ENDED) {
        m.accelerationStatusFlag = ACC_CONSTANT;
        continue;
      }
      const f = frame * m.currentSpeedRate;
      if (m.accelerationStatusFlag === ACC_WAITING) {
        m.remainingFramesForStartOfAcceleration -= f;
        if (m.remainingFramesForStartOfAcceleration <= 0) m.accelerationStatusFlag = ACC_CHANGING;
      }
      m.remainingFramesForEndOfAcceleration -= f;
      if (m.accelerationStatusFlag === ACC_CHANGING) {
        if (m.remainingFramesForEndOfAcceleration <= 0) {
          m.currentSpeedRate = m.targetSpeedRate;
          m.accelerationStatusFlag = ACC_ENDED;
        } else {
          m.currentSpeedRate += (m.targetSpeedRate - m.currentSpeedRate) * (frame / (m.remainingFramesForEndOfAcceleration + frame));
        }
      }
    }
    return this.players.some((m) => m.active && m.accelerationStatusFlag === ACC_ENDED);
  }

  /** The running (not ending) player of that name. @param {string} name */
  getRunning(name) {
    return this.players.find((m) => m.active && m.endingBoneBlend === 0 && m.endingFaceBlend === 0 && m.name === name) || null;
  }

  /** Names of motions that just ended (status DELETED) and accelerations that ended. */
  justDeleted() {
    return this.players.filter((m) => m.statusFlag === STATUS_DELETED).map((m) => m.name);
  }

  justAccelerated() {
    return this.players.filter((m) => m.accelerationStatusFlag === ACC_ENDED).map((m) => m.name);
  }

  /** Whether the next physics step should be skipped (a non-smooth motion looped or ended). */
  needsPhysicsSkip() {
    return this.players.some((m) => (m.statusFlag === STATUS_DELETED || m.statusFlag === STATUS_LOOPED) && !m.enableSmooth);
  }
}
