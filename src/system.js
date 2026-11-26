/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDAgent/src/lib/MMDAgent.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * The rest of MMDAgent-EX's core commands, done the browser way:
 *   OPEN_CONTENT|file.mdf          switch to another .mdf in the picked folder
 *   HOME_SET / HOME_CLEAR          remember the current .mdf as the one to open first
 *   MOTIONCAPTURE_START|model|file.vmd / MOTIONCAPTURE_STOP|model   record the pose and download a VMD
 *   REMOTEKEY_CHAR|c               a KEY|c event, as a key press
 *   TEXTURE_SETANIMATIONRATE, CONFIG_PARALLELSKINNING_THREADS, LOG_*   accepted, nothing to do here
 * Commands that act on the desktop window or files (TRANSPARENT_*, REMOTEKEY_DOWN/UP,
 * RECOG_RECORD_*, LOG_UPLOAD) have no browser counterpart.
 */

import { writeVmd } from './vmd.js';

/**
 * @typedef {{
 *   post: (type: string, args?: string) => void,
 *   log: (msg: string) => void,
 *   contentPath: (file: string) => string,
 *   vfs: () => import('./vfs.js').Vfs | null,
 *   openScene: (mdfPath: string) => void,
 *   currentScene: () => string,
 *   setHome: (mdfPath: string | null) => void,
 *   core: ReturnType<typeof import('./core.js').createCore>,
 * }} SystemHost
 */

const MAX_CAPTURE_FRAMES = 10 * 60 * 30; // PMDOBJECT_MAXCAPTUREDEFAULT minutes

/** @param {SystemHost} host */
export function createSystem(host) {
  /** @type {Map<string, { file: string, frame: number, acc: number, bones: any[], faces: any[] }>} */
  const captures = new Map();

  function download(name, bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name.split('/').pop() || 'capture.vmd';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function stopCapture(alias) {
    const c = captures.get(alias);
    if (!c) return false;
    captures.delete(alias);
    download(c.file, writeVmd({ bones: c.bones, faces: c.faces }));
    host.log(`${alias} のモーションを ${c.file} として保存しました（${c.frame} フレーム）`);
    return true;
  }

  const handles = new Set(['OPEN_CONTENT', 'HOME_SET', 'HOME_CLEAR', 'MOTIONCAPTURE_START', 'MOTIONCAPTURE_STOP', 'REMOTEKEY_CHAR',
    'TEXTURE_SETANIMATIONRATE', 'CONFIG_PARALLELSKINNING_THREADS', 'LOG_START', 'LOG_FINISH']);

  return {
    name: 'System',
    handles,
    handle(type, args, argv) {
      switch (type) {
        case 'OPEN_CONTENT': {
          const path = host.vfs()?.realPath(host.contentPath(args));
          if (path && /\.mdf$/i.test(path)) setTimeout(() => host.openScene(path), 0);
          else host.log(`OPEN_CONTENT: 開ける .mdf がありません: ${args}`);
          return;
        }
        case 'HOME_SET':
          host.setHome(host.currentScene());
          return;
        case 'HOME_CLEAR':
          host.setHome(null);
          return;
        case 'MOTIONCAPTURE_START': {
          if (argv.length !== 2 || !host.core.get(argv[0])) return;
          captures.set(argv[0], { file: argv[1], frame: 0, acc: 1, bones: [], faces: [] });
          return;
        }
        case 'MOTIONCAPTURE_STOP':
          if (argv.length === 1) stopCapture(argv[0]);
          return;
        case 'REMOTEKEY_CHAR':
          if (args) host.post('KEY', args);
          return;
        default:
      }
    },
    /** Record one key frame per 30 fps frame. @param {number} frames */
    update(frames) {
      for (const [alias, c] of captures) {
        const model = host.core.get(alias);
        if (!model) {
          captures.delete(alias);
          continue;
        }
        c.acc += frames;
        while (c.acc >= 1) {
          c.acc -= 1;
          for (const b of model.pose.bones) c.bones.push({ name: b.name, frame: c.frame, pos: b.pos, rot: b.rot });
          for (const f of model.pose.faces) c.faces.push({ name: f.name, frame: c.frame, weight: f.weight });
          c.frame += 1;
        }
        if (c.frame >= MAX_CAPTURE_FRAMES) stopCapture(alias);
      }
    },
    reset() {
      captures.clear();
    },
  };
}
