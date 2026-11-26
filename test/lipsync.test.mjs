import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLipConfig, createLipSyncMotion } from '../src/lipsync-motion.js';

const conf = parseLipConfig(readFileSync(new URL('../appdata/lip.txt', import.meta.url), 'utf8'));

test('lip.txt: 4 expressions, phoneme table', () => {
  assert.deepEqual(conf.motions, ['あ', 'い', 'う', 'お']);
  const a = conf.phones.indexOf('a');
  assert.deepEqual(conf.rates[a], [0.5, 0, 0, 0]);
});

test('a phoneme sequence becomes face key frames as LipSync::createMotion does', () => {
  // a 100 ms (3 frames), o 200 ms (6 frames) + 6 tail frames, then the closing key
  const vmd = createLipSyncMotion(conf, 'a,100,o,200', 'え,ワ');
  const keysA = vmd.faces.get('あ');
  // a: 3 frames → split into 1 + 2 (0.8 rate); o: 12 frames → 10 + 2; closing key
  assert.deepEqual(keysA.map((k) => k.frame), [0, 1, 3, 13, 15]);
  assert.ok(Math.abs(keysA[0].weight - 0.5) < 1e-9);
  assert.ok(Math.abs(keysA[1].weight - 0.4) < 1e-9);
  assert.equal(keysA[4].weight, 0);
  const keysO = vmd.faces.get('お');
  assert.ok(Math.abs(keysO[2].weight - 0.8) < 1e-9);
  assert.deepEqual(vmd.faces.get('え'), [{ frame: 0, weight: 0 }]);
  assert.equal(vmd.maxFrame, 15);
});
