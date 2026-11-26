/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDAgent/src/lib/MMDAgent.cpp
 *   Library_MMDAgent/src/lib/PMDObject.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * The MMDAgent-EX core (Library_MMDAgent MMDAgent.cpp): model, motion,
 * movement, stage, camera, light, KeyValue and binding commands, and the
 * per-step scene update (MMDAgent::updateScene) with its events.
 *
 * Loading is asynchronous in a browser; commands for a model that is still
 * loading wait and run in order once it is ready, so the result is the same as
 * MMDAgent-EX's synchronous loading.
 */

import { Model } from './model.js';
import { parseVmd } from './vmd.js';
import { CameraMotion } from './camera.js';
import { parseShapeMap } from './shapemap.js';
import { parseModelCsv, parseMessageLines } from './modelext.js';
import {
  parseVec3, quatFromEulerDeg, quatIdentity, quatMul, quatNearest, quatRotate, quatFromAxisAngle, vadd, vlength,
} from './math.js';
import { joinPath, normalizePath } from './vfs.js';
import { parseLipConfig, createLipSyncMotion } from './lipsync-motion.js';

export const LIPSYNC_MOTION_NAME = 'LipSync';
const DEFAULT_PRIORITY = 0;

/**
 * @typedef {{
 *   viewer: ReturnType<typeof import('./viewer.js').createViewer>,
 *   vfs: () => import('./vfs.js').Vfs | null,
 *   contentDir: () => string,
 *   post: (type: string, args?: string) => void,
 *   log: (msg: string) => void,
 *   keyValue: () => import('./bindings.js').KeyValue,
 *   bindings: () => import('./bindings.js').Bindings,
 *   maxNumModel: () => number,
 *   lipConfig: () => ReturnType<typeof parseLipConfig>,
 *   defaultShapeMap: () => string | null,
 *   lipsyncPriority: () => number,
 * }} CoreHost
 */

