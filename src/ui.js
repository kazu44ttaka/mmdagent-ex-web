/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDAgent/src/lib/Menu.cpp
 *   Library_MMDAgent/src/lib/Prompt.cpp
 *   Library_MMDAgent/src/lib/InfoText.cpp
 *   Library_MMDAgent/src/lib/Caption.cpp
 *   Library_MMDAgent/src/lib/Button.cpp
 *   Library_MMDAgent/src/lib/Stage.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * MMDAgent-EX's on-screen parts, drawn as HTML over the 3D view:
 *   MENU|ADD / DELETE / SETITEM / DELETEITEM     menus whose items issue messages
 *   PROMPT_SHOW|text|label|...                    a choice → PROMPT_EVENT_SELECTED|n (-1 if closed)
 *   INFOTEXT_STRING / INFOTEXT_FILE               a text panel with buttons → INFOTEXT_EVENT_CLOSE|label
 *   CAPTION_SETSTYLE / CAPTION_START / CAPTION_STOP  captions with styles and durations
 *   BUTTON_ADD / BUTTON_DELETE                    image buttons that issue a message → BUTTON_EVENT_EXEC
 *   WINDOWFRAME(_ADD/_DELETE/_DELETEALL)          full-window frame images
 *   WINDOWOVERLAY_ADD / DELETE / DELETEALL / HIDE / SHOW   overlay images placed by orientation
 * Events and argument checks follow MMDAgent.cpp, Menu.cpp, Prompt.cpp,
 * InfoText.cpp, Caption.cpp, Button.cpp and Stage.cpp. The look is MMDAgent-EX's
 * colours in HTML, not its exact drawing.
 */

/**
 * @typedef {{
 *   post: (type: string, args?: string) => void,
 *   log: (msg: string) => void,
 *   vfs: () => import('./vfs.js').Vfs | null,
 *   contentPath: (file: string) => string,
 *   root: HTMLElement,
 * }} UiHost
 */

const css = `
.mmd-ui { position: absolute; inset: 0; pointer-events: none; font-family: "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", sans-serif; overflow: hidden; }
.mmd-ui > * { pointer-events: auto; }
.mmd-frame, .mmd-overlay { position: absolute; pointer-events: none; }
.mmd-frame { inset: 0; width: 100%; height: 100%; object-fit: fill; }
.mmd-caption { position: absolute; left: 0; right: 0; padding: 0 4%; pointer-events: none; white-space: pre-wrap; line-height: 1.25; transition: opacity .3s; }
.mmd-caption span { padding: .05em .3em; border-radius: .2em; }
.mmd-dialog { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: 90%; max-height: 85%; overflow: auto;
  background: rgba(77, 51, 153, .8); color: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
.mmd-dialog p { margin: 0 0 12px; white-space: pre-wrap; font-size: 16px; }
.mmd-dialog .labels { display: flex; flex-direction: column; gap: 6px; }
.mmd-dialog button { font: inherit; font-size: 15px; padding: 8px 12px; border: 0; border-radius: 6px; background: rgba(255,255,255,.8); color: #000; cursor: pointer; text-align: left; }
.mmd-dialog button:hover { background: rgba(255, 204, 77, .9); }
.mmd-info { background: rgba(0,0,0,.53); border: 2px solid rgba(76,204,255,.8); }
.mmd-info h3 { margin: 0 0 8px; font-size: 16px; color: rgba(178,229,255,1); }
.mmd-info .labels { flex-direction: row; justify-content: flex-end; margin-top: 12px; }
.mmd-menu-toggle { position: absolute; left: 12px; top: 12px; width: 36px; height: 36px; border: 0; border-radius: 6px; background: rgba(20,23,31,.7); color: #fff; font-size: 18px; cursor: pointer; }
.mmd-menu { position: absolute; left: 12px; top: 56px; min-width: 200px; max-height: 70%; overflow: auto; background: rgba(20,23,31,.92); color: #fff; border-radius: 8px; padding: 6px; font-size: 14px; }
.mmd-menu h4 { margin: 6px 6px 2px; font-size: 12px; color: #9aa1b1; }
.mmd-menu button { display: block; width: 100%; text-align: left; font: inherit; padding: 6px 8px; border: 0; border-radius: 4px; background: none; color: inherit; cursor: pointer; }
.mmd-menu button:hover { background: rgba(90,162,255,.25); }
.mmd-button { position: absolute; border: 0; padding: 0; background: none; cursor: pointer; }
.mmd-button img { display: block; width: 100%; height: 100%; object-fit: contain; }
`;

