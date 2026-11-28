/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Opening a scene from the page URL, so another program can start the viewer
 * with one link (MaAI-SDS does this from its main window):
 *
 *   index.html?content=<folder URL>&mdf=<path in the folder>&ws=<WebSocket URL>&connect=1
 *
 * - content: the content folder, served over HTTP. Its file list is
 *   `<content>files.json`: `{"files": ["gene/Gene.pmd", ...]}` (or a bare array),
 *   with paths relative to the folder.
 * - mdf: the .mdf to start, relative to the folder.
 * - ws: the WebSocket URL to connect to (overrides the one in the .mdf).
 * - connect: 1 to connect right after the scene starts.
 */

/** Name of the file list in the content folder. */
export const FILE_LIST_NAME = 'files.json';

/**
 * @param {string} search `location.search`
 * @param {string} pageUrl `location.href`, to resolve a relative `content`
 * @returns {{ content: string | null, mdf: string, ws: string, connect: boolean }}
 */
export function readLaunchParams(search, pageUrl) {
  const params = new URLSearchParams(search || '');
  const rawContent = (params.get('content') || '').trim();
  let content = null;
  if (rawContent) {
    try {
      content = new URL(rawContent, pageUrl).href;
      if (!content.endsWith('/')) content += '/';
    } catch (_) {
      content = null;
    }
  }
  const flag = (params.get('connect') || '').trim().toLowerCase();
  return {
    content,
    mdf: (params.get('mdf') || '').trim(),
    ws: (params.get('ws') || '').trim(),
    connect: flag === '1' || flag === 'true' || flag === 'yes',
  };
}

/**
 * Fetch the file list of a content folder served over HTTP.
 * @param {string} contentUrl folder URL ending with "/"
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string[]>}
 */
export async function loadFileList(contentUrl, fetchImpl = (...args) => fetch(...args)) {
  const url = new URL(FILE_LIST_NAME, contentUrl).href;
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data = await res.json();
  const files = Array.isArray(data) ? data : data?.files;
  if (!Array.isArray(files)) throw new Error(`${url}: "files" がありません`);
  return files.filter((p) => typeof p === 'string' && p);
}