/** @param {CoreHost} host */
export function createCore(host) {
  const { viewer, post, log } = host;
  /** @type {Map<string, Model>} */
  const models = new Map();
  /** alias → commands waiting for the model to finish loading */
  /** @type {Map<string, Array<() => void>>} */
  const loading = new Map();
  /** @type {Map<string, Promise<import('./vmd.js').Vmd>>} */
  const vmdCache = new Map();
  let token = 0;

  // a leading "/" is a path from the tree root (files next to a model)
  const contentPath = (file) => (file.startsWith('/') ? normalizePath(file) : joinPath(host.contentDir(), file));

  /** @param {string} path */
  function loadVmd(path) {
    const vfs = host.vfs();
    const real = vfs?.realPath(path);
    if (!real) return Promise.reject(new Error(`ファイルがありません: ${path}`));
    let p = vmdCache.get(real.toLowerCase());
    if (!p) {
      p = vfs.bytes(real).then((bytes) => parseVmd(/** @type {Uint8Array} */ (bytes)));
      vmdCache.set(real.toLowerCase(), p);
      p.catch(() => vmdCache.delete(real.toLowerCase()));
    }
    return p;
  }

  /** Run now, or after the model of that alias finishes loading. */
  function whenReady(alias, fn) {
    const q = loading.get(alias);
    if (q) q.push(fn);
    else fn();
  }

  /** @param {string} alias */
  function newAlias(alias) {
    if (alias) return alias;
    for (let i = 0; ; i += 1) if (!models.has(String(i)) && !loading.has(String(i))) return String(i);
  }

  // ------------------------------------------------------------- models

  /**
   * MMDAgent::addModel
   * @param {string[]} argv
   */
  function addModel(argv, changeOf = null) {
    const alias = changeOf ? changeOf.alias : newAlias(argv[0]);
    const file = changeOf ? argv[1] : argv[1];
    if (!changeOf && (models.has(alias) || loading.has(alias))) {
      log(`MODEL_ADD: ${alias} はもう使われています`);
      return;
    }
    if (!changeOf && models.size + loading.size >= host.maxNumModel()) {
      log(`MODEL_ADD: モデルは ${host.maxNumModel()} 体までです`);
      return;
    }
    const pos = argv[2] !== undefined && !changeOf ? parseVec3(argv[2]) : null;
    const rotDeg = argv[3] !== undefined && !changeOf ? parseVec3(argv[3]) : null;
    if ((argv[2] !== undefined && !pos) || (argv[3] !== undefined && !rotDeg)) return;
    const cartoonArg = argv[4];
    if (cartoonArg !== undefined && cartoonArg !== 'ON' && cartoonArg !== 'OFF') return;
    let base = null;
    if (argv[5] && !changeOf) {
      const baseModel = models.get(argv[5]);
      if (!baseModel) {
        log(`MODEL_ADD: ${argv[5]} がありません`);
        return;
      }
      const boneIndex = argv[6] ? baseModel.pose.boneIndex.get(argv[6]) : baseModel.centerBone;
      if (boneIndex === undefined) {
        log(`MODEL_ADD: ${argv[5]} に ${argv[6]} がありません`);
        return;
      }
      base = { model: baseModel, bone: baseModel.mesh.skeleton.bones[boneIndex] };
    }
    const vfs = host.vfs();
    const path = contentPath(file);
    const real = vfs?.realPath(path);
    if (!real) {
      log(`MODEL_ADD: ファイルがありません: ${file}`);
      return;
    }
    const myToken = token;
    loading.set(alias, []);
    (async () => {
      const csv = await vfs.bytes(`${real}.csv`);
      const { mesh, data } = await viewer.loadMesh(real, csv ? parseModelCsv(csv) : null);
      const model = new Model({
        alias, path: real, mesh, data,
        position: changeOf ? changeOf.rootPos : (pos || [0, 0, 0]),
        rotation: changeOf ? changeOf.rootRot : (rotDeg ? quatFromEulerDeg(rotDeg) : quatIdentity()),
        cartoon: cartoonArg !== 'OFF',
        base: changeOf ? changeOf.base : base,
      });
      // <model>.shapemap, or the system default (PMDObject::load)
      const shapeText = await vfs.text(`${real}.shapemap`);
      const defaultMap = shapeText ? null : host.defaultShapeMap();
      model.shapeMap = shapeText ? parseShapeMap(shapeText) : defaultMap ? parseShapeMap(defaultMap) : null;
      model.shapeMapIsDefault = !shapeText && Boolean(defaultMap);
      // <model>.lip overrides lip.txt for this model
      const lipText = real.length >= 5 ? await vfs.text(`${real.slice(0, -4)}.lip`) : null;
      model.localLip = lipText ? parseLipConfig(lipText) : null;
      const loadText = await vfs.text(`${real}.loadmessage`);
      const deleteText = await vfs.text(`${real}.deletemessage`);
      model.deleteMessages = deleteText ? parseMessageLines(deleteText) : [];
      return { model, loadMessages: loadText ? parseMessageLines(loadText) : [] };
    })().then(({ model, loadMessages }) => {
      if (myToken !== token) return;
      if (changeOf) {
        // PMDObject::changeModel keeps the motions running on the new model
        model.offsetPos = changeOf.offsetPos;
        model.offsetRot = changeOf.offsetRot;
        model.appearFrame = 0;
        model.alpha = 1;
        for (const m of changeOf.motions.players) {
          const p = model.motions.startMotion(m.vmd, m.name, !m.ignoreStatic, m.onEnd === 2, m.enableSmooth, false, m.priority);
          p.mc.currentFrame = m.mc.currentFrame;
          p.mc.previousFrame = m.mc.previousFrame;
        }
        viewer.removeModel(changeOf);
      }
      models.set(alias, model);
      viewer.addModel(model);
      // first pose before showing (MMDAgent::addModel: updateRootBone / updateMotion(0) / updateSkin)
      stepModel(model, 0);
      model.writeFaces();
      viewer.enablePhysics();
      log(`${alias}: ${real}${model.shapeMap ? '（.shapemap あり）' : ''}`);
      post(changeOf ? 'MODEL_EVENT_CHANGE' : 'MODEL_EVENT_ADD', alias);
      for (const [t, a] of loadMessages) post(t, a);
      const waiting = loading.get(alias) || [];
      loading.delete(alias);
      for (const fn of waiting) fn();
    }).catch((err) => {
      loading.delete(alias);
      log(`モデルを読めません（${file}）: ${err?.message || err}`);
    });
  }

  /** MMDAgent::deleteModel: children first, then fade out. @param {string} alias */
  function deleteModel(alias) {
    const model = models.get(alias);
    if (!model) return false;
    for (const m of models.values()) if (m.base?.model === model && !m.deleting) deleteModel(m.alias);
    model.startDisappear();
    return true;
  }

  /** MMDAgent::removeRelatedModels @param {Model} model */
  function removeRelatedModels(model) {
    for (const m of Array.from(models.values())) if (m.base?.model === model) removeRelatedModels(m);
    for (const p of model.motions.players) {
      if (p.name === LIPSYNC_MOTION_NAME) post('LIPSYNC_EVENT_STOP', model.alias);
      else post('MOTION_EVENT_DELETE', `${model.alias}|${p.name}`);
    }
    for (const [t, a] of model.deleteMessages) post(t, a);
    post('MODEL_EVENT_DELETE', model.alias);
    host.bindings().clearModel(model.alias);
    models.delete(model.alias);
    viewer.removeModel(model);
  }

  // ------------------------------------------------------------ motions

  /**
   * MMDAgent::addMotion
   * @param {Model} model
   */
  function addMotion(model, name, file, full, once, smooth, repos, priority) {
    return loadVmd(contentPath(file)).then((vmd) => {
      if (!models.has(model.alias)) return;
      let motionName = name;
      if (motionName) {
        const running = model.motions.getRunning(motionName);
        if (running) {
          if (!running.enableSmooth) model.needResetKinematic = true;
          model.motions.swapMotion(vmd, motionName);
          post('MOTION_EVENT_ADD', `${model.alias}|${motionName}`);
          return;
        }
      } else {
        for (let i = 0; ; i += 1) if (!model.motions.getRunning(String(i))) { motionName = String(i); break; }
      }
      if (!smooth) model.needResetKinematic = true;
      model.motions.startMotion(vmd, motionName, full, once, smooth, repos, priority);
      post('MOTION_EVENT_ADD', `${model.alias}|${motionName}`);
    }).catch((err) => log(`モーションを読めません（${file}）: ${err?.message || err}`));
  }

  // ------------------------------------------------------------ movement

  /** @param {Model} model */
  function startMove(model, pos, local, speed) {
    if (model.isMoving) post('MOVE_EVENT_STOP', model.alias);
    const current = model.rootPos;
    let target = pos;
    if (local) target = vadd(quatRotate(model.rootRot, pos), current);
    if (target.every((v, i) => v === current[i])) {
      post('MOVE_EVENT_START', model.alias);
      post('MOVE_EVENT_STOP', model.alias);
      return;
    }
    model.moveSpeed = speed;
    model.offsetPos = target;
    model.isMoving = true;
    post('MOVE_EVENT_START', model.alias);
  }

  /** @param {Model} model */
  function stopRotationEvents(model) {
    if (model.isRotating) post(model.isTurning ? 'TURN_EVENT_STOP' : 'ROTATE_EVENT_STOP', model.alias);
  }

  /** @param {Model} model */
  function startTurn(model, pos, local, speed) {
    stopRotationEvents(model);
    const current = model.rootRot;
    let v = local ? pos.slice() : [pos[0] - model.rootPos[0], pos[1] - model.rootPos[1], pos[2] - model.rootPos[2]];
    const len = vlength(v);
    if (len < 1e-6) return;
    v = v.map((x) => x / len);
    const z = Math.min(1, Math.max(-1, v[2]));
    const rad = Math.acos(z);
    let axis = [-v[1], v[0], 0]; // (0,0,1) × v
    let target;
    const al = Math.hypot(axis[0], axis[1], axis[2]);
    if (al * al < 0.000001) target = quatIdentity();
    else {
      axis = axis.map((x) => x / al);
      target = quatFromAxisAngle(axis, rad);
    }
    target = local ? quatMul(current, target) : quatNearest(current, target);
    if (target.every((x, i) => x === current[i])) {
      post('TURN_EVENT_START', model.alias);
      post('TURN_EVENT_STOP', model.alias);
      return;
    }
    model.spinSpeed = speed;
    model.offsetRot = target;
    model.isTurning = true;
    model.isRotating = true;
    post('TURN_EVENT_START', model.alias);
  }

  /** @param {Model} model */
  function startRotation(model, rot, local, speed) {
    stopRotationEvents(model);
    const current = model.rootRot;
    const target = local ? quatMul(current, rot) : quatNearest(current, rot);
    if (target.every((x, i) => x === current[i])) {
      post('ROTATE_EVENT_START', model.alias);
      post('ROTATE_EVENT_STOP', model.alias);
      return;
    }
    model.spinSpeed = speed;
    model.offsetRot = target;
    model.isTurning = false;
    model.isRotating = true;
    post('ROTATE_EVENT_START', model.alias);
  }

  // ------------------------------------------------------------ commands

  const parseLocal = (s) => (s === undefined ? false : s === 'LOCAL' ? true : s === 'GLOBAL' ? false : null);

  /**
   * @param {string} type
   * @param {string[]} argv
   * @returns {boolean} true if this was a core command
   */
  function handle(type, argv) {
    const num = argv.length;
    const withModel = (alias, fn) => whenReady(alias, () => {
      const m = models.get(alias);
      if (m) fn(m);
    });
    switch (type) {
      case 'MODEL_ADD':
        if (num >= 2 && num <= 7) addModel(argv);
        return true;
      case 'MODEL_CHANGE':
      case 'MODEL_CHANGE_ASYNC':
        if (num === 2) withModel(argv[0], (m) => addModel(argv, m));
        return true;
      case 'MODEL_DELETE':
        if (num === 1) withModel(argv[0], (m) => deleteModel(m.alias));
        return true;
      case 'MOTION_ADD': {
        if (num < 3 || num > 8) return true;
        const full = argv[3] === undefined ? true : argv[3] === 'FULL' ? true : argv[3] === 'PART' ? false : null;
        const once = argv[4] === undefined ? true : argv[4] === 'ONCE' ? true : argv[4] === 'LOOP' ? false : null;
        const smooth = argv[5] === undefined ? true : argv[5] === 'ON' ? true : argv[5] === 'OFF' ? false : null;
        const repos = argv[6] === undefined ? false : argv[6] === 'ON' ? true : argv[6] === 'OFF' ? false : null;
        if (full === null || once === null || smooth === null || repos === null) return true;
        const priority = num >= 8 ? parseFloat(argv[7]) || 0 : DEFAULT_PRIORITY;
        withModel(argv[0], (m) => addMotion(m, argv[1], argv[2], full, once, smooth, repos, priority));
        return true;
      }
      case 'MOTION_CHANGE':
        if (num === 3) {
          withModel(argv[0], (m) => {
            loadVmd(contentPath(argv[2])).then((vmd) => {
              const p = m.motions.getRunning(argv[1]);
              if (!p) return;
              if (!p.enableSmooth) m.needResetKinematic = true;
              m.motions.swapMotion(vmd, argv[1]);
              post('MOTION_EVENT_CHANGE', `${m.alias}|${argv[1]}`);
            }).catch((err) => log(`モーションを読めません（${argv[2]}）: ${err?.message || err}`));
          });
        }
        return true;
      case 'MOTION_RESET':
        if (num === 2) {
          withModel(argv[0], (m) => {
            const p = m.motions.getRunning(argv[1]);
            if (!p) return;
            if (!p.enableSmooth) m.needResetKinematic = true;
            m.motions.swapMotion(p.vmd, argv[1]);
            post('MOTION_EVENT_RESET', `${m.alias}|${argv[1]}`);
          });
        }
        return true;
      case 'MOTION_ACCELERATE':
        if (num >= 3 && num <= 5) {
          const speed = parseFloat(argv[2]) || 0;
          const duration = num >= 4 ? parseFloat(argv[3]) || 0 : 0;
          const target = num >= 5 ? parseFloat(argv[4]) || 0 : -1;
          withModel(argv[0], (m) => m.motions.setMotionSpeedRate(argv[1], speed, duration * 30, target * 30));
        }
        return true;
      case 'MOTION_DELETE':
        if (num === 2) withModel(argv[0], (m) => m.motions.deleteMotion(argv[1]));
        return true;
      case 'MOTION_CONFIGURE':
        if (num >= 3 && num <= 4) {
          withModel(argv[0], (m) => {
            if (m.motions.configureMotion(argv[1], argv[2], num >= 4 ? argv[3] : null)) post('MOTION_EVENT_CONFIGURE', `${m.alias}|${argv[1]}`);
          });
        }
        return true;
      case 'MOVE_START':
      case 'TURN_START':
      case 'ROTATE_START': {
        if (num < 2 || num > 4) return true;
        const local = parseLocal(argv[2]);
        if (local === null) return true;
        const speed = num >= 4 ? parseFloat(argv[3]) : -1;
        if (type === 'ROTATE_START') {
          const r = parseVec3(argv[1]);
          if (r) withModel(argv[0], (m) => startRotation(m, quatFromEulerDeg(r), local, speed));
        } else {
          const p = parseVec3(argv[1]);
          if (p) withModel(argv[0], (m) => (type === 'MOVE_START' ? startMove(m, p, local, speed) : startTurn(m, p, local, speed)));
        }
        return true;
      }
      case 'MOVE_STOP':
        if (num === 1) {
          withModel(argv[0], (m) => {
            if (!m.isMoving) return;
            m.offsetPos = m.rootPos.slice();
            m.isMoving = false;
            post('MOVE_EVENT_STOP', m.alias);
          });
        }
        return true;
      case 'TURN_STOP':
      case 'ROTATE_STOP':
        if (num === 1) {
          withModel(argv[0], (m) => {
            const turning = type === 'TURN_STOP';
            if (!m.isRotating || m.isTurning !== turning) return;
            m.offsetRot = m.rootRot.slice();
            m.isRotating = false;
            post(turning ? 'TURN_EVENT_STOP' : 'ROTATE_EVENT_STOP', m.alias);
          });
        }
        return true;
      case 'STAGE': {
        if (num !== 1) return true;
        const vfs = host.vfs();
        const parts = argv[0].split(',');
        if (parts.length >= 2) {
          viewer.setStage(vfs?.url(contentPath(parts[0])) || null, vfs?.url(contentPath(parts[1])) || null);
        } else {
          const real = vfs?.realPath(contentPath(parts[0]));
          if (real) viewer.setStageModel(real).catch((err) => log(`舞台を読めません: ${err?.message || err}`));
          else log(`STAGE: ファイルがありません: ${parts[0]}`);
        }
        return true;
      }
      case 'CAMERA': {
        if ((num < 4 || num > 7) && num !== 1) return true;
        const p = parseVec3(argv[0]);
        const r = num >= 2 ? parseVec3(argv[1]) : null;
        if (p && r) {
          const apply = (bone) => {
            viewer.cam.setMotion(null);
            viewer.cam.setView(p, r, parseFloat(argv[2]) || 0, parseFloat(argv[3]) || 0, bone, bone ? !argv[6] : false);
            viewer.cam.setMoveTime(num >= 5 ? parseFloat(argv[4]) || 0 : -1);
          };
          if (num >= 6) {
            withModel(argv[5], (m) => {
              const i = argv[6] ? m.pose.boneIndex.get(argv[6]) : m.centerBone;
              if (i === undefined) return;
              apply(m.mesh.skeleton.bones[i]);
            });
          } else apply(null);
          return true;
        }
        loadVmd(contentPath(argv[0])).then((vmd) => {
          if (!vmd.camera.length) return;
          viewer.cam.setMotion(new CameraMotion(vmd.camera));
        }).catch((err) => log(`カメラモーションを読めません: ${err?.message || err}`));
        return true;
      }
      case 'LIGHTCOLOR':
      case 'LIGHTDIRECTION': {
        const v = num === 1 ? parseVec3(argv[0]) : null;
        if (v) (type === 'LIGHTCOLOR' ? viewer.setLightColor : viewer.setLightDirection)(v);
        return true;
      }
      case 'LIPSYNC_START':
        if (num === 2) {
          withModel(argv[0], (m) => {
            const ignore = m.shapeMap?.nolip?.length ? m.shapeMap.nolip.join(',') : null;
            const vmd = createLipSyncMotion(m.localLip, argv[1], ignore) || createLipSyncMotion(host.lipConfig(), argv[1], ignore);
            if (!vmd) return;
            if (m.motions.getRunning(LIPSYNC_MOTION_NAME)) {
              m.motions.swapMotion(vmd, LIPSYNC_MOTION_NAME);
              post('LIPSYNC_EVENT_STOP', m.alias);
            } else {
              m.motions.startMotion(vmd, LIPSYNC_MOTION_NAME, true, true, true, false, host.lipsyncPriority());
            }
            post('LIPSYNC_EVENT_START', m.alias);
          });
        }
        return true;
      case 'LIPSYNC_STOP':
        if (num === 1) withModel(argv[0], (m) => m.motions.deleteMotion(LIPSYNC_MOTION_NAME));
        return true;
      case 'KEYVALUE_SET':
        if (num === 2) host.keyValue().set(argv[0], argv[1]);
        return true;
      case 'MODEL_BINDBONE': {
        const alias = num === 4 ? argv[0] : num === 9 ? argv[3] : null;
        if (alias === null) return true;
        whenReady(alias, () => {
          if (!models.has(alias)) return;
          const ev = host.bindings().bindBone(argv);
          if (ev) post('MODEL_EVENT_BINDBONE', ev);
        });
        return true;
      }
      case 'MODEL_BINDFACE': {
        const alias = num === 3 || num === 4 ? argv[0] : num === 7 ? argv[3] : null;
        if (alias === null) return true;
        whenReady(alias, () => {
          const m = models.get(alias);
          if (!m) return;
          const ev = host.bindings().bindFace(argv, (_a, face) => m.getFace(face));
          if (ev) post('MODEL_EVENT_BINDFACE', ev);
        });
        return true;
      }
      case 'MODEL_UNBINDBONE':
        if (num === 2) whenReady(argv[0], () => { if (host.bindings().unbindBone(argv[0], argv[1])) post('MODEL_EVENT_UNBINDBONE', argv.join('|')); });
        return true;
      case 'MODEL_UNBINDFACE':
        if (num === 2) whenReady(argv[0], () => { if (host.bindings().unbindFace(argv[0], argv[1])) post('MODEL_EVENT_UNBINDFACE', argv.join('|')); });
        return true;
      default:
        return false;
    }
  }

  // ------------------------------------------------------------ update

  /** PMDObject::updateMotion (+ bindings) for one model. @param {Model} model @param {number} frames */
  function stepModel(model, frames) {
    model.updateRootBone();
    model.resetBone();
    const changed = model.motions.update(frames);
    model.writeBones();
    model.solveBones(Boolean(model.physics));
    const bindings = host.bindings();
    for (const b of bindings.bones.values()) {
      if (b.alias !== model.alias) continue;
      const { pos, rot } = bindings.bonePose(b);
      model.setBonePose(b.target, pos, rot);
    }
    for (const b of bindings.faces.values()) {
      if (b.alias === model.alias) model.setFace(b.target, bindings.faceWeight(b, frames));
    }
    model.mesh.updateMatrixWorld(true);
    return changed;
  }

  /** One step of MMDAgent::updateScene (before plugins and physics). @param {number} frames */
  function step(frames) {
    for (const model of Array.from(models.values())) {
      if (model.motions.updateMotionSpeedRate(frames)) {
        for (const name of model.motions.justAccelerated()) post('MOTION_EVENT_ACCELERATE', `${model.alias}|${name}`);
      }
      if (model.motions.needsPhysicsSkip()) model.needResetKinematic = true;
      if (stepModel(model, frames)) {
        for (const name of model.motions.justDeleted()) {
          if (name === LIPSYNC_MOTION_NAME) post('LIPSYNC_EVENT_STOP', model.alias);
          else post('MOTION_EVENT_DELETE', `${model.alias}|${name}`);
        }
      }
      if (model.updateAlpha(frames)) removeRelatedModels(model);
    }
    if (viewer.cam.motion) viewer.cam.stepMotion(frames);
  }

  /** After all steps: morph weights to the meshes (PMDObject::updateSkin). */
  function afterSteps() {
    for (const m of models.values()) m.writeFaces();
  }

  /** Once per rendered frame (MMDAgent::renderScene): ease placements. @param {number} fps */
  function frame(fps) {
    for (const m of models.values()) {
      if (m.updateRootOffset(fps)) post('MOVE_EVENT_STOP', m.alias);
      if (m.updateRootRotation(fps)) {
        if (m.isTurning) {
          post('TURN_EVENT_STOP', m.alias);
          m.isTurning = false;
        } else {
          post('ROTATE_EVENT_STOP', m.alias);
        }
      }
    }
  }

  return {
    models,
    handle,
    step,
    afterSteps,
    frame,
    loadVmd,
    whenReady,
    /** @param {string} alias */
    get: (alias) => models.get(alias) || null,
    reset() {
      token += 1;
      models.clear();
      loading.clear();
      vmdCache.clear();
    },
  };
}