const rgba = (v) => `rgba(${Math.round(v[0] * 255)},${Math.round(v[1] * 255)},${Math.round(v[2] * 255)},${v[3] ?? 1})`;
const fvec = (s, n) => {
  const p = String(s ?? '').split(',').map((x) => Number(x.trim()));
  return p.length === n && p.every(Number.isFinite) ? p : null;
};
/** "RRGGBB" or "RRGGBBAA" (InfoText colours) */
const hexColor = (s, fallback) => {
  const m = /^([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(s || ''));
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

/** @param {UiHost} host */
export function createUi(host) {
  if (!document.getElementById('mmd-ui-style')) {
    const style = document.createElement('style');
    style.id = 'mmd-ui-style';
    style.textContent = css;
    document.head.appendChild(style);
  }
  const layer = document.createElement('div');
  layer.className = 'mmd-ui';
  host.root.appendChild(layer);
  const el = (tag, cls, parent = layer) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    parent.appendChild(e);
    return e;
  };
  const fileUrl = (file) => host.vfs()?.url(host.contentPath(file)) || null;

  // ------------------------------------------------------------------ menu
  /** @type {Map<string, { items: Map<number, { label: string, type: string, args: string }> }>} */
  const menus = new Map();
  let menuOpen = false;
  const menuToggle = el('button', 'mmd-menu-toggle');
  menuToggle.textContent = '≡';
  menuToggle.title = 'メニュー';
  menuToggle.style.display = 'none';
  const menuBox = el('div', 'mmd-menu');
  menuBox.style.display = 'none';
  function renderMenu() {
    menuToggle.style.display = menus.size ? '' : 'none';
    menuBox.style.display = menuOpen && menus.size ? '' : 'none';
    menuBox.innerHTML = '';
    for (const [name, m] of menus) {
      el('h4', '', menuBox).textContent = name;
      for (const n of Array.from(m.items.keys()).sort((a, b) => a - b)) {
        const item = m.items.get(n);
        const b = el('button', '', menuBox);
        b.textContent = item.label;
        b.addEventListener('click', () => {
          menuOpen = false;
          renderMenu();
          host.post(item.type, item.args);
        });
      }
    }
  }
  menuToggle.addEventListener('click', () => {
    menuOpen = !menuOpen;
    renderMenu();
  });

  // ---------------------------------------------------------------- prompt
  /** @type {HTMLElement | null} */
  let prompt = null;
  function closePrompt(selected) {
    if (!prompt) return;
    prompt.remove();
    prompt = null;
    host.post('PROMPT_EVENT_SELECTED', String(selected));
  }

  // -------------------------------------------------------------- infotext
  /** @type {HTMLElement | null} */
  let info = null;
  function showInfo(text, title, labels, scale, bg, fg) {
    info?.remove();
    info = el('div', 'mmd-dialog mmd-info');
    info.style.background = hexColor(bg, 'rgba(0,0,0,.53)');
    info.style.color = hexColor(fg, '#fff');
    info.style.fontSize = `${16 * scale}px`;
    el('h3', '', info).textContent = title;
    const p = el('p', '', info);
    p.textContent = text;
    const box = el('div', 'labels', info);
    const names = String(labels || '').split(',').filter(Boolean);
    (names.length ? names : ['OK']).forEach((label) => {
      const b = el('button', '', box);
      b.textContent = label;
      b.addEventListener('click', () => {
        info?.remove();
        info = null;
        host.post('INFOTEXT_EVENT_CLOSE', label);
      });
    });
    host.post('INFOTEXT_EVENT_SHOW', '');
  }

  // --------------------------------------------------------------- caption
  /** @type {Map<string, { font: string | null, color: number[], edge1: number[] | null, edge2: number[] | null, base: number[] | null }>} */
  const styles = new Map();
  /** @type {Map<string, { el: HTMLElement, timer: number }>} */
  const captions = new Map();
  function stopCaption(alias, issue = true) {
    const c = captions.get(alias);
    if (!c) return false;
    window.clearTimeout(c.timer);
    c.el.remove();
    captions.delete(alias);
    if (issue) host.post('CAPTION_EVENT_STOP', alias);
    return true;
  }

  // ---------------------------------------------------------------- frames
  /** @type {Map<string, HTMLImageElement>} */
  const frames = new Map();
  /** @type {Map<string, { img: HTMLImageElement, w: number, h: number, orient: string, pad: number }>} */
  const overlays = new Map();
  function placeOverlay(o) {
    const W = layer.clientWidth || 1;
    const H = layer.clientHeight || 1;
    const aspect = (o.img.naturalHeight || 1) / (o.img.naturalWidth || 1);
    const w1 = o.w * W;
    const h1 = w1 * aspect;
    const h2 = o.h * H;
    const w2 = h2 / aspect;
    let w;
    let h;
    if (w1 < w2) { w = o.w; h = h1 / H; } else { h = o.h; w = w2 / W; }
    const left = ['LEFT_TOP', 'TOP_LEFT', 'LEFT_BOTTOM', 'BOTTOM_LEFT'].includes(o.orient);
    const bottom = ['RIGHT_BOTTOM', 'BOTTOM_RIGHT', 'LEFT_BOTTOM', 'BOTTOM_LEFT'].includes(o.orient);
    let x;
    let y;
    if (o.orient === 'CENTER') { x = (1 - w) / 2; y = (1 - h) / 2; } else {
      x = left ? o.pad : 1 - o.pad - w;
      y = bottom ? o.pad : 1 - o.pad - h;
    }
    Object.assign(o.img.style, { left: `${x * 100}%`, bottom: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
  }
  new ResizeObserver(() => { for (const o of overlays.values()) placeOverlay(o); }).observe(layer);

  // --------------------------------------------------------------- buttons
  /** @type {Map<string, HTMLElement>} */
  const buttons = new Map();

  const handles = new Set(['MENU', 'PROMPT_SHOW', 'INFOTEXT_STRING', 'INFOTEXT_FILE', 'CAPTION_SETSTYLE', 'CAPTION_START', 'CAPTION_STOP',
    'BUTTON_ADD', 'BUTTON_DELETE', 'WINDOWFRAME', 'WINDOWFRAME_ADD', 'WINDOWFRAME_DELETE', 'WINDOWFRAME_DELETEALL',
    'WINDOWOVERLAY_ADD', 'WINDOWOVERLAY_DELETE', 'WINDOWOVERLAY_DELETEALL', 'WINDOWOVERLAY_HIDE', 'WINDOWOVERLAY_SHOW']);

  function addFrame(alias, file) {
    const url = fileUrl(file);
    if (!url) return false;
    frames.get(alias)?.remove();
    const img = el('img', 'mmd-frame');
    img.src = url;
    frames.set(alias, img);
    host.post('WINDOWFRAME_EVENT_ADD', alias);
    return true;
  }

  return {
    name: 'UI',
    handles,
    /** @param {string} type @param {string} args @param {string[]} argv */
    handle(type, args, argv) {
      const num = argv.length;
      switch (type) {
        case 'MENU': {
          // MENU|ADD|alias[|...], MENU|DELETE|alias, MENU|SETITEM|alias|n|label|TYPE|args, MENU|DELETEITEM|alias|n
          const parts = args.split('|');
          const cmd = parts[0];
          if (cmd === 'ADD' && parts.length >= 2 && parts.length <= 3 && !menus.has(parts[1])) {
            menus.set(parts[1], { items: new Map() });
            host.post('MENU_EVENT', `ADD|${parts[1]}`);
          } else if (cmd === 'DELETE' && parts.length === 2 && menus.delete(parts[1])) {
            host.post('MENU_EVENT', `DELETE|${parts[1]}`);
          } else if (cmd === 'SETITEM' && parts.length >= 5) {
            const m = menus.get(parts[1]);
            if (!m) break;
            const n = parseInt(parts[2], 10) || 0;
            m.items.set(n, { label: parts[3], type: parts[4], args: parts.slice(5).join('|') });
            host.post('MENU_EVENT', `SETITEM|${parts[1]}|${parts[2]}`);
          } else if (cmd === 'DELETEITEM' && parts.length === 3) {
            const m = menus.get(parts[1]);
            if (m?.items.delete(parseInt(parts[2], 10) || 0)) host.post('MENU_EVENT', `DELETEITEM|${parts[1]}|${parts[2]}`);
          }
          renderMenu();
          return;
        }
        case 'PROMPT_SHOW': {
          if (num < 2) return;
          prompt?.remove();
          prompt = el('div', 'mmd-dialog');
          el('p', '', prompt).textContent = argv[0].replace(/\\n/g, '\n');
          const box = el('div', 'labels', prompt);
          argv.slice(1).forEach((label, i) => {
            const b = el('button', '', box);
            b.textContent = label;
            b.addEventListener('click', () => closePrompt(i));
          });
          return;
        }
        case 'INFOTEXT_STRING':
          if (num >= 3 && num <= 6) showInfo(argv[0].replace(/\\n/g, '\n'), argv[1], argv[2], num >= 4 ? parseFloat(argv[3]) || 1 : 1, argv[4], argv[5]);
          return;
        case 'INFOTEXT_FILE':
          if (num >= 3 && num <= 6) {
            host.vfs()?.text(host.contentPath(argv[0])).then((t) => {
              if (t != null) showInfo(t, argv[1], argv[2], num >= 4 ? parseFloat(argv[3]) || 1 : 1, argv[4], argv[5]);
            });
          }
          return;
        case 'CAPTION_SETSTYLE': {
          if (num !== 3 && num !== 6) return;
          const color = fvec(argv[2], 4);
          if (!color) return;
          const edge1 = num === 6 ? fvec(argv[3], 5) : null;
          const edge2 = num === 6 ? fvec(argv[4], 5) : null;
          const base = num === 6 ? fvec(argv[5], 4) : null;
          if (num === 6 && (!edge1 || !edge2 || !base)) return;
          styles.set(argv[0], { font: argv[1] === 'default' ? null : argv[1], color, edge1, edge2, base });
          host.post('CAPTION_EVENT_SETSTYLE', argv[0]);
          return;
        }
        case 'CAPTION_START': {
          // alias|style|text|size|align|height|duration
          if (num !== 7) return;
          const [alias, styleName, text, size, align, height, duration] = argv;
          if (!['CENTER', 'LEFT', 'RIGHT'].includes(align)) return;
          const st = styles.get(styleName) || { font: null, color: [1, 1, 1, 1], edge1: [0, 0, 0, 1, 4], edge2: null, base: null };
          stopCaption(alias, false);
          const c = el('div', 'mmd-caption');
          c.style.bottom = `${(parseFloat(height) || 0) * 100}%`;
          c.style.textAlign = align.toLowerCase();
          c.style.fontSize = `${(parseFloat(size) || 1) * 2.4}vh`;
          const span = el('span', '', c);
          span.textContent = text.replace(/\\n/g, '\n');
          span.style.color = rgba(st.color);
          const shadows = [];
          if (st.edge1) shadows.push(`0 0 ${st.edge1[4] * 0.6}px ${rgba(st.edge1)}`, `0 0 ${st.edge1[4] * 0.3}px ${rgba(st.edge1)}`);
          if (st.edge2) shadows.push(`0 0 ${st.edge2[4] * 0.6}px ${rgba(st.edge2)}`);
          span.style.textShadow = shadows.join(',');
          if (st.base) span.style.background = rgba(st.base);
          const sec = parseFloat(duration) || 0;
          const timer = sec > 0 ? window.setTimeout(() => stopCaption(alias), sec * 1000) : 0;
          captions.set(alias, { el: c, timer });
          host.post('CAPTION_EVENT_START', alias);
          return;
        }
        case 'CAPTION_STOP':
          if (num === 1) stopCaption(argv[0]);
          return;
        case 'BUTTON_ADD': {
          // alias|scale|x,y|image|action|ON/OFF(autoclose)
          if (num !== 6 || buttons.has(argv[0])) return;
          const coord = fvec(argv[2], 2);
          if (!coord || (argv[5] !== 'ON' && argv[5] !== 'OFF')) return;
          const url = fileUrl(argv[3]);
          if (!url) return;
          const scale = parseFloat(argv[1]) || 1;
          const b = el('button', 'mmd-button');
          const img = el('img', '', b);
          img.src = url;
          // button units: 1 unit = 5% of the window height, from the top-left corner
          Object.assign(b.style, { left: `${coord[0] * 5}vh`, top: `${coord[1] * 5}vh`, width: `${scale * 5}vh`, height: `${scale * 5}vh` });
          const action = argv[4];
          b.addEventListener('click', () => {
            const i = action.indexOf('|');
            host.post(i < 0 ? action : action.slice(0, i), i < 0 ? '' : action.slice(i + 1));
            host.post('BUTTON_EVENT_EXEC', argv[0]);
            if (argv[5] === 'ON') {
              b.remove();
              buttons.delete(argv[0]);
              host.post('BUTTON_EVENT_DELETE', argv[0]);
            }
          });
          buttons.set(argv[0], b);
          host.post('BUTTON_EVENT_ADD', argv[0]);
          return;
        }
        case 'BUTTON_DELETE': {
          const b = buttons.get(argv[0]);
          if (!b) return;
          b.remove();
          buttons.delete(argv[0]);
          host.post('BUTTON_EVENT_DELETE', argv[0]);
          return;
        }
        case 'WINDOWFRAME':
          if (num !== 1) return;
          for (const [alias, img] of frames) { img.remove(); host.post('WINDOWFRAME_EVENT_DELETE', alias); }
          frames.clear();
          addFrame('_default', argv[0]);
          return;
        case 'WINDOWFRAME_ADD':
          if (num === 2) addFrame(argv[0], argv[1]);
          return;
        case 'WINDOWFRAME_DELETE': {
          const img = frames.get(argv[0]);
          if (!img) return;
          img.remove();
          frames.delete(argv[0]);
          host.post('WINDOWFRAME_EVENT_DELETE', argv[0]);
          return;
        }
        case 'WINDOWFRAME_DELETEALL':
          for (const [alias, img] of frames) { img.remove(); host.post('WINDOWFRAME_EVENT_DELETE', alias); }
          frames.clear();
          return;
        case 'WINDOWOVERLAY_ADD': {
          // alias|file|width_rate|height_rate|orientation|padding_rate
          if (num !== 6) return;
          const url = fileUrl(argv[1]);
          if (!url) return;
          overlays.get(argv[0])?.img.remove();
          const img = el('img', 'mmd-overlay');
          const o = { img, w: parseFloat(argv[2]) || 1, h: parseFloat(argv[3]) || 1, orient: argv[4], pad: parseFloat(argv[5]) || 0 };
          img.onload = () => placeOverlay(o);
          img.src = url;
          overlays.set(argv[0], o);
          host.post('WINDOWOVERLAY_EVENT_ADD', argv[0]);
          return;
        }
        case 'WINDOWOVERLAY_DELETE': {
          const o = overlays.get(argv[0]);
          if (!o) return;
          o.img.remove();
          overlays.delete(argv[0]);
          host.post('WINDOWOVERLAY_EVENT_DELETE', argv[0]);
          return;
        }
        case 'WINDOWOVERLAY_DELETEALL':
          for (const [alias, o] of overlays) { o.img.remove(); host.post('WINDOWOVERLAY_EVENT_DELETE', alias); }
          overlays.clear();
          return;
        case 'WINDOWOVERLAY_HIDE':
        case 'WINDOWOVERLAY_SHOW': {
          const o = overlays.get(argv[0]);
          if (!o) return;
          const show = type === 'WINDOWOVERLAY_SHOW';
          o.img.style.display = show ? '' : 'none';
          host.post(show ? 'WINDOWOVERLAY_EVENT_SHOW' : 'WINDOWOVERLAY_EVENT_HIDE', argv[0]);
          return;
        }
        default:
      }
    },
    /** "/" shows the menu. */
    toggleMenu() {
      menuOpen = !menuOpen;
      renderMenu();
    },
    /** Esc closes a prompt with -1, as MMDAgent-EX does. */
    cancel() {
      if (prompt) closePrompt(-1);
    },
    reset() {
      menus.clear();
      menuOpen = false;
      renderMenu();
      prompt?.remove();
      prompt = null;
      info?.remove();
      info = null;
      for (const a of Array.from(captions.keys())) stopCaption(a, false);
      styles.clear();
      for (const b of buttons.values()) b.remove();
      buttons.clear();
      for (const f of frames.values()) f.remove();
      frames.clear();
      for (const o of overlays.values()) o.img.remove();
      overlays.clear();
    },
  };
}
