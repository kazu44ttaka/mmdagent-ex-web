/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Speech synthesis and recognition with the browser's Web Speech API, in
 * place of Plugin_Open_JTalk / Plugin_Flite+hts_engine and Plugin_Julius.
 *
 *   SYNTH_START|model|style|text  → SYNTH_EVENT_START|model, LIPSYNC_START|model|..., SYNTH_EVENT_STOP|model
 *   SYNTH_STOP|model              → stops speaking (SYNTH_EVENT_STOP)
 *   RECOG_EVENT_START / RECOG_EVENT_STOP|text   from the microphone, when recognition is on
 *
 * The voice is the browser's, not Open_JTalk's, and the browser does not
 * expose phonemes, so the lip motion is an even "a, N" pattern over the
 * estimated length (Open_JTalk sends the real phoneme timings).
 */

/**
 * @typedef {{
 *   post: (type: string, args?: string) => void,
 *   log: (msg: string) => void,
 *   lang: () => string,
 * }} SpeechHost
 */

/** @param {SpeechHost} host */
export function createSpeech(host) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  /** @type {Map<string, SpeechSynthesisUtterance>} */
  const speaking = new Map();
  /** @type {any} */
  let recognizer = null;
  let recogWanted = false;

  /** A rough mouth pattern for `text`: about 130 ms per character. @param {string} text */
  function lipFor(text) {
    const n = Math.max(1, Array.from(text.replace(/\s/g, '')).length);
    const parts = [];
    for (let i = 0; i < n; i += 1) parts.push('a', '90', 'N', '40');
    return parts.join(',');
  }

  function speak(chara, style, text) {
    if (!synth) {
      host.log('このブラウザーは音声合成に対応していません');
      return;
    }
    stop(chara, false);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[ぁ-んァ-ン一-龥]/.test(text) ? 'ja-JP' : host.lang();
    // the style name picks a voice when one of that name exists
    const voice = synth.getVoices().find((v) => v.name === style || v.voiceURI === style);
    if (voice) u.voice = voice;
    u.onstart = () => {
      host.post('SYNTH_EVENT_START', chara);
      host.post('LIPSYNC_START', `${chara}|${lipFor(text)}`);
    };
    const done = () => {
      if (speaking.get(chara) !== u) return;
      speaking.delete(chara);
      host.post('LIPSYNC_STOP', chara);
      host.post('SYNTH_EVENT_STOP', chara);
    };
    u.onend = done;
    u.onerror = done;
    speaking.set(chara, u);
    synth.speak(u);
  }

  function stop(chara, issue = true) {
    const u = speaking.get(chara);
    if (!u) return;
    speaking.delete(chara);
    synth?.cancel();
    host.post('LIPSYNC_STOP', chara);
    if (issue) host.post('SYNTH_EVENT_STOP', chara);
  }

  function startRecognition() {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec) {
      host.log('このブラウザーは音声認識に対応していません（Chrome か Edge を使ってください）');
      return false;
    }
    recognizer = new Rec();
    recognizer.lang = host.lang();
    recognizer.continuous = true;
    recognizer.interimResults = false;
    recognizer.onspeechstart = () => host.post('RECOG_EVENT_START', '');
    recognizer.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) host.post('RECOG_EVENT_STOP', text);
        }
      }
    };
    recognizer.onend = () => {
      if (recogWanted) {
        try { recognizer.start(); } catch (_) { /* already started */ }
      }
    };
    recognizer.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        recogWanted = false;
        host.log('マイクの使用が許可されていません');
      }
    };
    recognizer.start();
    return true;
  }

  return {
    name: 'Speech',
    handles: new Set(['SYNTH_START', 'SYNTH_STOP']),
    handle(type, args, argv) {
      if (type === 'SYNTH_START' && argv.length >= 3) speak(argv[0], argv[1], argv.slice(2).join('|'));
      else if (type === 'SYNTH_STOP' && argv.length >= 1) stop(argv[0]);
    },
    /** Turn microphone recognition on or off. @param {boolean} on */
    setRecognition(on) {
      recogWanted = on;
      if (on) {
        if (!recognizer && !startRecognition()) recogWanted = false;
        else {
          try { recognizer.start(); } catch (_) { /* already started */ }
        }
      } else if (recognizer) {
        recognizer.onend = null;
        recognizer.stop();
        recognizer = null;
      }
      return recogWanted;
    },
    reset() {
      for (const chara of Array.from(speaking.keys())) stop(chara, false);
    },
  };
}
