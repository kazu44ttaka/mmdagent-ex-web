/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * MMDAgent-EX Web: runs MMDAgent-EX content in the browser and talks to a
 * Plugin_Remote WebSocket server the way MMDAgent-EX does.
 *
 * Every message goes through one queue, as in MMDAgent-EX: the core handles
 * the commands it knows (models, motions, camera, KeyValue, bindings), the
 * FSTs see every message, and the WebSocket peer gets every message too.
 */

import { createVfs, dirname, joinPath, basename, normalizePath } from './vfs.js';
import { parseMdf, websocketUrlFromMdf, mdfFloat } from './mdf.js';
import { Fst, FstSet } from './fst.js';
import { KeyValue, Bindings } from './bindings.js';
import { createRemoteStream, formatMessage } from './protocol.js';
import { createAvatar } from './avatar.js';
import { createAudioPlayer } from './audio.js';
import { createViewer, VFS_PREFIX } from './viewer.js';
import { createCore } from './core.js';
import { parseLipConfig } from './lipsync-motion.js';
import { createVariables, createAudio, createTextArea, createLookAt } from './plugins.js';
import { createUi } from './ui.js';
import { createSpeech } from './speech.js';
import { createSystem } from './system.js';
import * as THREE from 'three';

const LOG_MAX = 300;
/** Messages that would flood the log at the frame rate. */
const QUIET = new Set(['KEYVALUE_SET']);

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const elFolder = /** @type {HTMLInputElement} */ ($('folder'));
const elMdf = /** @type {HTMLSelectElement} */ ($('mdf'));
const elStart = /** @type {HTMLButtonElement} */ ($('start'));
const elWs = /** @type {HTMLInputElement} */ ($('ws-url'));
const elConnect = /** @type {HTMLButtonElement} */ ($('connect'));
const elStatus = $('status');
const elScene = $('scene-status');
const elLog = $('log');
const elShowAll = /** @type {HTMLInputElement} */ ($('log-all'));
const elViewport = $('viewport');
const elPanel = $('panel');

function store(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (_) {
    /* storage may be unavailable */
  }
}
function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

/** @type {string[]} */
const logLines = [];
let logQueued = false;
function log(msg) {
  logLines.push(`${new Date().toLocaleTimeString()} ${msg}`);
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  if (logQueued) return;
  logQueued = true;
  requestAnimationFrame(() => {
    logQueued = false;
    elLog.textContent = logLines.join('\n');
    elLog.scrollTop = elLog.scrollHeight;
  });
}

// ------------------------------------------------------------------ state

/** @type {ReturnType<typeof createVfs> | null} */
let vfs = null;
/** Folder of the running .mdf (MMDAgent-EX resolves content paths from it). */
let contentDir = '';
let keyValue = new KeyValue();
let bindings = new Bindings(keyValue);
let fsts = new FstSet();
let maxNumModel = 10;
let lipsyncPriority = 100;
/** lip.txt and default.shapemap of the MMDAgent-EX system folder (bundled in appdata/) */
let lipConfig = null;
let defaultShapeMapText = null;
fetch('./appdata/lip.txt').then((r) => (r.ok ? r.text() : null)).then((t) => { lipConfig = t ? parseLipConfig(t) : null; }).catch(() => {});
fetch('./appdata/default.shapemap').then((r) => (r.ok ? r.text() : null)).then((t) => { defaultShapeMapText = t; }).catch(() => {});
const pointer = { x: 0, y: 0 };

/**
 * Content path → path in the picked tree. A leading "/" means a path from the
 * tree root (used for files next to a model, like .shapemap actions).
 * @param {string} file
 */
function contentPath(file) {
  return file.startsWith('/') ? normalizePath(file) : joinPath(contentDir, file);
}

const audio = createAudioPlayer();

/**
 * Plugins see every message and are updated every step, like MMDAgent-EX plugins.
 * @type {Array<{ name: string, handles?: Set<string>, handle?: (type: string, args: string, argv: string[]) => void, update?: (frames: number) => void, frame?: (sec: number) => void, reset?: () => void }>}
 */
const plugins = [];

