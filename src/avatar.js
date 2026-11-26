/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Plugin_Remote/Avatar.cpp
 *   Plugin_Remote/Speak.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 */

/**
 * The avatar part of Plugin_Remote (Plugin_Remote/Avatar.cpp, Speak.cpp):
 * __AV_* lines, the mouth moving with received speech, AVATAR_CONTROL,
 * AVATAR_EVENT_IDLE and SPEAK_START.
 *
 * As in MMDAgent-EX, the received speech goes through Julius (built to
 * WebAssembly, julius-lip.js) to pick mouth shapes. If Julius cannot start,
 * the shape is estimated from the loudness of the sound instead (lipsync.js).
 */

import { createLipSync } from './lipsync.js';
import { createJuliusLip, createMouthControl } from './julius-lip.js';

/** Morphs Avatar uses for the mouth when the .shapemap has no LIP_ lines. */
const DEFAULT_LIP = { A: 'あ', I: 'い', U: 'う', O: 'お' };
const SMEARING_FACE = 0.40; // SMEARINGRATEFACE, per 30 fps frame
const LEAVING_FRAMES = 25; // LEAVINGFRAMES
const FACE_TRACKING_LEAVING_FRAMES = 30; // FACETRACKINGLEAVINGFRAMES
const IDLE_TIME_FRAME = 450; // IDLE_TIME_FRAME

/**
 * @typedef {import('./shapemap.js').ParsedShapeMap} ParsedShapeMap
 * @typedef {{ setFace: (name: string, w: number) => boolean, shapeMap: ParsedShapeMap | null, path: string }} AvatarModel
 * @typedef {{
 *   post: (type: string, args: string) => void,
 *   setKeyValue: (key: string, value: string) => void,
 *   model: (alias: string) => AvatarModel | null,
 *   actionMotionPath: (modelPath: string, file: string) => string,
 *   decodeSpeech?: (file: string) => Promise<{ pcm: Int16Array } | null>,
 *   log: (msg: string) => void,
 * }} AvatarHost
 */

/** Mouth morphs of a model (LIP_A.. in the .shapemap, or あいうお). @param {AvatarModel | null} model */
function lipMorphsOf(model) {
  const out = { ...DEFAULT_LIP };
  for (const key of /** @type {const} */ (['A', 'I', 'U', 'O'])) {
    const named = model?.shapeMap?.lip.get(key)?.[0]?.morph;
    if (named) out[key] = named;
  }
  return out;
}

/**
 * Mouth driven by audio for one model: Julius phonemes (or an estimate), in time.
 * @param {() => AvatarModel | null} target
 * @param {(msg: string) => void} log
 */
function createMouth(target, log) {
  const lipSync = createLipSync(16000);
  const julius = createJuliusLip(log);
  const control = createMouthControl();
  let active = false;
  return {
    feed(pcm, startAtEpochMs) {
      if (julius.usable) julius.feed(pcm, startAtEpochMs);
      else lipSync.enqueue(pcm, startAtEpochMs);
    },
    endSegment() {
      if (julius.usable) julius.segment();
      else lipSync.endSegment();
    },
    /** SNDSTRM (silence segmentation on) / SNDFILE @param {boolean} on */
    setStreaming(on) {
      julius.setStreaming(on);
    },
    dispose() {
      julius.dispose();
    },
    reset() {
      lipSync.reset();
      julius.clear();
      control.reset();
      if (active) {
        const model = target();
        for (const m of Object.values(lipMorphsOf(model))) model?.setFace(m, 0);
      }
      active = false;
    },
    /** @param {number} frames */
    update(frames, apply = true) {
      if (julius.usable) {
        const rates = julius.take();
        const model = target();
        if (!apply || !model) return;
        control.update(rates, frames, (n, w) => model.setFace(n, w), lipMorphsOf(model), model.shapeMap?.nolip || []);
        return;
      }
      const w = lipSync.tick(performance.now(), frames / 30);
      const model = target();
      if (!apply || !model) return;
      const on = w.A + w.I + w.U + w.O > 0.012;
      if (on || active) {
        const morphs = lipMorphsOf(model);
        model.setFace(morphs.A, on ? w.A : 0);
        model.setFace(morphs.I, on ? w.I : 0);
        model.setFace(morphs.U, on ? w.U : 0);
        model.setFace(morphs.O, on ? w.O : 0);
        if (on) for (const m of model.shapeMap?.nolip || []) model.setFace(m, 0);
      }
      active = on;
    },
  };
}

