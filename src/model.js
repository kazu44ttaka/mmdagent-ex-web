/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDAgent/src/lib/PMDObject.cpp
 *   Library_MMDFiles/src/lib/PMDModel_update.cpp
 *   Library_MMDFiles/src/lib/PMDBone.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * One model on stage, as Library_MMDAgent PMDObject + Library_MMDFiles PMDModel
 * drive it: a persistent pose written by motions (motion.js), bones updated in
 * the PMD order (pose → IK → under-rotate bones → bindings), placement that
 * eases toward MOVE / TURN / ROTATE targets, fade in / out, and Bullet physics
 * through three.js MMDPhysics (one world shared by every model).
 */

import * as THREE from 'three';
import { MMDPhysics } from 'three/addons/animation/MMDPhysics.js';
import { CCDIKSolver } from 'three/addons/animation/CCDIKSolver.js';
import { MotionManager, CENTER_BONE_NAME } from './motion.js';
import { slerp, quatIdentity, vlerp, vlength, vsub, quatDot } from './math.js';

const ALPHA_FRAMES = 15; // PMDOBJECT_ALPHAFRAME
const MIN_MOVE_DIFF = 0.0001; // PMDOBJECT_MINMOVEDIFF
const MOVE_SPEED_RATE = 0.9; // PMDOBJECT_MOVESPEEDRATE
const MIN_SPIN_DIFF = 0.000001; // PMDOBJECT_MINSPINDIFF
const SPIN_SPEED_RATE = 0.95; // PMDOBJECT_SPINSPEEDRATE
const ADDITIONAL_ROOT_NAMES = ['全ての親', '両足オフセ', '右足オフセ', '左足オフセ']; // PMDBONE_ADDITIONALROOTNAME

// PMD bone types (PMDFile.h)
const UNDER_IK = 4;
const UNDER_ROTATE = 5;
const IK_TARGET = 6;
const FOLLOW_ROTATE = 9;
const FOLLOW_MOVE = 10;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();

export class Model {
  /**
   * @param {{
   *   alias: string, path: string, mesh: THREE.SkinnedMesh, data: any,
   *   position: number[], rotation: number[], cartoon: boolean,
   *   base?: { model: Model, bone: THREE.Bone } | null,
   * }} opts
   */
  constructor(opts) {
    this.alias = opts.alias;
    this.path = opts.path;
    this.mesh = opts.mesh;
    this.data = opts.data;
    this.format = opts.data?.metadata?.format || 'pmd';
    this.base = opts.base || null;
    /** @type {import('./shapemap.js').ParsedShapeMap | null} */
    this.shapeMap = null;
    this.deleteMessages = /** @type {Array<[string, string]>} */ ([]);

    const bones = this.mesh.skeleton.bones;
    const raw = this.data?.bones || [];
    /** @type {import('./motion.js').Pose} */
    this.pose = {
      bones: bones.map((bone, i) => {
        const parent = raw[i]?.parentIndex ?? -1;
        const parentName = parent >= 0 ? raw[parent]?.name : null;
        return {
          name: bone.name, pos: [0, 0, 0], rot: quatIdentity(),
          independent: parent < 0 || ADDITIONAL_ROOT_NAMES.includes(parentName),
        };
      }),
      boneIndex: new Map(bones.map((b, i) => [b.name, i])),
      faces: Object.entries(this.mesh.morphTargetDictionary || {})
        .sort((a, b) => a[1] - b[1])
        .map(([name, index]) => ({ name, weight: 0, index })),
      faceIndex: new Map(),
      smearAllBonesToDefault: (rate) => this.smearAllBonesToDefault(rate),
      setIkEnabled: (name, enable) => this.ikEnabled.set(name, enable),
      setVisible: (visible) => { this.mesh.visible = visible; },
      centerRepositionOffset: () => this.centerRepositionOffset(),
    };
    this.pose.faces.forEach((f, i) => this.pose.faceIndex.set(f.name, i));

    this.restPositions = bones.map((b) => b.position.clone());
    /** PMD bone type, target / child index. */
    this.boneTypes = raw.map((b) => (this.format === 'pmd' ? b.type : -1));
    this.boneTargets = raw.map((b) => (this.format === 'pmd' ? b.ikIndex : -1));
    this.boneChildren = raw.map((b) => (this.format === 'pmd' ? b.tailIndex : -1));
    this.centerBone = this.pose.boneIndex.get(CENTER_BONE_NAME) ?? 0;

    const mmd = this.mesh.geometry.userData.MMD;
    this.iks = mmd?.iks || [];
    this.grants = mmd?.grants || [];
    this.ikSolver = new CCDIKSolver(this.mesh, this.iks);
    /** @type {Map<string, boolean>} IK switches from VMD, by IK bone name */
    this.ikEnabled = new Map();

    this.motions = new MotionManager(this.pose);

    // placement: the root eases toward offsetPos / offsetRot
    this.offsetPos = opts.position.slice();
    this.offsetRot = opts.rotation.slice();
    this.rootPos = opts.position.slice();
    this.rootRot = opts.rotation.slice();
    this.moveSpeed = -1;
    this.spinSpeed = -1;
    this.isMoving = false;
    this.isRotating = false;
    this.isTurning = false;

    this.alpha = 0;
    this.appearFrame = ALPHA_FRAMES;
    this.disappearFrame = 0;
    this.deleting = false;

    /** @type {MMDPhysics | null} */
    this.physics = null;
    this.simulatedBones = new Set();
    this.needResetKinematic = false;
    this.savedAncestorWorld = new Map();

    this.materials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
    this.baseOpacity = this.materials.map((m) => m.opacity);
    this.setCartoon(opts.cartoon);
    this.mesh.matrixAutoUpdate = false;
    this.updateRootBone();
  }

