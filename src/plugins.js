/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Plugin_Variables/Variables.cpp
 *   Plugin_Variables/CountDown_Thread.cpp
 *   Plugin_Audio/Plugin_Audio.cpp
 *   Plugin_Audio/Audio_Thread.cpp
 *   Plugin_TextArea/TextArea.cpp
 *   Plugin_LookAt/Plugin_LookAt.cpp
 *   Library_MMDAgent/src/lib/BoneController.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * MMDAgent-EX plugins that make sense in a browser:
 *   Variables  VALUE_SET / VALUE_UNSET / VALUE_EVAL / VALUE_GET, TIMER_START / TIMER_STOP / TIMER_CANCEL
 *   Audio      SOUND_START / SOUND_STOP (wav / mp3; lip sync from a <sound>.lab label file)
 *   TextArea   TEXTAREA_ADD / TEXTAREA_SET / TEXTAREA_DELETE (text or image panels in 3D)
 *   LookAt     head and eyes follow the mouse (toggled with the "l" key or PLUGIN_ENABLE / DISABLE)
 * Each follows its Plugin_* source in MMDAgent-EX. PLUGIN_ENABLE|<name> /
 * PLUGIN_DISABLE|<name> switch a plugin as there.
 */

import * as THREE from 'three';
import { parseVec3, quatFromEulerDeg, quatFromAxisAngle, slerp } from './math.js';

/**
 * @typedef {{
 *   post: (type: string, args?: string) => void,
 *   log: (msg: string) => void,
 *   vfs: () => import('./vfs.js').Vfs | null,
 *   contentPath: (file: string) => string,
 *   core: ReturnType<typeof import('./core.js').createCore>,
 *   viewer: ReturnType<typeof import('./viewer.js').createViewer>,
 *   pointer: () => { x: number, y: number, w: number, h: number },
 * }} PluginHost
 *
 * @typedef {{
 *   name: string, enabled: boolean, handles: Set<string>,
 *   handle?: (type: string, args: string, argv: string[]) => void,
 *   update?: (frames: number) => void, frame?: (sec: number) => void, reset?: () => void,
 * }} Plugin
 */

/** Wrap a plugin with PLUGIN_ENABLE / PLUGIN_DISABLE handling. */
function withSwitch(host, plugin, startEnabled = true) {
  plugin.enabled = startEnabled;
  const inner = plugin.handle;
  plugin.handle = (type, args, argv) => {
    if (type === 'PLUGIN_DISABLE' && args === plugin.name && plugin.enabled) {
      plugin.enabled = false;
      plugin.onDisable?.();
      host.post('PLUGIN_EVENT_DISABLE', plugin.name);
      return;
    }
    if (type === 'PLUGIN_ENABLE' && args === plugin.name && !plugin.enabled) {
      plugin.enabled = true;
      plugin.onEnable?.();
      host.post('PLUGIN_EVENT_ENABLE', plugin.name);
      return;
    }
    if (plugin.enabled || plugin.alwaysHandle) inner?.(type, args, argv);
  };
  return plugin;
}

// ------------------------------------------------------------- Variables