const viewer = createViewer(elViewport, {
  onLog: log,
  urlModifier: (url) => {
    if (!url.startsWith(VFS_PREFIX) || !vfs) return url;
    return vfs.url(decodeURI(url.slice(VFS_PREFIX.length))) || url;
  },
  onFrame: (sec, fps) => {
    core.frame(fps);
    for (const p of plugins) p.frame?.(sec);
  },
  onStep: (frames) => {
    core.step(frames);
    for (const p of plugins) p.update?.(frames);
  },
  onAfterSteps: () => core.afterSteps(),
});

const core = createCore({
  viewer,
  vfs: () => vfs,
  contentDir: () => contentDir,
  post: (type, args) => post(type, args),
  log,
  keyValue: () => keyValue,
  bindings: () => bindings,
  maxNumModel: () => maxNumModel,
  lipConfig: () => lipConfig,
  defaultShapeMap: () => defaultShapeMapText,
  lipsyncPriority: () => lipsyncPriority,
});

const avatar = createAvatar({
  post: (type, args) => post(type, args),
  setKeyValue: (key, value) => keyValue.set(key, value),
  model: (alias) => core.get(alias),
  actionMotionPath: (modelPath, file) => `/${joinPath(dirname(modelPath), file)}`,
  decodeSpeech,
  log,
});
plugins.push({
  name: 'Remote',
  handles: new Set(['SPEAK_START', 'SPEAK_STOP', 'AVATAR_CONTROL', 'AVATAR_LOGSAVE_START', 'AVATAR_LOGSAVE_STOP']),
  handle: (type, args, argv) => avatar.handleMessage(type, args, argv),
  update: (frames) => avatar.update(frames),
  reset: () => avatar.reset(),
});

/**
 * An audio file as 16 kHz mono PCM (Speak::loadWaveAndSpeak resamples the same way).
 * @param {string} file
 */
async function decodeSpeech(file) {
  const bytes = await vfs?.bytes(contentPath(file));
  if (!bytes) return null;
  const ctx = await audio.ensureContext();
  const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const length = Math.ceil(buf.duration * 16000);
  const off = new OfflineAudioContext(1, length, 16000);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = (await off.startRendering()).getChannelData(0);
  const pcm = new Int16Array(out.length);
  for (let i = 0; i < out.length; i += 1) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767)));
  return { pcm };
}
{
  const pluginHost = {
    post: (type, args) => post(type, args),
    log,
    vfs: () => vfs,
    contentPath,
    core,
    viewer,
    pointer: () => ({ x: pointer.x, y: pointer.y, w: elViewport.clientWidth || 1, h: elViewport.clientHeight || 1 }),
  };
  plugins.push(createVariables(pluginHost), createAudio(pluginHost), createTextArea(pluginHost), createLookAt(pluginHost));
}
const ui = createUi({ post: (type, args) => post(type, args), log, vfs: () => vfs, contentPath, root: elViewport });
plugins.push(ui);
const speech = createSpeech({ post: (type, args) => post(type, args), log, lang: () => 'ja-JP' });
plugins.push(speech);
const elRecog = /** @type {HTMLInputElement} */ ($('recog'));
elRecog.addEventListener('change', () => { elRecog.checked = speech.setRecognition(elRecog.checked); });
plugins.push(createSystem({
  post: (type, args) => post(type, args),
  log,
  contentPath,
  vfs: () => vfs,
  openScene: (mdfPath) => {
    elMdf.value = mdfPath;
    startScene(mdfPath).catch((err) => log(`シーンを始められません: ${err?.message || err}`));
  },
  currentScene: () => elMdf.value,
  setHome: (mdfPath) => store('home', mdfPath),
  core,
}));
// Remote: PLUGIN_DISABLE|Remote disconnects, PLUGIN_ENABLE|Remote connects again
plugins.push({
  name: 'RemoteSwitch',
  handle: (type, args) => {
    if (args !== 'Remote') return;
    if (type === 'PLUGIN_DISABLE' && wantConnected) { disconnect(); post('PLUGIN_EVENT_DISABLE', 'Remote'); }
    if (type === 'PLUGIN_ENABLE' && !wantConnected) connect();
  },
});
// double-click a model: MODEL_EVENT_SELECT|alias
elViewport.addEventListener('dblclick', (ev) => {
  const r = elViewport.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, viewer.camera);
  let best = null;
  for (const m of core.models.values()) {
    const hit = ray.intersectObject(m.mesh, false)[0];
    if (hit && (!best || hit.distance < best.d)) best = { d: hit.distance, alias: m.alias };
  }
  if (best) post('MODEL_EVENT_SELECT', best.alias);
});
elViewport.addEventListener('pointermove', (ev) => {
  const r = elViewport.getBoundingClientRect();
  pointer.x = ev.clientX - r.left;
  pointer.y = ev.clientY - r.top;
});