  // ------------------------------------------------------------- pose

  smearAllBonesToDefault(rate) {
    for (const b of this.pose.bones) {
      b.pos = vlerp([0, 0, 0], b.pos, rate);
      b.rot = slerp(quatIdentity(), b.rot, rate);
    }
    for (const f of this.pose.faces) f.weight *= rate;
  }

  /** PMDModel::resetBone: IK-driven bones start from zero every frame. */
  resetBone() {
    for (let i = 0; i < this.pose.bones.length; i += 1) {
      const t = this.boneTypes[i];
      if (t === UNDER_IK || t === IK_TARGET) {
        this.pose.bones[i].pos = [0, 0, 0];
        this.pose.bones[i].rot = quatIdentity();
      }
    }
  }

  /** Write the pose to the three.js bones (PMDBone::update for each type). */
  writeBones() {
    const bones = this.mesh.skeleton.bones;
    const pose = this.pose.bones;
    for (let i = 0; i < bones.length; i += 1) {
      const b = pose[i];
      const rest = this.restPositions[i];
      const bone = bones[i];
      let px = b.pos[0], py = b.pos[1], pz = b.pos[2];
      const type = this.boneTypes[i];
      if (type === FOLLOW_MOVE) {
        const child = pose[this.boneChildren[i]];
        const coef = this.boneTargets[i] * 0.01;
        if (child && coef !== 0) {
          px += child.pos[0] * coef; py += child.pos[1] * coef; pz += child.pos[2] * coef;
        }
      }
      bone.position.set(rest.x + px, rest.y + py, rest.z + pz);
      if (type === UNDER_ROTATE && pose[this.boneTargets[i]]) {
        const t = pose[this.boneTargets[i]].rot;
        bone.quaternion.set(t[0], t[1], t[2], t[3]);
      } else if (type === FOLLOW_ROTATE && pose[this.boneChildren[i]]) {
        const coef = this.boneTargets[i] * 0.01;
        const c = pose[this.boneChildren[i]].rot;
        const r = coef >= 0 ? slerp(quatIdentity(), c, coef) : slerp(quatIdentity(), [-c[0], -c[1], -c[2], c[3]], -coef);
        bone.quaternion.set(b.rot[0], b.rot[1], b.rot[2], b.rot[3]).multiply(_q.set(r[0], r[1], r[2], r[3]));
      } else {
        bone.quaternion.set(b.rot[0], b.rot[1], b.rot[2], b.rot[3]);
      }
    }
  }

