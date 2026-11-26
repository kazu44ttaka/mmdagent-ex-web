/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDFiles/src/lib/PMDMaterial.cpp (setup, setExtParam)
 *   Library_MMDFiles/src/lib/PMDModel.cpp (setEdgeThin)
 *   Library_MMDFiles/src/lib/PMDModel_parse.cpp (edge width)
 *   Library_MMDAgent/src/lib/Render.cpp (updateLight)
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * Material settings MMDAgent-EX draws a model with (no three.js here, so Node tests can load it).
 */

/** PMDModel::setEdgeThin: edge offset = cartoon_edge_width × 0.03. */
export const EDGE_OFFSET_SCALE = 0.03;
/** PMDMODEL_EDGECOLOR */
export const DEFAULT_EDGE_COLOR = [0, 0, 0, 1];

/**
 * @typedef {{
 *   diffuse: number[], ambient: number[], specular: number[], shininess: number, alpha: number,
 *   toonIndex: number, edge: boolean, edgeWidth: number, edgeColor: number[] | null,
 *   face: boolean, shadow: boolean, shadowMapDrop: boolean, shadowMapRender: boolean,
 *   tex: string | null, sphere: string | null, sphereMode: number,
 * }} MaterialLook
 */

/**
 * Per-material settings: PMDMaterial::setup for a PMD (or the PMX flags), then
 * PMDMaterial::setExtParam for each Material row of "<model>.csv".
 * @param {any} data parsed model (mmd-parser)
 * @param {boolean} isPmx
 * @param {{ materials: import('./modelext.js').CsvMaterial[] } | null} csv
 * @returns {{ materials: MaterialLook[], hasExt: boolean }}
 */
export function materialLooks(data, isPmx, csv) {
  const materials = (data.materials || []).map((m) => {
    const alpha = m.diffuse[3];
    const base = {
      diffuse: m.diffuse.slice(0, 3),
      ambient: m.ambient.slice(0, 3),
      specular: m.specular.slice(0, 3),
      shininess: m.shininess,
      alpha,
      toonIndex: isPmx ? -1 : m.toonIndex,
      tex: null,
      sphere: null,
      sphereMode: 0,
    };
    if (isPmx) {
      const f = m.flag || 0;
      return {
        ...base,
        edge: Boolean(f & 0x10),
        edgeWidth: m.edgeSize ?? 1,
        edgeColor: m.edgeColor ? m.edgeColor.slice(0, 4) : null,
        face: Boolean(f & 0x01),
        shadow: Boolean(f & 0x02),
        shadowMapDrop: Boolean(f & 0x04),
        shadowMapRender: Boolean(f & 0x08),
      };
    }
    const edge = Boolean(m.edgeFlag);
    const drop = alpha >= 0.97999 && alpha <= 0.98001 ? edge : false;
    return {
      ...base,
      edge,
      edgeWidth: 1,
      edgeColor: null,
      face: alpha < 1,
      shadow: edge,
      shadowMapDrop: drop,
      shadowMapRender: drop,
    };
  });
  const ext = csv?.materials || [];
  for (let i = 0; i < ext.length && i < materials.length; i += 1) {
    const e = ext[i];
    const on = e.alpha !== 0;
    Object.assign(materials[i], {
      alpha: e.alpha,
      edge: on && e.edge,
      edgeWidth: e.edgeWidth,
      edgeColor: e.edgeColor.slice(0, 4),
      face: on && e.face,
      shadow: on && e.shadow,
      shadowMapDrop: on && e.shadowMapDrop,
      shadowMapRender: on && e.shadowMapRender,
      tex: e.tex,
      sphere: e.sphere,
      sphereMode: e.sphereMode,
    });
  }
  return { materials, hasExt: ext.length > 0 };
}

/**
 * Edge rate of each vertex before the edge offset (PMDModel_parse "compute edge
 * width"): 0 for PMD vertices flagged no-edge, else 1 (or the CSV value), times
 * the edge width of the first material that uses the vertex.
 * @param {any} data parsed model
 * @param {boolean} isPmx
 * @param {MaterialLook[]} looks
 * @param {Array<[number, number]>} [vertexEdge] CSV Vertex rows: [index, rate]
 * @returns {Float32Array}
 */
export function vertexEdgeRates(data, isPmx, looks, vertexEdge) {
  const n = data.vertices.length;
  const rate = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = data.vertices[i];
    rate[i] = isPmx ? (v.edgeRatio ?? 1) : (v.edgeFlag ? 0 : 1);
  }
  for (const [idx, r] of vertexEdge || []) if (idx >= 0 && idx < n) rate[idx] = r;
  const checked = new Uint8Array(n);
  let face = 0;
  for (let m = 0; m < looks.length; m += 1) {
    const count = data.materials[m].faceCount;
    const w = looks[m].edgeWidth;
    for (let f = face; f < face + count && f < data.faces.length; f += 1) {
      for (const idx of data.faces[f].indices) {
        if (checked[idx]) continue;
        rate[idx] *= w;
        checked[idx] = 1;
      }
    }
    face += count;
  }
  return rate;
}

/**
 * Render::updateLight: diffuse d, ambient a and specular s of the light.
 * @param {boolean} likeMmd use_mmd_like_cartoon
 * @param {boolean} toon cartoon rendering for this model
 * @param {number} intensity light_intensity
 */
export function lightTerms(likeMmd, toon, intensity) {
  if (!likeMmd) return { d: 0.2, a: intensity * 1.5, s: 0.4 };
  if (toon) return { d: 0.0, a: intensity * 1.5, s: intensity };
  return { d: intensity, a: 1.0, s: 1.0 };
}