// ------------------------------------------------------------ message queue

/** @type {Array<[string, string]>} */
const queue = [];
let draining = false;

/**
 * Issue a message inside MMDAgent-EX.
 * @param {string} type
 * @param {string} [args]
 */
function post(type, args = '') {
  queue.push([type, args]);
  if (!draining) {
    draining = true;
    queueMicrotask(drain);
  }
}

function drain() {
  try {
    for (let n = 0; queue.length && n < 5000; n += 1) {
      const [type, args] = /** @type {[string, string]} */ (queue.shift());
      if (elShowAll.checked || !QUIET.has(type)) log(args ? `${type}|${args}` : type);
      const argv = args === '' ? [] : args.split('|');
      try {
        if (!core.handle(type, argv)) unsupported(type);
        for (const p of plugins) p.handle?.(type, args, argv);
      } catch (err) {
        log(`${type}: ${err?.message || err}`);
      }
      for (const out of fsts.input(type, args)) post(out.type, out.args);
      wsSend(formatMessage(type, args));
    }
  } finally {
    draining = false;
    if (queue.length) {
      draining = true;
      setTimeout(drain, 0);
    }
  }
}

/** Commands of MMDAgent-EX this page does not carry out (logged once each). */
const UNSUPPORTED = new Set([
  'PROMPT_SHOW', 'MENU', 'INFOTEXT_FILE', 'INFOTEXT_STRING', 'CAPTION_SETSTYLE', 'CAPTION_START', 'CAPTION_STOP',
  'BUTTON_ADD', 'BUTTON_DELETE', 'WINDOWFRAME', 'WINDOWFRAME_ADD', 'WINDOWFRAME_DELETE', 'WINDOWFRAME_DELETEALL',
  'WINDOWOVERLAY_ADD', 'WINDOWOVERLAY_DELETE', 'WINDOWOVERLAY_DELETEALL', 'WINDOWOVERLAY_HIDE', 'WINDOWOVERLAY_SHOW',
  'TRANSPARENT_START', 'TRANSPARENT_STOP', 'LOG_UPLOAD', 'RECOG_RECORD_START', 'RECOG_RECORD_STOP',
  'REMOTEKEY_DOWN', 'REMOTEKEY_UP',
  'RECOG_MODIFY',
]);
const unsupportedSeen = new Set();
function unsupported(type) {
  if (!UNSUPPORTED.has(type) || unsupportedSeen.has(type)) return;
  if (plugins.some((p) => p.handles?.has(type))) return;
  unsupportedSeen.add(type);
  log(`（${type} はこのビューアでは動きません）`);
}

// --------------------------------------------------------------- scene

/** Sub FSTs are the files in the same folder whose name starts with "<main>.fst". */
function fstFiles(mainPath) {
  if (!vfs) return [];
  const dir = dirname(mainPath).toLowerCase();
  const head = basename(mainPath).toLowerCase();
  return vfs.list().filter((p) => {
    const lower = p.toLowerCase();
    return dirname(lower) === dir && lower !== mainPath.toLowerCase()
      && basename(lower).startsWith(head) && lower.endsWith('.fst');
  });
}

