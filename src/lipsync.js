/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Plugin_Remote/Avatar.cpp (smearing constants)
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 */

/**
 * Mouth shapes (あ/い/う/お) from 16 kHz 16-bit mono speech.
 *
 * MMDAgent-EX picks mouth shapes from phonemes recognised by Julius. Without
 * Julius, each audio frame's loudness, brightness and zero-crossing rate give
 * an estimate. Each estimate is applied when that frame is played, and the
 * drawn weight eases toward it every 30 fps frame (Avatar::update uses
 * SMEARINGRATEFACE = 0.40; a little faster keeps short syllables visible).
 */

/**
 * @typedef {{ A: number, I: number, U: number, O: number }} LipWeights
 */

/** Easing per 30 fps frame (MMDAgent-EX: 0.40). */
const SMEARINGRATEFACE = 0.58;
const MMD_FPS = 30;

/**
 * @param {number} [sampleRate]
 * @returns {{
 *   enqueue: (pcm: Int16Array | ArrayBuffer | ArrayBufferView, startAtEpochMs?: number) => void,
 *   enqueueWeights: (pcm: Int16Array | ArrayBuffer | ArrayBufferView, weights: LipWeights, startAtEpochMs?: number) => void,
 *   endSegment: () => void,
 *   reset: () => void,
 *   tick: (now?: number, deltaSec?: number) => LipWeights,
 * }}
 */
export function createLipSync(sampleRate = 16000) {
  /** @type {LipWeights} */
  let current = { A: 0, I: 0, U: 0, O: 0 };
  /** Drawn weights, easing toward `current`. */
  /** @type {LipWeights} */
  let display = { A: 0, I: 0, U: 0, O: 0 };
  /** @type {Array<{ t: number, w: LipWeights }>} */
  let queue = [];
  let nextT = 0;
  /** @type {LipWeights} */
  let smooth = { A: 0, I: 0, U: 0, O: 0 };

  /**
   * @param {Int16Array | ArrayBuffer | ArrayBufferView} pcm
   * @returns {Int16Array}
   */
  function toI16(pcm) {
    if (pcm instanceof Int16Array) return pcm;
    if (pcm instanceof ArrayBuffer) return new Int16Array(pcm);
    if (ArrayBuffer.isView(pcm)) {
      return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    }
    return new Int16Array(0);
  }

  /**
   * @param {Int16Array} i16
   * @returns {LipWeights}
   */
  function analyze(i16) {
    const n = i16.length;
    if (n < 8) return { A: 0, I: 0, U: 0, O: 0 };

    let energy = 0;
    let high = 0;
    let zc = 0;
    let prev = i16[0] / 32768;
    energy += prev * prev;
    for (let i = 1; i < n; i += 1) {
      const x = i16[i] / 32768;
      energy += x * x;
      const d = x - prev;
      high += d * d;
      if ((prev >= 0) !== (x >= 0)) zc += 1;
      prev = x;
    }
    const rms = Math.sqrt(energy / n);
    const zcr = zc / n;
    const bright = Math.sqrt(high / n) / (rms + 1e-6);

    const open = Math.max(0, Math.min(1, (rms - 0.018) / 0.12));
    if (open < 0.02) return { A: 0, I: 0, U: 0, O: 0 };

    let a = 0;
    let iW = 0;
    let u = 0;
    let o = 0;
    if (bright > 2.4 || zcr > 0.22) {
      iW = open * 0.85;
      a = open * 0.15;
    } else if (bright > 1.55 || zcr > 0.12) {
      a = open * 0.95;
    } else if (bright > 1.05 || zcr > 0.07) {
      o = open * 0.75;
      a = open * 0.2;
    } else {
      u = open * 0.7;
      o = open * 0.15;
    }

    const k = 0.4;
    smooth.A = smooth.A * (1 - k) + a * k;
    smooth.I = smooth.I * (1 - k) + iW * k;
    smooth.U = smooth.U * (1 - k) + u * k;
    smooth.O = smooth.O * (1 - k) + o * k;
    return {
      A: Math.min(1, smooth.A),
      I: Math.min(1, smooth.I),
      U: Math.min(1, smooth.U),
      O: Math.min(1, smooth.O),
    };
  }

  function scheduledStart(startAtEpochMs) {
    if (Number.isFinite(startAtEpochMs)) {
      return startAtEpochMs - performance.timeOrigin;
    }
    const now = performance.now();
    return nextT < now ? now : nextT;
  }

  function enqueue(pcm, startAtEpochMs) {
    const i16 = toI16(pcm);
    if (!i16.length) return;
    nextT = scheduledStart(startAtEpochMs);
    queue.push({ t: nextT, w: analyze(i16) });
    nextT += (i16.length / sampleRate) * 1000;
  }

  /**
   * Queue given weights (instead of estimating them) for a frame of audio.
   * @param {Int16Array | ArrayBuffer | ArrayBufferView} pcm
   * @param {LipWeights} weights
   */
  function enqueueWeights(pcm, weights, startAtEpochMs) {
    const i16 = toI16(pcm);
    if (!i16.length) return;
    nextT = scheduledStart(startAtEpochMs);
    queue.push({
      t: nextT,
      w: {
        A: Math.min(1, Math.max(0, Number(weights?.A) || 0)),
        I: Math.min(1, Math.max(0, Number(weights?.I) || 0)),
        U: Math.min(1, Math.max(0, Number(weights?.U) || 0)),
        O: Math.min(1, Math.max(0, Number(weights?.O) || 0)),
      },
    });
    nextT += (i16.length / sampleRate) * 1000;
  }

  function endSegment() {
    const now = performance.now();
    if (nextT < now) nextT = now;
    smooth = { A: 0, I: 0, U: 0, O: 0 };
    queue.push({ t: nextT, w: { A: 0, I: 0, U: 0, O: 0 } });
  }

  function reset() {
    queue = [];
    nextT = 0;
    current = { A: 0, I: 0, U: 0, O: 0 };
    display = { A: 0, I: 0, U: 0, O: 0 };
    smooth = { A: 0, I: 0, U: 0, O: 0 };
  }

  /**
   * @param {number} [now]
   * @param {number} [deltaSec] seconds since the last call
   */
  function tick(now = performance.now(), deltaSec) {
    while (queue.length && queue[0].t <= now) {
      current = queue.shift().w;
    }
    const dt = Number.isFinite(deltaSec) && deltaSec > 0 ? deltaSec : 1 / 60;
    const deltaFrame = Math.min(dt * MMD_FPS, 4);
    const k = Math.min(1, Math.max(0, SMEARINGRATEFACE * deltaFrame));
    display.A = display.A * (1 - k) + current.A * k;
    display.I = display.I * (1 - k) + current.I * k;
    display.U = display.U * (1 - k) + current.U * k;
    display.O = display.O * (1 - k) + current.O * k;
    return display;
  }

  return { enqueue, enqueueWeights, endSegment, reset, tick };
}
