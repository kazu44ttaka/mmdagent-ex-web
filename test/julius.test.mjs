import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mouthRates, createMouthControl } from '../src/julius-lip.js';

const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

test('phonemes become mouth rates as Avatar::storeMouthShape (×1.4, capped at 1)', () => {
  assert.ok(close(mouthRates('a'), [0.7, 0, 0, 0]));
  assert.ok(close(mouthRates('e:'), [0.14, 0.84, 0.28, 0]));
  assert.ok(close(mouthRates('u'), [0, 0, 1, 0]));
  assert.ok(close(mouthRates('th'), [0, 0.42, 0, 0]));
  assert.ok(close(mouthRates('ts'), [0.14, 0, 0, 0]));
  assert.ok(close(mouthRates('silE'), [0, 0, 0, 0]));
  assert.ok(close(mouthRates(null), [0, 0, 0, 0]));
});

test('the mouth eases by 0.40 per frame and closes over 10 frames', () => {
  const c = createMouthControl();
  const faces = {};
  const set = (n, w) => { faces[n] = w; };
  const morphs = { A: 'あ', I: 'い', U: 'う', O: 'お' };
  c.update(mouthRates('a'), 1, set, morphs, ['え']);
  assert.ok(Math.abs(faces['あ'] - 0.28) < 1e-9);
  assert.equal(faces['え'], 0);
  c.update(null, 5, set, morphs, []);
  // target 0.7 × 5/10, current 0.28 → eased fully (rate 2.0 clamps to 1)
  assert.ok(Math.abs(faces['あ'] - 0.35) < 1e-9);
  c.update(null, 5, set, morphs, []);
  faces['あ'] = 'untouched';
  c.update(null, 1, set, morphs, []);
  assert.equal(faces['あ'], 'untouched');
});