  /** PMDModel::updateBone(false): IK chains, then under-rotate bones and PMX grants. */
  solveBones(physicsOn) {
    this.mesh.updateMatrixWorld(true);
    const bones = this.mesh.skeleton.bones;
    for (const ik of this.iks) {
      const name = bones[ik.target]?.name;
      if (name && this.ikEnabled.get(name) === false) continue;
      // with simulation on, IK chains whose links are simulated are skipped
      if (physicsOn && ik.links.some((l) => this.simulatedBones.has(bones[l.index]))) continue;
      this.ikSolver.updateOne(ik);
    }
    // IK wrote the link rotations; keep them in the pose like PMDBone::m_rot
    for (const ik of this.iks) {
      for (const l of ik.links) {
        const q = bones[l.index].quaternion;
        this.pose.bones[l.index].rot = [q.x, q.y, q.z, q.w];
      }
    }
    for (let i = 0; i < bones.length; i += 1) {
      if (this.boneTypes[i] !== UNDER_ROTATE) continue;
      const t = bones[this.boneTargets[i]];
      if (t) bones[i].quaternion.copy(t.quaternion);
    }
    for (const g of this.grants) {
      if (!g.affectRotation || g.isLocal) continue;
      _q2.set(0, 0, 0, 1).slerp(bones[g.parentIndex].quaternion, g.ratio);
      bones[g.index].quaternion.multiply(_q2);
    }
    this.mesh.updateMatrixWorld(true);
  }

  /**
   * Set a bone's current pose directly (MODEL_BINDBONE) and update it now.
   * @param {string} name @param {number[]} pos @param {number[]} rot
   */
  setBonePose(name, pos, rot) {
    const i = this.pose.boneIndex.get(name);
    if (i === undefined) return false;
    this.pose.bones[i].pos = pos.slice();
    this.pose.bones[i].rot = rot.slice();
    const rest = this.restPositions[i];
    const bone = this.mesh.skeleton.bones[i];
    bone.position.set(rest.x + pos[0], rest.y + pos[1], rest.z + pos[2]);
    bone.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
    return true;
  }

  /** @param {string} name */
  getFace(name) {
    const i = this.pose.faceIndex.get(name);
    return i === undefined ? 0 : this.pose.faces[i].weight;
  }

  /** @param {string} name @param {number} weight */
  setFace(name, weight) {
    const i = this.pose.faceIndex.get(name);
    if (i === undefined) return false;
    this.pose.faces[i].weight = weight;
    return true;
  }

  /** PMDModel::updateFace: weights to morph targets. */
  writeFaces() {
    const inf = this.mesh.morphTargetInfluences;
    if (!inf) return;
    for (const f of this.pose.faces) inf[f.index] = f.weight;
  }

  /**
   * enableRePos at a motion start: move the root to where the center bone is
   * now and return that offset (MotionManager::startMotionSub).
   */
  centerRepositionOffset() {
    const bones = this.mesh.skeleton.bones;
    const center = bones[this.centerBone];
    if (!center) return null;
    this.mesh.updateMatrixWorld(true);
    const world = center.getWorldPosition(new THREE.Vector3());
    const local = this.mesh.worldToLocal(world.clone());
    const restModel = new THREE.Vector3();
    // rest position of the center bone in model space
    let node = center;
    const chain = [];
    while (node && node.isBone) {
      chain.push(this.restPositions[bones.indexOf(node)]);
      node = node.parent;
    }
    for (const p of chain) if (p) restModel.add(p);
    const offset = [local.x - restModel.x, 0, local.z - restModel.z];
    this.rootPos = [this.rootPos[0] + offset[0], this.rootPos[1], this.rootPos[2] + offset[2]];
    this.offsetPos = [this.offsetPos[0] + offset[0], this.offsetPos[1], this.offsetPos[2] + offset[2]];
    this.updateRootBone();
    return offset;
  }

  // -------------------------------------------------------- placement

