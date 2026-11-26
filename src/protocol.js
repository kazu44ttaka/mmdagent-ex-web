/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Plugin_Remote/Plugin_Remote.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 */

/**
 * Plugin_Remote's wire format, read the way Plugin_Remote.cpp
 * (processMessageData) reads it.
 *
 * One stream carries both text and audio:
 *   "SND" + 4 digits + PCM bytes  audio chunk (16 kHz, 16-bit, mono, little endian)
 *   "SNDSTRM" / "SNDFILE"         streaming / file mode (optionally followed by a newline)
 *   "SNDBRKS"                     end of an utterance
 *   "__AV_MESSAGE,TYPE|args"      a message for MMDAgent-EX
 *   "__AV..."                     an avatar control line (comma separated)
 *   "TYPE|args"                   anything else is a message for MMDAgent-EX
 * Text lines end with "\n" (or "\r\n").
 */

/**
 * @typedef {{
 *   onMessage?: (type: string, args: string) => void,
 *   onAvatar?: (line: string) => void,
 *   onSound?: (pcm: Int16Array) => void,
 *   onSoundMode?: (mode: 'STRM' | 'FILE') => void,
 *   onSoundBreak?: () => void,
 * }} ProtocolHandlers
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/**
 * @param {ProtocolHandlers} handlers
 */
export function createRemoteStream(handlers) {
  /** Bytes not yet processed (a partial line or a partial audio chunk). */
  let buf = new Uint8Array(0);

  /** @param {Uint8Array} chunk */
  function append(chunk) {
    if (buf.length === 0) {
      buf = chunk.slice();
      return;
    }
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
  }

  /** @param {string} line */
  function dispatchLine(line) {
    if (!line) return;
    if (line.startsWith('__AV_MESSAGE,')) {
      const body = line.slice(13);
      const i = body.indexOf('|');
      handlers.onMessage?.(i < 0 ? body : body.slice(0, i), i < 0 ? '' : body.slice(i + 1));
    } else if (line.startsWith('__AV')) {
      handlers.onAvatar?.(line);
    } else {
      const i = line.indexOf('|');
      handlers.onMessage?.(i < 0 ? line : line.slice(0, i), i < 0 ? '' : line.slice(i + 1));
    }
  }

  function drain() {
    let p = 0;
    while (p < buf.length) {
      if (buf[p] === 0x53 /* S */) {
        if (buf.length - p < 7) break; // wait for the rest of the header
        if (buf[p + 1] === 0x4e && buf[p + 2] === 0x44) {
          const tag = String.fromCharCode(buf[p + 3], buf[p + 4], buf[p + 5], buf[p + 6]);
          if (tag === 'STRM' || tag === 'FILE' || tag === 'BRKS') {
            p += 7;
            if (buf[p] === 0x0a) p += 1;
            else if (buf[p] === 0x0d && buf[p + 1] === 0x0a) p += 2;
            if (tag === 'BRKS') handlers.onSoundBreak?.();
            else handlers.onSoundMode?.(tag);
            continue;
          }
          const len = /^\d{4}$/.test(tag) ? parseInt(tag, 10) : 0;
          if (buf.length - p < 7 + len) break; // wait for the rest of the audio
          const body = buf.slice(p + 7, p + 7 + len);
          handlers.onSound?.(new Int16Array(body.buffer, 0, len >> 1));
          p += 7 + len;
          continue;
        }
      }
      // a text line
      let end = p;
      while (end < buf.length && buf[end] !== 0x0a && buf[end] !== 0x0d) end += 1;
      if (end >= buf.length) break; // not terminated yet
      const line = decoder.decode(buf.subarray(p, end));
      while (end < buf.length && (buf[end] === 0x0a || buf[end] === 0x0d)) end += 1;
      p = end;
      dispatchLine(line);
    }
    buf = buf.slice(p);
  }

  return {
    /** A WebSocket text frame. @param {string} text */
    pushText(text) {
      append(encoder.encode(text));
      drain();
    },
    /** A WebSocket binary frame. @param {ArrayBuffer | ArrayBufferView} data */
    pushBinary(data) {
      const u8 = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      append(u8);
      drain();
    },
    reset() {
      buf = new Uint8Array(0);
    },
    /** Bytes waiting for more data (for tests). */
    pending() {
      return buf.length;
    },
  };
}

/**
 * The line Plugin_Remote sends back for a message seen inside MMDAgent-EX.
 * @param {string} type
 * @param {string} args
 */
export function formatMessage(type, args) {
  return args ? `${type}|${args}\n` : `${type}\n`;
}