/** @param {string} mdfPath */
async function startScene(mdfPath) {
  if (!vfs) return;
  queue.length = 0;
  core.reset();
  viewer.reset();
  for (const p of plugins) p.reset?.();
  audio.reset();
  keyValue = new KeyValue();
  bindings = new Bindings(keyValue);
  fsts = new FstSet();
  unsupportedSeen.clear();
  contentDir = dirname(mdfPath);

  const mdfText = (await vfs.text(mdfPath)) || '';
  const mdf = parseMdf(mdfText);
  for (const [k, v] of mdf) keyValue.set(k, v);
  maxNumModel = Math.max(1, Math.round(mdfFloat(mdf, 'max_num_model', 10)));
  lipsyncPriority = mdfFloat(mdf, 'lipsync_priority', 100);
  viewer.applyMdf(mdf);
  if (!recall(`ws:${mdfPath}`)) elWs.value = websocketUrlFromMdf(mdf);

  const mainFst = vfs.realPath(mdfPath.replace(/\.mdf$/i, '.fst'));
  /** @type {Map<string, string>} lower-case path → text, for %INCLUDE */
  const texts = new Map();
  for (const p of vfs.list()) {
    if (p.toLowerCase().endsWith('.fst')) texts.set(p.toLowerCase(), /** @type {string} */ (await vfs.text(p)));
  }
  const include = (file) => texts.get(joinPath(contentDir, file).toLowerCase()) ?? null;
  if (mainFst) {
    for (const [i, p] of [mainFst, ...fstFiles(mainFst)].entries()) {
      const fst = new Fst({ keyValue, log, name: i === 0 ? 'main' : `sub${i}` });
      const { errors } = fst.load(texts.get(p.toLowerCase()) || '', { file: p, include });
      if (errors) log(`${p}: ${errors} か所読めない行があります`);
      fsts.add(fst);
    }
    log(`シーン: ${mdfPath}（FST ${fsts.fsts.length} 本）`);
  } else {
    log(`シーン: ${mdfPath}（${basename(mdfPath).replace(/\.mdf$/i, '.fst')} がありません）`);
  }
  elScene.textContent = basename(mdfPath);
  store('mdf', mdfPath);
  for (const out of fsts.start()) post(out.type, out.args);
  if (wantConnected) connect();
}

/** @param {FileList | File[]} files */
function setFiles(files) {
  const list = Array.from(files);
  vfs?.dispose();
  vfs = createVfs(list.map((file) => ({ path: file.webkitRelativePath || file.name, file })));
  const mdfs = vfs.list().filter((p) => p.toLowerCase().endsWith('.mdf'));
  elMdf.innerHTML = '';
  for (const p of mdfs) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    elMdf.appendChild(opt);
  }
  const last = recall('home') || recall('mdf');
  const ws = mdfs.find((p) => /websocket/i.test(p));
  elMdf.value = (last && mdfs.includes(last) && last) || ws || mdfs[0] || '';
  elMdf.disabled = mdfs.length === 0;
  elStart.disabled = mdfs.length === 0;
  log(`${list.length} 個のファイルを読み込みました（.mdf ${mdfs.length} 個）`);
  if (!mdfs.length) log('.mdf が見つかりません。MMDAgent-EX のコンテンツのフォルダーを選んでください。');
}

// -------------------------------------------------------------- WebSocket

/** @type {WebSocket | null} */
let ws = null;
let wantConnected = false;
let retryTimer = 0;

const stream = createRemoteStream({
  onMessage: (type, args) => {
    avatar.resetIdleTime();
    post(type, args);
  },
  onAvatar: (line) => {
    avatar.resetIdleTime();
    if (elShowAll.checked) log(line);
    avatar.handleLine(line);
  },
  onSound: (pcm) => {
    avatar.resetIdleTime();
    const timing = audio.enqueuePcm16(pcm);
    avatar.sound(pcm, timing?.startAtEpochMs);
  },
  onSoundBreak: () => avatar.soundBreak(),
  onSoundMode: (mode) => avatar.soundMode(mode),
});

function setStatus(text, kind) {
  elStatus.textContent = text;
  elStatus.dataset.kind = kind;
}

/** @param {string} text */
function wsSend(text) {
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(text);
    } catch (_) {
      /* closing */
    }
  }
}