/** @param {PluginHost} host @returns {Plugin} */
export function createVariables(host) {
  /** @type {Map<string, { sval: string, fval: number }>} */
  const values = new Map();
  /** @type {Map<string, number>} alias → goal time (ms) */
  const timers = new Map();
  const toFloat = (s) => parseFloat(s) || 0;

  const plugin = {
    name: 'Variables',
    handles: new Set(['VALUE_SET', 'VALUE_UNSET', 'VALUE_EVAL', 'VALUE_GET', 'TIMER_START', 'TIMER_STOP', 'TIMER_CANCEL']),
    handle(type, args, argv) {
      switch (type) {
        case 'VALUE_SET': {
          const [alias, s1, s2] = argv;
          if (!alias) return;
          let fval;
          let sval;
          if (s2 === undefined) {
            sval = s1 ?? '';
            fval = toFloat(s1);
          } else {
            sval = `${s1}|${s2}`;
            let min = toFloat(s1);
            let max = toFloat(s2);
            if (max < min) [min, max] = [max, min];
            fval = min + (max - min) * Math.random();
          }
          values.set(alias, { sval, fval });
          host.post('VALUE_EVENT_SET', alias);
          return;
        }
        case 'VALUE_UNSET':
          if (values.delete(args)) host.post('VALUE_EVENT_UNSET', args);
          return;
        case 'VALUE_EVAL': {
          const [alias, mode, str] = argv;
          const v = values.get(alias);
          if (!v) return;
          const f1 = v.fval;
          const f2 = Math.fround(toFloat(str));
          const a = Math.fround(f1);
          const ops = { EQ: a === f2, NE: a !== f2, LE: a <= f2, LT: a < f2, GE: a >= f2, GT: a > f2 };
          if (!(mode in ops)) return;
          host.post('VALUE_EVENT_EVAL', `${alias}|${mode}|${str}|${ops[mode] ? 'TRUE' : 'FALSE'}`);
          return;
        }
        case 'VALUE_GET': {
          const v = values.get(args);
          if (v) host.post('VALUE_EVENT_GET', `${args}|${v.sval}`);
          return;
        }
        case 'TIMER_START': {
          const [alias, str] = argv;
          if (!alias) return;
          const sec = parseFloat(str);
          if (!(sec > 0)) return;
          if (timers.has(alias)) host.post('TIMER_EVENT_CANCELLED', alias);
          timers.set(alias, performance.now() + sec * 1000);
          host.post('TIMER_EVENT_START', alias);
          return;
        }
        case 'TIMER_STOP':
        case 'TIMER_CANCEL':
          if (timers.delete(args)) host.post(type === 'TIMER_STOP' ? 'TIMER_EVENT_STOP' : 'TIMER_EVENT_CANCELLED', args);
          else if (type === 'TIMER_CANCEL') host.post('TIMER_EVENT_CANCELLED', args);
          return;
        default:
      }
    },
    frame() {
      const now = performance.now();
      for (const [alias, goal] of Array.from(timers)) {
        if (now >= goal) {
          timers.delete(alias);
          host.post('TIMER_EVENT_STOP', alias);
        }
      }
    },
    reset() {
      values.clear();
      timers.clear();
    },
  };
  return withSwitch(host, plugin);
}

// ----------------------------------------------------------------- Audio

/** @param {PluginHost} host @returns {Plugin} */
export function createAudio(host) {
  /** @type {Map<string, HTMLAudioElement>} */
  const playing = new Map();

  /** HTK label → "phone,ms,..." (Audio_Thread::startLipsync). @param {string} text */
  function labelToSeq(text) {
    const parts = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim().split(/\s+/);
      if (t.length < 3) break;
      const start = parseInt(t[0], 10);
      const end = parseInt(t[1], 10);
      if (!(start < end)) break;
      parts.push(t[2], String(Math.floor((end - start) * 1.0e-4 + 0.5)));
    }
    return parts.join(',');
  }

  function stop(alias) {
    const a = playing.get(alias);
    if (!a) return;
    a.pause();
    playing.delete(alias);
    host.post('SOUND_EVENT_STOP', alias);
  }

  const plugin = {
    name: 'Audio',
    handles: new Set(['SOUND_START', 'SOUND_STOP']),
    handle(type, args, argv) {
      if (type === 'SOUND_STOP') {
        stop(args);
        return;
      }
      if (type !== 'SOUND_START' || argv.length < 2) return;
      const [alias, file] = argv;
      const vfs = host.vfs();
      const path = host.contentPath(file);
      const url = vfs?.url(path);
      if (!url) {
        host.log(`SOUND_START: ファイルがありません: ${file}`);
        return;
      }
      stop(alias);
      const audio = new Audio(url);
      playing.set(alias, audio);
      audio.addEventListener('ended', () => {
        if (playing.get(alias) !== audio) return;
        playing.delete(alias);
        host.post('SOUND_EVENT_STOP', alias);
      });
      audio.play().then(async () => {
        host.post('SOUND_EVENT_START', alias);
        // lip sync from "<file>.lab" (the extension replaced), sent to every model
        const lab = await vfs.text(path.replace(/\.[^./]+$/, '.lab'));
        if (lab) {
          const seq = labelToSeq(lab);
          if (seq) for (const m of host.core.models.values()) host.post('LIPSYNC_START', `${m.alias}|${seq}`);
        }
      }).catch((err) => host.log(`音を再生できません（${file}）: ${err?.message || err}`));
    },
    reset() {
      for (const a of playing.values()) a.pause();
      playing.clear();
    },
  };
  return withSwitch(host, plugin);
}

