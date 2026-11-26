/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDAgent/src/lib/ShapeMap.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 */

/**
 * Parser for MMDAgent-EX's `.shapemap` config file format.
 *
 * This is a from-scratch reimplementation based on reading the real parser
 * (`ShapeMap::load` in MMDAgent-EX's Library_MMDAgent/src/lib/ShapeMap.cpp) —
 * no MMDAgent-EX code is copied. Only the sections relevant to the morph
 * commands this viewer actually receives (`__AV_AU`, `__AV_ARKit`,
 * `__AV_EXMORPH`) plus LIP_A/I/U/O (mouth morphs for lip sync) are parsed into
 * structured data; other sections (NOLIP, TRACK_*, EXBONE_, ACT*, MORPH_TUNE)
 * are recognized so they don't get misparsed as ARKit shapes.
 *
 * File grammar (tokens are split on runs of spaces, matching the original
 * `strtok(buf, " \r\n")` — tabs are NOT delimiters):
 *   # or ## ...                     comment (first token starts with '#')
 *   EYE_ROTATION_COEF <float>
 *   LIP_<X> <morphName>             A/I/U/O mouth morphs for lip sync
 *   NOLIP <name,name,...>           morphs held at 0 while the mouth moves
 *   TRACK_<X> <bone,bone,...>       (ignored here)
 *   AU<n> <morphName> [>thres | coef]
 *   ACT<n> <motionFile>             motion played by __AV_ACTION,<n>
 *   EXBONE_<X> <bone,bone,...>      (ignored here)
 *   EXMORPH_<name> <morphName> [>thres | coef]
 *   MORPH_TUNE <morph> <morph> ...  (ignored here)
 *   <anything else> <morphName> [>thres | coef]   -- ARKit / generic shape key
 *
 * `>thres`: value >= thres maps to weight 1.0, else 0.0 (binary gate).
 * bare `coef`: weight = value * coef (linear scale).
 * no third token: weight = value * 1.0 (pass-through).
 *
 * The same key (AU number / ARKit shape name / EXMORPH_ name) may appear on
 * multiple lines — each line ADDS another target morph for that key (one
 * driver can move several morphs at once, each with its own coef/threshold).
 */

/**
 * @typedef {{ morph: string, coef: number, thres: boolean }} ShapeMapTarget
 * @typedef {{
 *   eyeRotationCoef: number,
 *   au: Map<string, ShapeMapTarget[]>,
 *   arkit: Map<string, ShapeMapTarget[]>,
 *   exmorph: Map<string, ShapeMapTarget[]>,
 *   lip: Map<string, ShapeMapTarget[]>,
 *   acts: Map<string, string>,
 *   nolip: string[],
 *   lineCount: number,
 *   ignoredLines: number,
 * }} ParsedShapeMap
 */

/**
 * @param {string} text
 * @returns {ParsedShapeMap}
 */
export function parseShapeMap(text) {
  /** @type {ParsedShapeMap} */
  const result = {
    eyeRotationCoef: 1.0,
    au: new Map(),
    arkit: new Map(),
    exmorph: new Map(),
    lip: new Map(),
    acts: new Map(),
    nolip: [],
    lineCount: 0,
    ignoredLines: 0,
  };
  if (typeof text !== 'string') return result;

  const lines = text.split(/\r\n|\r|\n/);
  for (const line of lines) {
    if (!line) continue;
    const tokens = line.split(/ +/).filter((t) => t.length > 0);
    const p1 = tokens[0];
    if (!p1) continue;
    result.lineCount += 1;
    if (p1[0] === '#') continue;
    const p2 = tokens[1];
    if (p2 === undefined) {
      result.ignoredLines += 1;
      continue;
    }

    if (p1.startsWith('EYE_ROTATION_COEF')) {
      const v = Number(p2);
      if (Number.isFinite(v)) result.eyeRotationCoef = v;
      continue;
    }
    if (p1.startsWith('LIP_')) {
      const key = p1.slice(4);
      if (key) addTarget(result.lip, key, parseTarget(p2, tokens[2]));
      continue;
    }
    if (p1.startsWith('NOLIP')) {
      result.nolip.push(...p2.split(',').filter(Boolean));
      continue;
    }
    if (/^ACT\d+$/.test(p1)) {
      result.acts.set(p1, p2);
      continue;
    }
    if (
      p1.startsWith('TRACK_') ||
      p1.startsWith('ACT') ||
      p1.startsWith('EXBONE_') ||
      p1.startsWith('MORPH_TUNE')
    ) {
      continue;
    }

    const target = parseTarget(p2, tokens[2]);

    if (p1.startsWith('AU')) {
      addTarget(result.au, p1, target);
    } else if (p1.startsWith('EXMORPH_')) {
      addTarget(result.exmorph, p1, target);
    } else {
      // Everything else (ARKit shape names, and any other unrecognized key
      // such as VMC-tracker-style names) — matches ShapeMap.cpp's fallback
      // "else" branch, which registers into the ARKit-shape table keyed by
      // the literal key string.
      addTarget(result.arkit, p1, target);
    }
  }

  return result;
}

/**
 * @param {string} morph
 * @param {string | undefined} p3
 * @returns {ShapeMapTarget}
 */
function parseTarget(morph, p3) {
  let coef = 1.0;
  let thres = false;
  if (p3 !== undefined) {
    if (p3[0] === '>') {
      thres = true;
      coef = Number(p3.slice(1));
    } else {
      thres = false;
      coef = Number(p3);
    }
    if (!Number.isFinite(coef)) coef = thres ? 0 : 1;
  }
  return { morph, coef, thres };
}

/**
 * @param {Map<string, ShapeMapTarget[]>} map
 * @param {string} key
 * @param {ShapeMapTarget} target
 */
function addTarget(map, key, target) {
  const list = map.get(key);
  if (list) list.push(target);
  else map.set(key, [target]);
}