  /** The mesh transform from the root offset / rotation (and the base bone, if attached). */
  updateRootBone() {
    _q.set(this.rootRot[0], this.rootRot[1], this.rootRot[2], this.rootRot[3]);
    _v.set(this.rootPos[0], this.rootPos[1], this.rootPos[2]);
    this.mesh.matrix.compose(_v, _q, new THREE.Vector3(1, 1, 1));
    if (this.base) {
      this.base.bone.updateMatrixWorld(true);
      _m.copy(this.base.bone.matrixWorld);
      this.mesh.matrix.premultiply(_m);
    }
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  /** PMDObject::updateModelRootOffset; true when a move just finished. @param {number} fps */
  updateRootOffset(fps) {
    const pos = this.rootPos;
    this.isMoving = false;
    const diff = vlength(vsub(pos, this.offsetPos));
    if (diff === 0) return false;
    let ret = false;
    if (diff > MIN_MOVE_DIFF) {
      if (this.moveSpeed >= 0 && fps !== 0) {
        const maxStep = this.moveSpeed / fps;
        if (diff > maxStep) {
          this.rootPos = vlerp(pos, this.offsetPos, maxStep / diff);
          this.isMoving = true;
        } else {
          this.rootPos = this.offsetPos.slice();
          ret = true;
        }
      } else {
        this.rootPos = vlerp(pos, this.offsetPos, 1 - MOVE_SPEED_RATE);
        this.isMoving = true;
      }
    } else {
      this.rootPos = this.offsetPos.slice();
      ret = true;
    }
    return ret;
  }

  /** PMDObject::updateModelRootRotation; true when a turn / rotation just finished. @param {number} fps */
  updateRootRotation(fps) {
    this.isRotating = false;
    const r = this.rootRot;
    const t = this.offsetRot;
    const d = [r[0] - t[0], r[1] - t[1], r[2] - t[2], r[3] - t[3]];
    const diff = Math.sqrt(quatDot(d, d));
    if (diff === 0) return false;
    const step = (rate) => {
      if (quatDot(d, d) < 0.00001) return [r[0] * 0.5 + t[0] * 0.5, r[1] * 0.5 + t[1] * 0.5, r[2] * 0.5 + t[2] * 0.5, r[3] * 0.5 + t[3] * 0.5];
      return slerp(r, t, rate);
    };
    if (diff > MIN_SPIN_DIFF) {
      let next;
      if (this.spinSpeed >= 0 && fps !== 0) {
        const maxStep = (this.spinSpeed * Math.PI) / 180 / fps;
        if (diff <= maxStep) {
          this.rootRot = t.slice();
          return true;
        }
        next = step(maxStep / diff);
      } else {
        next = step(1 - SPIN_SPEED_RATE);
      }
      if (next.every((v, i) => v === r[i])) {
        this.rootRot = t.slice();
        return true;
      }
      this.rootRot = next;
      this.isRotating = true;
      return false;
    }
    this.rootRot = t.slice();
    return true;
  }

  // ------------------------------------------------------------- look

  /** @param {boolean} on */
  setCartoon(on) {
    for (const m of this.materials) {
      m.userData.outlineParameters = { ...(m.userData.outlineParameters || {}), visible: on && (m.userData.outlineParameters?.visible !== false) };
    }
  }

  /** Fade in after loading and out on MODEL_DELETE; true once fully gone. @param {number} frames */
  updateAlpha(frames) {
    let ended = false;
    if (this.appearFrame > 0) {
      this.appearFrame = Math.max(0, this.appearFrame - frames);
      this.alpha = 1 - this.appearFrame / ALPHA_FRAMES;
    }
    if (this.disappearFrame > 0) {
      this.disappearFrame -= frames;
      if (this.disappearFrame <= 0) {
        this.disappearFrame = 0;
        ended = true;
      }
      this.alpha = this.disappearFrame / ALPHA_FRAMES;
    }
    this.materials.forEach((m, i) => {
      const o = this.baseOpacity[i] * this.alpha;
      m.opacity = o;
      m.transparent = o < 1;
    });
    return ended;
  }

  startDisappear() {
    this.deleting = true;
    this.disappearFrame = ALPHA_FRAMES;
  }

  // ---------------------------------------------------------- physics

  /**
   * @param {{ world?: any, gravity: THREE.Vector3, unitStep: number }} params
   */
  enablePhysics(params) {
    if (this.physics || !this.data?.rigidBodies?.length && !this.mesh.geometry.userData.MMD?.rigidBodies?.length) return;
    const mmd = this.mesh.geometry.userData.MMD;
    // MMDPhysics builds bodies from the model at the origin; our mesh is placed by its matrix
    const saved = this.mesh.matrix.clone();
    this.mesh.matrix.identity();
    this.mesh.matrixWorldNeedsUpdate = true;
    try {
      this.physics = new MMDPhysics(this.mesh, mmd.rigidBodies, mmd.constraints, {
        unitStep: params.unitStep, maxStepNum: 1, gravity: params.gravity, world: params.world,
      });
    } finally {
      this.mesh.matrix.copy(saved);
      this.mesh.matrixWorldNeedsUpdate = true;
      this.mesh.updateMatrixWorld(true);
    }
    this.simulatedBones.clear();
    for (const rb of this.physics.bodies) if (rb.params.type > 0 && rb.bone) this.simulatedBones.add(rb.bone);
  }

  disposePhysics() {
    if (!this.physics) return;
    const world = this.physics.world;
    for (const rb of this.physics.bodies) {
      try { world.removeRigidBody(rb.body); } catch (_) { /* gone */ }
    }
    for (const c of this.physics.constraints) {
      try { world.removeConstraint(c.constraint); } catch (_) { /* gone */ }
    }
    this.physics = null;
  }
}