// -------------------------------------------------------------- TextArea

/** @param {PluginHost} host @returns {Plugin} */
export function createTextArea(host) {
  /** @type {Map<string, any>} */
  const areas = new Map();
  const fvec = (s, n) => {
    const p = String(s ?? '').split(',').map((v) => Number(v.trim()));
    return p.length === n && p.every(Number.isFinite) ? p : null;
  };

  function removeArea(a) {
    a.group.parent?.remove(a.group);
    a.mesh.geometry.dispose();
    a.mesh.material.map?.dispose();
    a.mesh.material.dispose();
  }

  /** Draw text (or an image) on a canvas the size of the panel. */
  async function render(a, content) {
    const vfs = host.vfs();
    const imageUrl = vfs?.url(host.contentPath(content));
    let width = a.width;
    let height = a.height;
    const ppu = 64; // canvas pixels per world unit
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (imageUrl && /\.(png|jpe?g|bmp|gif|tga|webp)$/i.test(content)) {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();
      const aspect = img.height / img.width;
      if (a.widthSet <= 0) {
        if (a.heightSet <= 0) { width = 8.0; height = width * aspect; } else { height = a.heightSet; width = height / aspect; }
      } else {
        width = a.widthSet;
        height = a.heightSet <= 0 ? width * aspect : a.heightSet;
      }
      canvas.width = Math.max(2, Math.round(width * ppu));
      canvas.height = Math.max(2, Math.round(height * ppu));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } else {
      // "_" is a space and "\n" a line break, as in TextArea::setText
      const text = content.replace(/_/g, ' ').replace(/\\[rn]/g, '\n');
      const lines = text.split('\n');
      const fontPx = a.textSize * ppu;
      ctx.font = `${fontPx}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", sans-serif`;
      const lineH = fontPx * (1 + a.lineSpace);
      const textW = Math.max(1, ...lines.map((l) => ctx.measureText(l).width)) / ppu;
      const textH = (lineH * lines.length) / ppu;
      const realW = textW + a.margin * 2;
      const realH = textH + a.margin * 2;
      width = a.widthSet <= 0 ? realW : a.widthSet;
      height = a.heightSet <= 0 ? realH : a.heightSet;
      let scale = 1;
      if (a.widthSet > 0 && realW > a.widthSet) scale = Math.min(scale, (a.widthSet - a.margin * 2) / textW);
      if (a.heightSet > 0 && realH > a.heightSet) scale = Math.min(scale, (a.heightSet - a.margin * 2) / textH);
      canvas.width = Math.max(2, Math.round(width * ppu));
      canvas.height = Math.max(2, Math.round(height * ppu));
      const bg = a.bg;
      ctx.fillStyle = `rgba(${bg[0] * 255},${bg[1] * 255},${bg[2] * 255},${bg[3]})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${fontPx * scale}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      const tc = a.color;
      if (a.outline) {
        ctx.lineWidth = fontPx * scale * 0.15;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      }
      ctx.fillStyle = `rgba(${tc[0] * 255},${tc[1] * 255},${tc[2] * 255},${tc[3]})`;
      const top = (canvas.height - lineH * scale * lines.length) / 2;
      lines.forEach((l, i) => {
        const y = top + i * lineH * scale;
        if (a.outline) ctx.strokeText(l, canvas.width / 2, y);
        ctx.fillText(l, canvas.width / 2, y);
      });
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    a.mesh.material.map?.dispose();
    a.mesh.material.map = tex;
    a.mesh.material.needsUpdate = true;
    a.mesh.geometry.dispose();
    a.mesh.geometry = new THREE.PlaneGeometry(width, height);
    a.mesh.visible = true;
  }

  const plugin = {
    name: 'TextArea',
    handles: new Set(['TEXTAREA_ADD', 'TEXTAREA_SET', 'TEXTAREA_DELETE']),
    handle(type, args, argv) {
      const alias = argv[0];
      if (type === 'TEXTAREA_ADD') {
        if (areas.has(alias)) return;
        // alias|w,h|textsize,margin,linespace[,outline]|bg rgba|text rgba|x,y,z[|rx,ry,rz[|model[|bone]]]
        const wh = fvec(argv[1], 2);
        const ts = fvec(argv[2], 4) || (fvec(argv[2], 3) ? [...fvec(argv[2], 3), 0] : null);
        const bg = fvec(argv[3], 4);
        const color = fvec(argv[4], 4);
        const pos = parseVec3(argv[5]);
        const rot = argv[6] !== undefined ? parseVec3(argv[6]) : [0, 0, 0];
        if (!alias || !wh || !ts || !bg || !color || !pos || !rot) return;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }));
        mesh.visible = false;
        mesh.userData.outlineParameters = { visible: false };
        const group = new THREE.Group();
        group.position.set(pos[0], pos[1], pos[2]);
        const q = quatFromEulerDeg(rot);
        group.quaternion.set(q[0], q[1], q[2], q[3]);
        group.add(mesh);
        const a = { alias, widthSet: wh[0], heightSet: wh[1], width: wh[0], height: wh[1], textSize: ts[0], margin: ts[1], lineSpace: ts[2], outline: ts[3] !== 0, bg, color, group, mesh };
        const attach = () => {
          let parent = host.viewer.scene;
          if (argv[7]) {
            const m = host.core.get(argv[7]);
            if (m) {
              const i = argv[8] ? m.pose.boneIndex.get(argv[8]) : m.centerBone;
              if (i !== undefined) parent = m.mesh.skeleton.bones[i];
            }
          }
          parent.add(group);
        };
        if (argv[7]) host.core.whenReady(argv[7], attach);
        else attach();
        areas.set(alias, a);
        host.post('TEXTAREA_EVENT_ADD', alias);
      } else if (type === 'TEXTAREA_SET') {
        const a = areas.get(alias);
        if (!a) return;
        render(a, argv.slice(1).join('|')).catch((err) => host.log(`TEXTAREA_SET: ${err?.message || err}`));
        host.post('TEXTAREA_EVENT_SET', alias);
      } else if (type === 'TEXTAREA_DELETE') {
        const a = areas.get(alias);
        if (!a) return;
        removeArea(a);
        areas.delete(alias);
        host.post('TEXTAREA_EVENT_DELETE', alias);
      }
    },
    reset() {
      for (const a of areas.values()) removeArea(a);
      areas.clear();
    },
  };
  return withSwitch(host, plugin);
}

// ---------------------------------------------------------------- LookAt

/** @param {PluginHost} host @returns {Plugin} */
export function createLookAt(host) {
  const MIN_LENGTH = 1e-7; // BONECONTROLLER_MINLENGTH (approx.)
  /** BoneController::setup parameters of Plugin_LookAt */
  const HEAD = { bone: '頭', rateOn: 0.060, rateOff: 0.008, base: [0, 0, 1], upper: [20, 60, 0], lower: [-45, -60, 0], adjust: [0, -1, 0] };
  const EYE = { bone: '両目', rateOn: 0.300, rateOff: 0.008, base: [0, 0, 1], upper: [30, 60, 0], lower: [-30, -60, 0], adjust: [0, 0, 0] };
  /** @type {Map<string, Array<{ conf: any, rot: number[], enable: boolean, fading: number }>>} */
  const controllers = new Map();
  let enable = false;
  let updating = false;
  const _m = new THREE.Matrix4();
  const _v = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const deg = Math.PI / 180;

  function setEnable(model, list, on) {
    for (const c of list) {
      const i = model.pose.boneIndex.get(c.conf.bone);
      if (i === undefined) continue;
      if (on) c.rot = model.pose.bones[i].rot.slice();
      else if (c.enable) c.fading = 1;
      c.enable = on;
    }
  }

  function toggle() {
    for (const [alias, list] of controllers) {
      const m = host.core.get(alias);
      if (m) setEnable(m, list, !enable);
    }
    updating = true;
    enable = !enable;
    host.post(enable ? 'PLUGIN_EVENT_ENABLE' : 'PLUGIN_EVENT_DISABLE', 'LookAt');
  }

  const plugin = {
    name: 'LookAt',
    alwaysHandle: true,
    handles: new Set(),
    handle(type, args) {
      if (type === 'PLUGIN_ENABLE' && args === 'LookAt') { if (!enable) toggle(); return; }
      if (type === 'PLUGIN_DISABLE' && args === 'LookAt') { if (enable) toggle(); return; }
      if (type === 'KEY' && args === 'l') { toggle(); return; }
      if (type === 'MODEL_EVENT_ADD' || type === 'MODEL_EVENT_CHANGE') {
        const alias = args.split('|')[0];
        const list = [HEAD, EYE].map((conf) => ({ conf, rot: [0, 0, 0, 1], enable, fading: 0 }));
        controllers.set(alias, list);
      }
      if (type === 'MODEL_EVENT_DELETE') controllers.delete(args);
    },
    update(frames) {
      if (!updating || !controllers.size) return;
      // the mouse on a plane through the eye, 200 units across the window (MMDAgent::getScreenPointPosition)
      const p = host.pointer();
      const rate = 200 / p.w;
      _v.set((p.x - p.w / 2) * rate, -(p.y - p.h / 2) * rate, 0).applyMatrix4(host.viewer.camera.matrixWorld);
      const target = _v.clone();
      let any = false;
      for (const [alias, list] of controllers) {
        const model = host.core.get(alias);
        if (!model) continue;
        for (const c of list) {
          const i = model.pose.boneIndex.get(c.conf.bone);
          if (i === undefined) continue;
          const bone = model.mesh.skeleton.bones[i];
          const cur = model.pose.bones[i];
          if (c.enable) {
            const r = Math.min(1, Math.max(0, c.conf.rateOn * frames));
            _m.copy(bone.matrixWorld).invert();
            const local = target.clone().add(new THREE.Vector3(...c.conf.adjust)).applyMatrix4(_m).normalize();
            const b = new THREE.Vector3(...c.conf.base);
            const dot = b.dot(local);
            if (dot <= 1) {
              const axis = b.clone().cross(local);
              if (axis.lengthSq() >= MIN_LENGTH) {
                axis.normalize();
                const q = quatFromAxisAngle([axis.x, axis.y, axis.z], Math.acos(dot));
                _e.setFromQuaternion(_q.set(q[0], q[1], q[2], q[3]), 'ZYX');
                const clamp = (v, k) => Math.min(c.conf.upper[k] * deg, Math.max(c.conf.lower[k] * deg, v));
                _e.set(clamp(_e.x, 0), clamp(_e.y, 1), clamp(_e.z, 2), 'ZYX');
                _q.setFromEuler(_e);
                c.rot = slerp(c.rot, [_q.x, _q.y, _q.z, _q.w], r);
                model.setBonePose(c.conf.bone, cur.pos, c.rot);
              }
            }
            any = true;
          } else if (c.fading > 0) {
            c.fading = Math.max(0, c.fading - c.conf.rateOff * frames);
            c.rot = slerp(cur.rot, c.rot, c.fading);
            model.setBonePose(c.conf.bone, cur.pos, c.rot);
            any = true;
          }
        }
        model.mesh.updateMatrixWorld(true);
      }
      if (!any) updating = false;
    },
    reset() {
      controllers.clear();
      enable = false;
      updating = false;
    },
  };
  plugin.enabled = true;
  return plugin;
}
