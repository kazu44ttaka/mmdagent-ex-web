import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyValue, Bindings, quatFromEulerDeg, slerp } from '../src/bindings.js';

const close = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('euler degrees build the same quaternion as btQuaternion::setEulerZYX', () => {
  assert.ok(close(quatFromEulerDeg([0, 0, 0]), [0, 0, 0, 1]));
  const s = Math.sin(Math.PI / 4);
  assert.ok(close(quatFromEulerDeg([90, 0, 0]), [s, 0, 0, s]));
  assert.ok(close(quatFromEulerDeg([0, 90, 0]), [0, s, 0, s]));
  assert.ok(close(quatFromEulerDeg([0, 0, 90]), [0, 0, s, s]));
  // Z * Y * X: x applied first
  const q = quatFromEulerDeg([30, 40, 50]);
  const h = (d) => (d * Math.PI) / 360;
  const qx = [Math.sin(h(30)), 0, 0, Math.cos(h(30))];
  const qy = [0, Math.sin(h(40)), 0, Math.cos(h(40))];
  const qz = [0, 0, Math.sin(h(50)), Math.cos(h(50))];
  const mul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  assert.ok(close(q, mul(mul(qz, qy), qx)));
});

test('slerp halfway and the shorter way round', () => {
  const a = quatFromEulerDeg([0, 0, 0]);
  const b = quatFromEulerDeg([60, 0, 0]);
  assert.ok(close(slerp(a, b, 0.5), quatFromEulerDeg([30, 0, 0])));
  const nb = b.map((v) => -v);
  assert.ok(close(slerp(a, nb, 0.5), quatFromEulerDeg([30, 0, 0]).map((v) => -v)) || close(slerp(a, nb, 0.5), quatFromEulerDeg([30, 0, 0])));
});

test('MaAI-SDS head binding follows MaAI_HeadPitch in [-1, 1]', () => {
  const kv = new KeyValue();
  const b = new Bindings(kv);
  const ev = b.bindBone('MaAI_HeadPitch|-1|1|gene|頭|0,0,0|57.2958,0,0|0,0,0|-57.2958,0,0'.split('|'));
  assert.equal(ev, 'gene|頭');
  const bind = b.bones.get('gene\u0000頭');
  kv.set('MaAI_HeadPitch', '-1');
  assert.ok(close(b.bonePose(bind).rot, quatFromEulerDeg([57.2958, 0, 0])));
  kv.set('MaAI_HeadPitch', '0');
  assert.ok(close(b.bonePose(bind).rot, [0, 0, 0, 1]));
  kv.set('MaAI_HeadPitch', '0.5');
  assert.ok(close(b.bonePose(bind).rot, quatFromEulerDeg([-28.6479, 0, 0]), 1e-5));
  kv.set('MaAI_HeadPitch', '7');
  assert.ok(close(b.bonePose(bind).rot, quatFromEulerDeg([-57.2958, 0, 0])));
  // unset key reads as 0.0, like getString(key, "0.0")
  const kv2 = new KeyValue();
  const b2 = new Bindings(kv2);
  b2.bindBone('K|0|1|m|頭|0,0,0|0,0,0|0,1,0|0,0,0'.split('|'));
  assert.deepEqual(b2.bonePose(b2.bones.get('m\u0000頭')).pos, [0, 0, 0]);
  kv2.set('K', '0.5');
  assert.deepEqual(b2.bonePose(b2.bones.get('m\u0000頭')).pos, [0, 0.5, 0]);
});

test('face bindings: keyed lerp, and the fixed form eases over its duration', () => {
  const kv = new KeyValue();
  const b = new Bindings(kv);
  assert.equal(b.bindFace('MaAI_Blink|0|1|gene|まばたき|0|1'.split('|')), 'MaAI_Blink|gene|まばたき');
  const blink = b.faces.get('gene\u0000まばたき');
  kv.set('MaAI_Blink', '0.25');
  assert.equal(b.faceWeight(blink, 1), 0.25);
  // MODEL_BINDFACE|alias|face|rate|duration: from the current weight to rate over duration seconds
  b.bindFace(['gene', '笑い', '1', '1'], () => 0);
  const smile = b.faces.get('gene\u0000笑い');
  assert.equal(b.faceWeight(smile, 15), 0); // r = 1 at the first update
  assert.ok(Math.abs(b.faceWeight(smile, 15) - 0.5) < 1e-9);
  assert.equal(b.faceWeight(smile, 15), 1);
  assert.equal(b.faceWeight(smile, 15), 1);
});

test('a second bind of the same bone replaces the first; unbind and clear', () => {
  const kv = new KeyValue();
  const b = new Bindings(kv);
  b.bindBone(['gene', '頭', '0,0,0', '10,0,0']);
  b.bindBone(['gene', '頭', '0,0,0', '20,0,0']);
  assert.equal(b.bones.size, 1);
  assert.ok(close(b.bonePose(b.bones.get('gene\u0000頭')).rot, quatFromEulerDeg([20, 0, 0])));
  assert.equal(b.bindBone(['gene', '頭', 'bad', '0,0,0']), null);
  b.bindFace(['gene', 'あ', '1']);
  assert.equal(b.unbindBone('gene', '頭'), true);
  b.clearModel('gene');
  assert.equal(b.faces.size, 0);
});
