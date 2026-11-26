/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Plugin_Remote/Avatar.cpp
 *   Plugin_Remote/MouseQueue.cpp
 *   Plugin_Remote/MorphControl.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 */

/**
 * Lip sync with Julius, as Plugin_Remote does it (Avatar.cpp, MouseQueue.cpp,
 * MorphControl.cpp): the speech goes to Julius (WebAssembly, in a worker), the
 * last phoneme of each 30 ms interim result becomes mouth rates for あいうお
 * (Avatar::storeMouthShape), the rates are played in time with the audio, and
 * the mouth morphs ease toward them by 0.40 per frame. When no new shape comes,
 * the mouth closes over 10 frames.
 */

const SMEARING_FACE = 0.40; // SMEARINGRATEFACE
const AGING_FRAMES = 10; // MOUTH_SHAPE_LAST_AGING_FRAME_LENGTH
const RATE = 16000;

/**
 * Avatar::storeMouthShape: phoneme → [A, I, U, O] rates.
 * @param {string | null} phone
 * @returns {number[]}
 */
export function mouthRates(phone) {
  let r = [0, 0, 0, 0];
  if (phone) {
    switch (phone[0]) {
      case 'a': r = [0.5, 0, 0, 0]; break;
      case 'i': r = [0, 0.4, 0, 0]; break;
      case 'u': r = [0, 0, 1.0, 0]; break;
      case 'e': r = [0.1, 0.6, 0.2, 0]; break;
      case 'o': r = [0, 0, 0, 0.8]; break;
      case 'f': case 'w': r = [0, 0, 0.5, 0]; break;
      case 'h': case 'j': r = [0, 0, 0.3, 0]; break;
      case 'y': case 'b': case 'd': case 'g': case 'k': case 'r': case 'z': r = [0.1, 0, 0, 0]; break;
      case 't': r = phone[1] === 'h' ? [0, 0.3, 0, 0] : [0.1, 0, 0, 0]; break;
      default:
    }
    r = r.map((v) => Math.min(1, v * 1.4));
  }
  return r;
}

let workerFailed = false;

/**
 * A Julius worker fed with one stream of speech.
 * @param {(msg: string) => void} log
 */
export function createJuliusLip(log) {
  /** @type {Worker | null} */
  let worker = null;
  let ready = false;
  let failed = workerFailed;
  /** fed chunks: sample index where each starts, and when it plays */
  /** @type {Array<{ start: number, epoch: number }>} */
  let chunks = [];
  let fed = 0;
  /** @type {Array<{ time: number, rates: number[] }>} mouth shapes to apply, in time order */
  let queue = [];

  if (!failed) {
    try {
      worker = new Worker(new URL('./julius-worker.js', import.meta.url));
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'ready') ready = true;
        else if (m.type === 'error') {
          failed = true;
          workerFailed = true;
          log(`Julius を使えないので、音の大きさから口の形を見積もります（${m.message}）`);
        } else if (m.type === 'phone') {
          queue.push({ time: timeOf(m.position), rates: mouthRates(m.phone) });
        }
      };
      worker.onerror = () => {
        failed = true;
        workerFailed = true;
      };
    } catch (err) {
      failed = true;
      workerFailed = true;
    }
  }

  /** When the sample at `position` plays (performance.now() time). */
  function timeOf(position) {
    let c = chunks[0];
    for (const x of chunks) {
      if (x.start <= position) c = x;
      else break;
    }
    const now = performance.now();
    if (!c) return now;
    return Math.max(now, c.epoch - performance.timeOrigin + ((position - c.start) / RATE) * 1000);
  }

  return {
    /** True while the worker can be used (or is still starting). */
    get usable() {
      return Boolean(worker) && !failed;
    },
    get ready() {
      return ready;
    },
    /** @param {Int16Array} pcm @param {number | undefined} startAtEpochMs */
    feed(pcm, startAtEpochMs) {
      if (!worker || failed) return;
      chunks.push({ start: fed, epoch: Number.isFinite(startAtEpochMs) ? startAtEpochMs : performance.timeOrigin + performance.now() });
      if (chunks.length > 4000) chunks = chunks.slice(-2000);
      fed += pcm.length;
      worker.postMessage({ type: 'feed', pcm: pcm.slice() });
    },
    segment() {
      worker?.postMessage({ type: 'segment' });
    },
    /** @param {boolean} on */
    setStreaming(on) {
      worker?.postMessage({ type: 'streaming', on });
    },
    clear() {
      worker?.postMessage({ type: 'clear' });
      queue = [];
    },
    /** Shapes due by now; returns the last one or null. */
    take() {
      const now = performance.now();
      let last = null;
      while (queue.length && queue[0].time <= now) last = queue.shift();
      return last ? last.rates : null;
    },
    dispose() {
      worker?.terminate();
      worker = null;
    },
  };
}

/**
 * The mouth of Avatar::update for one model: targets from Julius, eased.
 */
export function createMouthControl() {
  let current = [0, 0, 0, 0];
  let target = [0, 0, 0, 0];
  let lastRate = [0, 0, 0, 0];
  let aging = 0;
  let nolipCurrent = new Map();
  let controlling = false;
  return {
    /**
     * @param {number[] | null} rates new shape, or null when none arrived
     * @param {number} frames elapsed 30 fps frames
     * @param {(name: string, w: number) => void} setFace
     * @param {{ A: string, I: string, U: string, O: string }} morphs
     * @param {string[]} nolip
     */
    update(rates, frames, setFace, morphs, nolip) {
      if (rates) {
        lastRate = rates;
        aging = AGING_FRAMES;
        target = rates.slice();
      } else if (aging > 0) {
        aging = Math.max(0, aging - frames);
        const r = aging / AGING_FRAMES;
        target = lastRate.map((v) => v * r);
      }
      controlling = aging > 0;
      if (!controlling) return;
      const k = Math.min(1, Math.max(0, SMEARING_FACE * frames));
      current = current.map((v, i) => v * (1 - k) + target[i] * k);
      setFace(morphs.A, current[0]);
      setFace(morphs.I, current[1]);
      setFace(morphs.U, current[2]);
      setFace(morphs.O, current[3]);
      for (const m of nolip) {
        const v = (nolipCurrent.get(m) ?? 0) * (1 - k);
        nolipCurrent.set(m, v);
        setFace(m, v);
      }
    },
    reset() {
      current = [0, 0, 0, 0];
      target = [0, 0, 0, 0];
      aging = 0;
      nolipCurrent = new Map();
    },
  };
}
