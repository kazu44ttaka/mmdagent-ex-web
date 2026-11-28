/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A read-only file tree for MMDAgent-EX content picked in the browser.
 *
 * MMDAgent-EX runs on Windows, where paths are case-insensitive and may use
 * backslashes, so content often says `gene/gene.pmd` for `gene/Gene.pmd`.
 * Lookups here are therefore case-insensitive and accept both separators.
 */

/**
 * Normalize a relative path: `\` → `/`, drop `.` and empty segments, resolve `..`.
 * Leading `..` that would climb above the root are dropped.
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  const out = [];
  for (const part of String(path || '').replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/** @param {string} path */
export function dirname(path) {
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** @param {string} path */
export function basename(path) {
  const p = normalizePath(path);
  return p.slice(p.lastIndexOf('/') + 1);
}

/**
 * Join a path relative to `baseDir` (both relative to the tree root).
 * @param {string} baseDir
 * @param {string} rel
 */
export function joinPath(baseDir, rel) {
  return normalizePath(`${baseDir || ''}/${rel || ''}`);
}

/**
 * Decode text the way MMDAgent-EX content is usually written: UTF-8, or
 * Shift_JIS (cp932) for older files.
 * @param {ArrayBuffer | Uint8Array} bytes
 * @returns {string}
 */
export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let start = 0;
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) start = 3;
  const body = u8.subarray(start);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (_) {
    return new TextDecoder('shift_jis').decode(body);
  }
}

/**
 * @typedef {{ path: string, file: Blob }} VfsEntry
 */

/**
 * Build a tree from picked files. `path` is relative to the picked folder.
 * When every path starts with the same top folder (what `webkitdirectory`
 * gives), that folder is kept: paths are resolved from the picked folder's parent.
 * @param {VfsEntry[]} entries
 */
export function createVfs(entries) {
  /** @type {Map<string, VfsEntry>} lower-case key → entry */
  const map = new Map();
  for (const entry of entries || []) {
    const path = normalizePath(entry.path);
    if (!path) continue;
    map.set(path.toLowerCase(), { path, file: entry.file });
  }
  /** @type {Map<string, string>} */
  const urls = new Map();

  /** @param {string} path */
  function find(path) {
    return map.get(normalizePath(path).toLowerCase()) || null;
  }

  return {
    size: map.size,
    /** @param {string} path */
    has(path) {
      return find(path) !== null;
    },
    /** Actual spelling of a path, or null. @param {string} path */
    realPath(path) {
      return find(path)?.path ?? null;
    },
    /** @param {string} path */
    file(path) {
      return find(path)?.file ?? null;
    },
    /** All paths, sorted. */
    list() {
      return Array.from(map.values(), (e) => e.path).sort();
    },
    /**
     * A blob: URL for the file (cached for the life of the tree), or null.
     * @param {string} path
     */
    url(path) {
      const entry = find(path);
      if (!entry) return null;
      const key = entry.path.toLowerCase();
      let url = urls.get(key);
      if (!url) {
        url = URL.createObjectURL(entry.file);
        urls.set(key, url);
      }
      return url;
    },
    /** @param {string} path */
    async text(path) {
      const entry = find(path);
      if (!entry) return null;
      return decodeText(await entry.file.arrayBuffer());
    },
    /** @param {string} path */
    async bytes(path) {
      const entry = find(path);
      if (!entry) return null;
      return new Uint8Array(await entry.file.arrayBuffer());
    },
    /** Revoke every blob: URL handed out. */
    dispose() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}

/** @typedef {ReturnType<typeof createVfs>} Vfs */

/**
 * The URL of a file under `baseUrl`, with each path segment percent-encoded.
 * @param {string} baseUrl folder URL ending with "/"
 * @param {string} path relative path
 */
export function fileUrl(baseUrl, path) {
  const encoded = normalizePath(path).split('/').map(encodeURIComponent).join('/');
  return new URL(encoded, baseUrl).href;
}

/**
 * The same tree as `createVfs`, for content served over HTTP: `paths` lists
 * the files (relative to `baseUrl`), and each file is fetched when it is read.
 * A launcher such as MaAI-SDS serves the content folder and its file list, so
 * the page can open a scene without the folder dialog.
 * @param {string} baseUrl folder URL; a trailing "/" is added when missing
 * @param {string[]} paths
 * @param {typeof fetch} [fetchImpl]
 */
export function createHttpVfs(baseUrl, paths, fetchImpl = (...args) => fetch(...args)) {
  const base = String(baseUrl).endsWith('/') ? String(baseUrl) : `${baseUrl}/`;
  /** @type {Map<string, string>} lower-case key → actual spelling */
  const map = new Map();
  for (const raw of paths || []) {
    const path = normalizePath(raw);
    if (path) map.set(path.toLowerCase(), path);
  }

  /** @param {string} path */
  function find(path) {
    return map.get(normalizePath(path).toLowerCase()) ?? null;
  }

  /** @param {string} path */
  async function get(path) {
    const real = find(path);
    if (real === null) return null;
    const res = await fetchImpl(fileUrl(base, real));
    if (!res.ok) throw new Error(`${real}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  return {
    size: map.size,
    /** @param {string} path */
    has(path) {
      return find(path) !== null;
    },
    /** Actual spelling of a path, or null. @param {string} path */
    realPath(path) {
      return find(path);
    },
    /** Files are not held in memory here. @param {string} _path */
    file(_path) {
      return null;
    },
    /** All paths, sorted. */
    list() {
      return Array.from(map.values()).sort();
    },
    /** The file's HTTP URL, or null. @param {string} path */
    url(path) {
      const real = find(path);
      return real === null ? null : fileUrl(base, real);
    },
    /** @param {string} path */
    async text(path) {
      const bytes = await get(path);
      return bytes === null ? null : decodeText(bytes);
    },
    /** @param {string} path */
    async bytes(path) {
      return get(path);
    },
    dispose() {},
  };
}
