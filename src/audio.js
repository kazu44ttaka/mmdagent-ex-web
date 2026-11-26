/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Streaming PCM16 (16 kHz mono LE) playback via Web Audio API.
 * Uses a stateful resampler and nextStartTime scheduling so consecutive SND
 * frames remain one continuous stream on the device sample rate.
 */

export function createStreamingFloatResampler(fromRate, toRate) {
  const sourceRate = Math.max(1, Number(fromRate) || 16000);
  const targetRate = Math.max(1, Number(toRate) || sourceRate);
  const ratio = sourceRate / targetRate;
  let sourceOffset = 0;
  let nextOutputPos = 0;
  let previousSample = 0;
  let havePrevious = false;

  return {
    process(input) {
      if (!input?.length) return new Float32Array(0);
      if (sourceRate === targetRate) return input.slice();
      const blockStart = sourceOffset;
      const blockEnd = blockStart + input.length - 1;
      const availableStart = havePrevious ? blockStart - 1 : blockStart;
      const output = [];
      const sampleAt = (index) => {
        if (havePrevious && index === 0) return previousSample;
        const inputIndex = index - (havePrevious ? 1 : 0);
        return input[Math.max(0, Math.min(input.length - 1, inputIndex))];
      };
      while (nextOutputPos <= blockEnd + 1e-9) {
        const local = nextOutputPos - availableStart;
        const i0 = Math.floor(local);
        const frac = local - i0;
        const a = sampleAt(i0);
        const b = sampleAt(i0 + 1);
        output.push(a * (1 - frac) + b * frac);
        nextOutputPos += ratio;
      }
      sourceOffset += input.length;
      previousSample = input[input.length - 1];
      havePrevious = true;
      return Float32Array.from(output);
    },
  };
}

/**
 * @returns {{
 *   ensureContext: () => Promise<AudioContext>,
 *   enqueuePcm16: (pcm: Int16Array | ArrayBuffer) => { startAtEpochMs: number, endAtEpochMs: number } | null,
 *   onSegmentEnd: () => void,
 *   reset: () => void,
 *   close: () => Promise<void>,
 *   getContext: () => AudioContext | null,
 * }}
 */
export function createAudioPlayer() {
  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {number} */
  let nextStartTime = 0;
  let outputResampler = null;
  let outputSampleRate = 0;
  const SAMPLE_RATE = 16000;
  // Schedule this far ahead so 20 ms frames arriving with jitter do not
  // starve the AudioContext.
  const REBUFFER_LEAD_SEC = 0.08;

  async function ensureContext() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      // A 16 kHz context stays silent on some output devices: use the
      // device rate and resample here.
      ctx = new AC();
    }
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return ctx;
  }

  /**
   * @param {Int16Array | ArrayBuffer | ArrayBufferView} pcm
   * @returns {Float32Array}
   */
  function pcm16ToFloat32(pcm) {
    let i16;
    if (pcm instanceof Int16Array) {
      i16 = pcm;
    } else if (pcm instanceof ArrayBuffer) {
      i16 = new Int16Array(pcm);
    } else if (ArrayBuffer.isView(pcm)) {
      i16 = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    } else {
      throw new TypeError('Expected Int16Array or ArrayBuffer');
    }
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) {
      f32[i] = Math.max(-1, Math.min(1, i16[i] / 32768));
    }
    return f32;
  }

  /**
   * Enqueue one PCM16 frame for playback.
   * @param {Int16Array | ArrayBuffer | ArrayBufferView} pcm
   */
  function enqueuePcm16(pcm) {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    const sourceData = pcm16ToFloat32(pcm);
    if (sourceData.length === 0) return null;

    if (!outputResampler || outputSampleRate !== ctx.sampleRate) {
      outputSampleRate = ctx.sampleRate;
      outputResampler = createStreamingFloatResampler(SAMPLE_RATE, outputSampleRate);
    }
    // A 16 kHz AudioBufferSource every 20 ms would reset the browser's
    // resampler at each node and click. Resample with one continuous state
    // instead and give the AudioBuffer the device rate.
    const floatData = outputResampler.process(sourceData);
    if (floatData.length === 0) return null;

    const play = () => {
      if (!ctx || ctx.state === 'closed' || ctx.state === 'suspended') return null;
      const buffer = ctx.createBuffer(1, floatData.length, outputSampleRate);
      buffer.copyToChannel(floatData, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const now = ctx.currentTime;
      if (nextStartTime < now) nextStartTime = now + REBUFFER_LEAD_SEC;
      const startTime = nextStartTime;
      source.start(startTime);
      nextStartTime += buffer.duration;
      const epochNow = performance.timeOrigin + performance.now();
      return {
        startAtEpochMs: epochNow + (startTime - now) * 1000,
        endAtEpochMs: epochNow + (nextStartTime - now) * 1000,
      };
    };

    if (ctx.state === 'suspended') {
      ctx.resume().then(play).catch(() => {});
      return null;
    }
    return play();
  }

  /**
   * Mark a logical segment boundary.
   *
   * SNDBRKS arrives when the backend has finished *sending* a segment.  The
   * browser can still have the initial burst buffered for playback, so moving
   * nextStartTime back to currentTime here makes the following segment overlap
   * that buffered tail.  enqueuePcm16 already re-anchors naturally once the
   * schedule is actually in the past.
   */
  function onSegmentEnd() {
    // Keep the scheduled end time intact.
  }

  function reset() {
    outputResampler = null;
    outputSampleRate = 0;
    if (ctx) {
      nextStartTime = ctx.currentTime;
    } else {
      nextStartTime = 0;
    }
  }

  async function close() {
    if (ctx) {
      try {
        await ctx.close();
      } catch (_) {
        /* ignore */
      }
      ctx = null;
      nextStartTime = 0;
      outputResampler = null;
      outputSampleRate = 0;
    }
  }

  return {
    ensureContext,
    enqueuePcm16,
    onSegmentEnd,
    reset,
    close,
    getContext: () => ctx,
  };
}
