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
 *   <model>.csv          material and vertex-edge settings (PMDModel::parseExtCsv)
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
 * @typedef {{
 *   name: string, alpha: number, face: boolean, shadow: boolean,
 *   shadowMapDrop: boolean, shadowMapRender: boolean,
 *   edge: boolean, edgeWidth: number, edgeColor: number[],
 *   tex: string | null, sphere: string | null, sphereMode: number,
 * }} CsvMaterial
 */

/**
 * The parts of a model CSV (PMXEditor / PMDEditor export) that MMDAgent-EX
 * applies to the look (PMDModel::parseExtCsv): Material rows and the edge rate
 * of Vertex rows. Lines are scanned as bytes; only Material and header lines are
 * decoded (Gene's CSV is 12 MB, mostly vertices).
 * @param {Uint8Array} bytes
 * @returns {{ materials: CsvMaterial[], vertexEdge: Array<[number, number]> }}
 */
export function parseModelCsv(bytes) {
  const startsWith = (pos, prefix) => {
    for (let i = 0; i < prefix.length; i += 1) if (bytes[pos + i] !== prefix.charCodeAt(i)) return false;
    return true;
  };
  let utf8 = null;
  const decode = (from, to) => {
    const chunk = bytes.subarray(from, to);
    if (utf8 !== false) {
      try {
        const s = new TextDecoder('utf-8', { fatal: true }).decode(chunk);
        utf8 = true;
        return s;
      } catch (_) {
        if (utf8 === true) return new TextDecoder('utf-8').decode(chunk);
        utf8 = false;
      }
    }
    return new TextDecoder('shift_jis').decode(chunk);
  };
  let recent = false;
  /** @type {string[]} */
  const materialRows = [];
  /** @type {Array<[number, number]>} */
  const vertexEdge = [];
  let pos = 0;
  while (pos < bytes.length) {
    let end = bytes.indexOf(10, pos);
    if (end < 0) end = bytes.length;
    const lineEnd = end > pos && bytes[end - 1] === 13 ? end - 1 : end;
    if (startsWith(pos, 'Vertex,') || startsWith(pos, 'PmxVertex,')) {
      // fields 1 (index) and 8 (edge rate) are plain numbers
      let field = 0;
      let from = pos;
      let idx = -1;
      for (let i = pos; i <= lineEnd; i += 1) {
        if (i === lineEnd || bytes[i] === 44) {
          if (field === 1) idx = Number(String.fromCharCode(...bytes.subarray(from, i)));
          if (field === 8) {
            const rate = Number(String.fromCharCode(...bytes.subarray(from, i)));
            if (idx >= 0 && Number.isFinite(rate)) vertexEdge.push([idx, rate]);
            break;
          }
          field += 1;
          from = i + 1;
        }
      }
    } else if (startsWith(pos, 'Material,') || startsWith(pos, 'PmxMaterial,')) {
      materialRows.push(decode(pos, lineEnd));
    } else if (startsWith(pos, ';PmxHeader')) {
      recent = true;
    } else if (startsWith(pos, ';Material,') || startsWith(pos, ';Bone,') || startsWith(pos, ';Joint,')) {
      // a recent PMXEditor writes more columns; the header row tells
      const n = splitCsvRow(decode(pos, lineEnd)).length;
      if (startsWith(pos, ';Material,') && n >= 31) recent = true;
      if (startsWith(pos, ';Bone,') && n >= 40) recent = true;
      if (startsWith(pos, ';Joint,') && n >= 30) recent = true;
    }
    pos = end + 1;
  }
  const o = recent ? 2 : 0;
  const materials = materialRows.map((line) => {
    const row = splitCsvRow(line);
    const num = (k, def) => {
      const v = row[k] === undefined || row[k] === '' ? NaN : Number(row[k]);
      return Number.isFinite(v) ? v : def;
    };
    const flag = (k) => num(k, 0) !== 0;
    return {
      name: row[1] || '',
      alpha: num(6, 1),
      face: flag(14),
      shadow: flag(15),
      shadowMapDrop: flag(16),
      shadowMapRender: flag(17),
      edge: flag(18 + o),
      edgeWidth: num(19 + o, 1),
      edgeColor: [num(20 + o, 0), num(21 + o, 0), num(22 + o, 0), num(23 + o, 0)],
      tex: row[24 + o] || null,
      sphere: row[25 + o] || null,
      sphereMode: num(26 + o, 0),
    };
  });
  return { materials, vertexEdge };
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
