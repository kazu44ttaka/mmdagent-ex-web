/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Plugin_Remote/Plugin_Remote.cpp (WebSocket settings)
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 */

/**
 * MMDAgent-EX `.mdf` (key=value settings) parser.
 *
 * Every entry also goes into the KeyValue store, as MMDAgent-EX does, so FST
 * scripts can read them with `${%key}`.
 */

/**
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseMdf(text) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out.set(key, value);
  }
  return out;
}

/**
 * The WebSocket URL Plugin_Remote would connect to for these settings.
 * Plugin_Remote's own defaults are localhost, port 80 and "/".
 * @param {Map<string, string>} mdf
 */
export function websocketUrlFromMdf(mdf) {
  const host = (mdf.get('Plugin_Remote_Websocket_Host') || 'localhost').trim() || 'localhost';
  const port = (mdf.get('Plugin_Remote_Websocket_Port') || '80').trim() || '80';
  let dir = (mdf.get('Plugin_Remote_Websocket_Directory') || '/').trim() || '/';
  if (!dir.startsWith('/')) dir = `/${dir}`;
  return `ws://${host}:${port}${dir}`;
}

/**
 * Read a boolean the way MMDAgent-EX does ("true"/"false"), with a fallback.
 * @param {Map<string, string>} mdf
 * @param {string} key
 * @param {boolean} fallback
 */
export function mdfBool(mdf, key, fallback) {
  const v = String(mdf.get(key) ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

/**
 * @param {Map<string, string>} mdf
 * @param {string} key
 * @param {number} fallback
 */
export function mdfFloat(mdf, key, fallback) {
  const n = Number(String(mdf.get(key) ?? '').trim());
  return Number.isFinite(n) && String(mdf.get(key) ?? '').trim() !== '' ? n : fallback;
}

/**
 * @param {Map<string, string>} mdf
 * @param {string} key
 * @param {number[]} fallback
 */
export function mdfVec(mdf, key, fallback) {
  const raw = String(mdf.get(key) ?? '').trim();
  if (!raw) return fallback;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length < fallback.length || !parts.slice(0, fallback.length).every(Number.isFinite)) return fallback;
  return parts.slice(0, fallback.length);
}