/** @param {AvatarHost} host */
export function createAvatar(host) {
  let enabled = false;
  /** Alias given by __AV_SETMODEL. */
  let assigned = /** @type {string | null} */ (null);
  let autoLip = true;
  let leavingFrameLeft = 0;
  let issueLeaveEvent = false;
  let faceTrackingFrameLeft = 0;
  let idleFrames = 0;
  let idle = false;
  let connected = false;
  /** @type {Map<string, { target: number, current: number }>} morph → EXMORPH weight */
  const exMorph = new Map();
  let actionCount = 0;

  const target = () => (assigned !== null ? host.model(assigned) : null);
  const mouth = createMouth(target, host.log);

  /** Avatar::setEnableFlagInternal (__AV_START / __AV_END) */
  function setEnableInternal(on) {
    enabled = on;
    if (on) {
      leavingFrameLeft = 0;
      host.post('AVATAR', 'START');
      host.setKeyValue('Avatar_mode', '1.000000');
    } else {
      leavingFrameLeft = LEAVING_FRAMES;
      for (const v of exMorph.values()) v.target = 0;
      host.post('AVATAR', 'END');
      host.setKeyValue('Avatar_mode', '0.000000');
    }
    issueLeaveEvent = false;
  }

  /** Avatar::setEnableFlag (AVATAR_CONTROL) */
  function setEnableFlag(on) {
    if (on) {
      if (!enabled) setEnableInternal(true);
      host.post('AVATAR_EVENT_CONTROL', 'ENABLED');
    } else {
      if (enabled) setEnableInternal(false);
      issueLeaveEvent = true;
    }
  }

  /**
   * One "__AV..." line (comma separated).
   * @param {string} line
   */
  function handleLine(line) {
    const parts = line.split(',').map((s) => s.replace(/[\r\n]+$/, ''));
    const name = parts[0];
    switch (name) {
      case '__AV_START':
        setEnableInternal(true);
        return;
      case '__AV_END':
        setEnableInternal(false);
        return;
      case '__AV_SETMODEL':
        if (parts.length === 2) {
          assigned = parts[1];
          exMorph.clear();
          mouth.reset();
        }
        return;
      case '__AV_EXMORPH': {
        if (!enabled) return;
        const map = target()?.shapeMap;
        for (const item of parts.slice(1)) {
          const eq = item.indexOf('=');
          if (eq <= 0) continue;
          const targets = map?.exmorph.get(`EXMORPH_${item.slice(0, eq)}`);
          const value = Number(item.slice(eq + 1));
          if (!targets || !Number.isFinite(value)) continue;
          for (const t of targets) {
            const w = t.thres ? (value >= t.coef ? 1 : 0) : value * t.coef;
            const cur = exMorph.get(t.morph);
            exMorph.set(t.morph, { target: w, current: cur ? cur.current : 0 });
          }
        }
        faceTrackingFrameLeft = FACE_TRACKING_LEAVING_FRAMES + LEAVING_FRAMES;
        return;
      }
      case '__AV_ACTION': {
        const model = target();
        const file = model?.shapeMap?.acts.get(`ACT${parseInt(parts[1], 10)}`);
        if (!assigned || !model || !file) return;
        // Avatar.cpp plays an action as "__action<n>" (n < 10), PART ONCE
        const motion = `__action${actionCount % 10}`;
        actionCount += 1;
        host.post('MOTION_ADD', `${assigned}|${motion}|${host.actionMotionPath(model.path, file)}|PART|ONCE|ON|OFF`);
        return;
      }
      case '__AVCONF_DISABLEAUTOLIP':
        if (parts[1] === 'ALWAYS') {
          autoLip = false;
          mouth.reset();
        } else if (['NO', 'ARKIT', 'AU', 'ARKIT+AU', 'AU+ARKIT'].includes(parts[1])) {
          autoLip = true;
        }
        return;
      default:
        host.log(`未対応の命令: ${name}`);
    }
  }

  // ------------------------------------------------------------ SPEAK_START

  /** @type {Map<string, { mouth: ReturnType<typeof createMouth>, pcm: Int16Array, file: string, timer: number }>} */
  const speaking = new Map();

  function stopSpeaking(alias, issue = true) {
    const s = speaking.get(alias);
    if (!s) return false;
    window.clearTimeout(s.timer);
    s.mouth.reset();
    s.mouth.dispose();
    speaking.delete(alias);
    host.post('SOUND_STOP', `__speak__${alias}`);
    if (issue) host.post('SPEAK_EVENT_STOP', alias);
    return true;
  }

  /** SPEAK_START|model|file: lip sync on the file, played through Plugin_Audio. */
  async function startSpeaking(alias, file) {
    if (!host.model(alias)) {
      host.log(`SPEAK_START: ${alias} がありません`);
      return;
    }
    const decoded = await host.decodeSpeech?.(file);
    if (!decoded) {
      host.log(`SPEAK_START: 音声を読めません: ${file}`);
      return;
    }
    stopSpeaking(alias, false);
    const m = createMouth(() => host.model(alias), host.log);
    speaking.set(alias, { mouth: m, pcm: decoded.pcm, file, timer: 0 });
    host.post('SPEAK_EVENT_START', alias);
    host.post('SOUND_START', `__speak__${alias}|${file}`);
  }

  return {
    handleLine,
    /** Messages Plugin_Remote handles (SPEAK_*, AVATAR_*). */
    handleMessage(type, args, argv) {
      if (type === 'SPEAK_START' && argv.length >= 2) {
        startSpeaking(argv[0], argv[1]).catch((err) => host.log(`SPEAK_START: ${err?.message || err}`));
      } else if (type === 'SPEAK_STOP' && args) {
        if (!stopSpeaking(args)) host.post('SPEAK_EVENT_STOP', args);
      } else if (type === 'AVATAR_CONTROL' && connected) {
        if (args === 'ENABLE') setEnableFlag(true);
        else if (args === 'DISABLE') setEnableFlag(false);
      } else if (type === 'SOUND_EVENT_START' && args.startsWith('__speak__')) {
        // the file is playing now: feed its samples so the mouth follows playback
        const alias = args.slice(9);
        const s = speaking.get(alias);
        if (!s) return;
        const start = performance.timeOrigin + performance.now();
        const chunk = 320;
        for (let i = 0; i < s.pcm.length; i += chunk) {
          s.mouth.feed(s.pcm.subarray(i, i + chunk), start + (i / 16000) * 1000);
        }
        s.mouth.endSegment();
        s.timer = window.setTimeout(() => {
          if (speaking.get(alias) !== s) return;
          speaking.delete(alias);
          s.mouth.dispose();
          host.post('SPEAK_EVENT_STOP', alias);
        }, (s.pcm.length / 16000) * 1000 + 300);
      }
    },
    /**
     * Speech audio arrived; `startAtEpochMs` is when it starts playing.
     * @param {Int16Array} pcm
     * @param {number | undefined} startAtEpochMs
     */
    sound(pcm, startAtEpochMs) {
      if (!autoLip || !enabled || !target()) return;
      mouth.feed(pcm, startAtEpochMs);
    },
    soundBreak() {
      mouth.endSegment();
    },
    /** SNDSTRM / SNDFILE @param {'STRM' | 'FILE'} mode */
    soundMode(mode) {
      mouth.setStreaming(mode === 'STRM');
    },
    /** Any data from the server resets the idle timer (Avatar::resetIdleTime). */
    resetIdleTime() {
      idleFrames = 0;
    },
    /** @param {boolean} on */
    setConnected(on) {
      connected = on;
      idleFrames = 0;
    },
    /**
     * Each step, after the motion and bindings (Avatar::update).
     * @param {number} frames elapsed 30 fps frames
     */
    update(frames) {
      for (const s of speaking.values()) s.mouth.update(frames);
      if (connected) {
        idleFrames += frames;
        if (idleFrames < IDLE_TIME_FRAME && idle) {
          idle = false;
          host.post('AVATAR_EVENT_IDLE', 'STOP');
        }
        if (idleFrames >= IDLE_TIME_FRAME && !idle) {
          idle = true;
          host.post('AVATAR_EVENT_IDLE', 'START');
        }
      }
      if (faceTrackingFrameLeft > LEAVING_FRAMES) {
        faceTrackingFrameLeft -= frames;
        if (faceTrackingFrameLeft <= LEAVING_FRAMES) {
          faceTrackingFrameLeft = LEAVING_FRAMES;
          for (const v of exMorph.values()) v.target = 0;
        }
      } else if (faceTrackingFrameLeft > 0) {
        faceTrackingFrameLeft = Math.max(0, faceTrackingFrameLeft - frames);
      }
      if (!enabled) {
        leavingFrameLeft = Math.max(0, leavingFrameLeft - frames);
        if (leavingFrameLeft === 0) {
          if (issueLeaveEvent) {
            host.post('AVATAR_EVENT_CONTROL', 'DISABLED');
            issueLeaveEvent = false;
          }
          mouth.update(frames, false);
          return;
        }
      }
      const model = target();
      if (!model) return;
      mouth.update(frames, autoLip);
      if (faceTrackingFrameLeft > 0 && exMorph.size) {
        const rate = Math.min(1, SMEARING_FACE * frames);
        for (const [morph, s] of exMorph) {
          s.current = s.current * (1 - rate) + s.target * rate;
          model.setFace(morph, s.current);
        }
      }
    },
    /** Forget the model assignment and state (new scene). */
    reset() {
      enabled = false;
      assigned = null;
      autoLip = true;
      exMorph.clear();
      mouth.reset();
      for (const alias of Array.from(speaking.keys())) stopSpeaking(alias, false);
      faceTrackingFrameLeft = 0;
      leavingFrameLeft = 0;
      idle = false;
      idleFrames = 0;
    },
    get enabled() {
      return enabled;
    },
    get assigned() {
      return assigned;
    },
  };
}
