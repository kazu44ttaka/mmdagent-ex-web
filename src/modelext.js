/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDFiles/src/lib/PMDModel.cpp (parseExtCsv)
 *   Library_MMDAgent/src/lib/PMDObject.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * Extra model files MMDAgent-EX reads next to a .pmd / .pmx:
 *   <model>.csv          material opacities (PMDModel::parseExtCsv, "Material" rows)
 *   <model>.shapemap     lip / expression / action settings (shapemap.js)
 *   <model>.loadmessage  messages issued after the model is loaded
 */

/**
 * Split one CSV row (PMDEditor format: comma separated, "quoted" fields).
 * @param {string} line
 */
export function splitCsvRow(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Material opacities from a model CSV. Only the Material section is decoded
 * (Gene's CSV is 12 MB, mostly vertices).
 * @param {Uint8Array} bytes
 * @returns {Array<{ name: string, opacity: number }>}
 */
export function parseMaterialCsv(bytes) {
  const find = (needle, from) => {
    const n = new TextEncoder().encode(needle);
    for (let i = bytes.indexOf(n[0], from); i >= 0 && i <= bytes.length - n.length; i = bytes.indexOf(n[0], i + 1)) {
      let j = 1;
      while (j < n.length && bytes[i + j] === n[j]) j += 1;
      if (j === n.length) return i;
    }
    return -1;
  };
  let start = find('\nMaterial,', 0);
  if (start >= 0) start += 1;
  else if (find('Material,', 0) === 0) start = 0;
  else {
    const pmx = find('\nPmxMaterial,', 0);
    start = pmx >= 0 ? pmx + 1 : -1;
  }
  if (start < 0) return [];
  let end = find('\nFace,', start);
  if (end < 0) end = Math.min(bytes.length, start + 80000);
  const chunk = bytes.subarray(start, end);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(chunk);
  } catch (_) {
    text = new TextDecoder('shift_jis').decode(chunk);
  }
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    const row = splitCsvRow(raw);
    if (row[0] !== 'Material' && row[0] !== 'PmxMaterial') continue;
    const opacity = Number(row[6]);
    out.push({ name: row[1] || '', opacity: Number.isFinite(opacity) ? opacity : 1 });
  }
  return out;
}

/**
 * Messages in a .loadmessage / .deletemessage file, one "TYPE|args" per line.
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
export function parseMessageLines(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('|');
    out.push(i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)]);
  }
  return out;
}
