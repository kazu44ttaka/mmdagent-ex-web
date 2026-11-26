import { test } from 'node:test';
import assert from 'node:assert/strict';

import { materialLooks, vertexEdgeRates, lightTerms } from '../src/material-looks.js';

const pmd = {
  materials: [
    { diffuse: [1, 1, 1, 1], ambient: [0.75, 0.75, 0.75], specular: [0, 0, 0], shininess: 5, toonIndex: -1, edgeFlag: 1, faceCount: 1, fileName: 'a.png' },
    { diffuse: [1, 1, 1, 0.98], ambient: [0.75, 0.75, 0.75], specular: [0, 0, 0], shininess: 5, toonIndex: 0, edgeFlag: 0, faceCount: 1, fileName: '' },
  ],
  vertices: [{ edgeFlag: 0 }, { edgeFlag: 0 }, { edgeFlag: 1 }, { edgeFlag: 0 }],
  faces: [{ indices: [0, 1, 2] }, { indices: [1, 2, 3] }],
};

test('PMD material flags as PMDMaterial::setup sets them', () => {
  const { materials, hasExt } = materialLooks(pmd, false, null);
  assert.equal(hasExt, false);
  assert.deepEqual([materials[0].edge, materials[0].face, materials[0].shadow, materials[0].shadowMapDrop], [true, false, true, false]);
  assert.deepEqual([materials[1].edge, materials[1].face, materials[1].shadow, materials[1].shadowMapDrop], [false, true, false, false]);
});

test('CSV materials override edge, colour and flags; alpha 0 turns them off', () => {
  const csv = {
    materials: [
      { name: 'x', alpha: 1, face: true, shadow: true, shadowMapDrop: true, shadowMapRender: true, edge: true, edgeWidth: 0.45, edgeColor: [0.4, 0.4, 0.4, 1], tex: null, sphere: null, sphereMode: 0 },
      { name: 'y', alpha: 0, face: true, shadow: true, shadowMapDrop: true, shadowMapRender: true, edge: true, edgeWidth: 1, edgeColor: [0, 0, 0, 1], tex: null, sphere: null, sphereMode: 0 },
    ],
  };
  const { materials, hasExt } = materialLooks(pmd, false, csv);
  assert.equal(hasExt, true);
  assert.equal(materials[0].edgeWidth, 0.45);
  assert.deepEqual(materials[0].edgeColor, [0.4, 0.4, 0.4, 1]);
  assert.deepEqual([materials[1].edge, materials[1].face, materials[1].shadow], [false, false, false]);
});

test('vertex edge rate: no-edge vertices, CSV rates, then the first material using the vertex', () => {
  const looks = [{ edgeWidth: 0.5 }, { edgeWidth: 2 }];
  assert.deepEqual(Array.from(vertexEdgeRates(pmd, false, looks)), [0.5, 0.5, 0, 2]);
  assert.deepEqual(Array.from(vertexEdgeRates(pmd, false, looks, [[2, 0.75]])), [0.5, 0.5, 0.375, 2]);
});

test('Render::updateLight terms', () => {
  assert.deepEqual(lightTerms(true, true, 0.6), { d: 0, a: 0.6 * 1.5, s: 0.6 });
  assert.deepEqual(lightTerms(true, false, 0.6), { d: 0.6, a: 1, s: 1 });
  assert.deepEqual(lightTerms(false, true, 0.6), { d: 0.2, a: 0.6 * 1.5, s: 0.4 });
});
