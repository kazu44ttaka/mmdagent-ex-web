/* global importScripts, createJulius */
/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Web Worker running Julius (WebAssembly) on pushed 16 kHz audio, with
 * MMDAgent-EX's phoneme model and jconf (appdata/julius). Messages:
 *   in:  { type: 'feed', pcm: Int16Array } | { type: 'segment' } | { type: 'streaming', on } | { type: 'clear' }
 *   out: { type: 'ready' } | { type: 'error', message } | { type: 'phone', phone: string | null, position: number }
 */

importScripts('../julius/dist/julius.js');

const base = new URL('../appdata/julius/', self.location.href);
const FILES = ['jconf_phone.txt', 'phoneseq/phone.dfa', 'phoneseq/phone.dict', 'phoneseq/phone.grammar',
  'phoneseq/phone.term', 'phoneseq/phone.voca', 'phoneseq/super_mono128.binhmm'];

let M = null;
let feedPtr = 0;
let feedCap = 0;
const pending = [];

function handle(msg) {
  switch (msg.type) {
    case 'feed': {
      const pcm = msg.pcm;
      if (pcm.length > feedCap) {
        if (feedPtr) M._free(feedPtr);
        feedCap = pcm.length;
        feedPtr = M._malloc(feedCap * 2);
      }
      M.HEAP16.set(pcm, feedPtr >> 1);
      M._jw_feed(feedPtr, pcm.length);
      return;
    }
    case 'segment':
      M._jw_segment();
      return;
    case 'streaming':
      M._jw_set_streaming(msg.on ? 1 : 0);
      return;
    case 'clear':
      M._jw_clear();
      return;
    default:
  }
}

self.onmessage = (ev) => {
  if (M) handle(ev.data);
  else pending.push(ev.data);
};

(async () => {
  try {
    const files = await Promise.all(FILES.map(async (f) => {
      const res = await fetch(new URL(f, base));
      if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
      return [f, new Uint8Array(await res.arrayBuffer())];
    }));
    const mod = await createJulius({
      locateFile: (p) => new URL(`../julius/dist/${p}`, self.location.href).href,
      onPhone: (phone, position) => self.postMessage({ type: 'phone', phone, position }),
      print: () => {},
      printErr: () => {},
    });
    mod.FS.mkdir('/j');
    mod.FS.mkdir('/j/phoneseq');
    for (const [f, bytes] of files) mod.FS.writeFile(`/j/${f}`, bytes);
    const rc = mod.ccall('jw_init', 'number', ['string'], ['/j/jconf_phone.txt']);
    if (rc !== 0) throw new Error(`jw_init ${rc}`);
    M = mod;
    M.ccall('jw_run', null, [], [], { async: true });
    for (const msg of pending.splice(0)) handle(msg);
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
})();