function connect() {
  wantConnected = true;
  window.clearTimeout(retryTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  const url = elWs.value.trim();
  if (!url) return;
  store(`ws:${elMdf.value}`, url);
  stream.reset();
  setStatus('接続中…', 'busy');
  elConnect.textContent = '切断';
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (err) {
    setStatus('URL が正しくありません', 'error');
    return;
  }
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    setStatus('接続しました', 'ok');
    log(`${url} に接続しました`);
    avatar.setConnected(true);
    post('REMOTE_EVENT_CONNECTED', new URL(url).hostname);
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data === 'string') stream.pushText(ev.data);
    else stream.pushBinary(ev.data);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    avatar.setConnected(false);
    post('REMOTE_EVENT_DISCONNECTED', new URL(url).hostname);
    if (!wantConnected) return;
    // Plugin_Remote keeps retrying until the server is up
    setStatus('つながるのを待っています…', 'busy');
    retryTimer = window.setTimeout(connect, 2000);
  };
}

function disconnect() {
  wantConnected = false;
  window.clearTimeout(retryTimer);
  if (ws) {
    const host = (() => { try { return new URL(ws.url).hostname; } catch (_) { return ''; } })();
    ws.onclose = null;
    ws.close();
    ws = null;
    avatar.setConnected(false);
    post('REMOTE_EVENT_DISCONNECTED', host);
  }
  setStatus('切断', 'idle');
  elConnect.textContent = '接続';
}

// -------------------------------------------------------------------- UI

elFolder.addEventListener('change', () => {
  if (elFolder.files?.length) setFiles(elFolder.files);
});
elStart.addEventListener('click', () => {
  audio.ensureContext().catch(() => {});
  if (elMdf.value) startScene(elMdf.value).catch((err) => log(`シーンを始められません: ${err?.message || err}`));
});
elConnect.addEventListener('click', () => {
  audio.ensureContext().catch(() => {});
  if (wantConnected) disconnect();
  else connect();
});
elWs.addEventListener('change', () => store(`ws:${elMdf.value}`, elWs.value.trim()));
elMdf.addEventListener('change', () => {
  const saved = recall(`ws:${elMdf.value}`);
  if (saved) elWs.value = saved;
});
$('toggle-panel').addEventListener('click', () => {
  elPanel.classList.toggle('hidden');
  viewer.resize();
});
elViewport.addEventListener('pointerdown', () => audio.ensureContext().catch(() => {}));

// KEY|<key> like MMDAgent-EX (letters, digits and symbols)
window.addEventListener('keydown', (ev) => {
  const tag = /** @type {HTMLElement} */ (ev.target)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (ev.key === 'Escape') ui.cancel();
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (viewer.keyAction(ev.key, ev.shiftKey)) ev.preventDefault();
  if (ev.key === '/') ui.toggleMenu();
  if (ev.key === 'R' && elMdf.value) startScene(elMdf.value).catch((err) => log(`シーンを始められません: ${err?.message || err}`));
  if (ev.key.length !== 1) return;
  post('KEY', ev.key);
});

// drop a folder onto the page
document.addEventListener('dragover', (ev) => ev.preventDefault());
document.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  const items = Array.from(ev.dataTransfer?.items || []);
  /** @type {File[]} */
  const files = [];
  /** @param {any} entry @param {string} prefix */
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      Object.defineProperty(file, 'webkitRelativePath', { value: `${prefix}${file.name}` });
      files.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) await walk(entry, '');
  }
  if (files.length) setFiles(files);
});

setStatus('切断', 'idle');
elWs.value = 'ws://localhost:9001/chat';
log('MMDAgent-EX のコンテンツのフォルダーを選び、.mdf を選んで「開始」を押してください。');

// for debugging from the console
Object.assign(window, {
  mmdWeb: {
    post,
    viewer,
    /** Load files without the folder dialog (tests, embedding). @param {File[]} files */
    loadFiles: setFiles,
    /** @param {string} mdfPath */
    start: (mdfPath) => startScene(mdfPath),
    core,
    get model() { return core.models.values().next().value || null; },
    get keyValue() { return keyValue; },
    get bindings() { return bindings; },
    get fsts() { return fsts; },
    get avatar() { return avatar; },
  },
});
