import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVmd, writeVmd, solveInterpolationX } from '../src/vmd.js';
import { MotionManager, STATUS_DELETED } from '../src/motion.js';
import { quatFromEulerDeg } from '../src/math.js';

const close = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
const closeArr = (a, b, eps = 1e-4) => a.every((v, i) => close(v, b[i], eps));

function makePose(boneNames, faceNames = []) {
  const pose = {
    bones: boneNames.map((name) => ({ name, pos: [0, 0, 0], rot: [0, 0, 0, 1], independent: true })),
    boneIndex: new Map(boneNames.map((n, i) => [n, i])),
    faces: faceNames.map((name) => ({ name, weight: 0 })),
    faceIndex: new Map(faceNames.map((n, i) => [n, i])),
    smearAllBonesToDefault(rate) {
      for (const b of pose.bones) {
        b.pos = b.pos.map((v) => v * rate);
        const q = b.rot;
        // slerp from identity: approximate with normalized lerp is enough for these tests
        const l = [q[0] * rate, q[1] * rate, q[2] * rate, 1 - (1 - q[3]) * rate];
        const n = Math.hypot(...l);
        b.rot = l.map((v) => v / n);
      }
      for (const f of pose.faces) f.weight *= rate;
    },
  };
  return pose;
}

const rx = (deg) => quatFromEulerDeg([deg, 0, 0]);

test('VMD round trip: coordinates are converted to right-handed, keys sorted', () => {
  const bytes = writeVmd({
    bones: [
      { name: 'head', frame: 10, pos: [1, 2, 3], rot: rx(30) },
      { name: 'head', frame: 0, pos: [0, 0, 0], rot: rx(0) },
    ],
    faces: [{ name: 'a', frame: 5, weight: 0.5 }],
  });
  const vmd = parseVmd(bytes);
  assert.equal(vmd.maxFrame, 10);
  const keys = vmd.bones.get('head');
  assert.deepEqual(keys.map((k) => k.frame), [0, 10]);
  assert.ok(closeArr(keys[1].pos, [1, 2, 3]));
  assert.ok(closeArr(keys[1].rot, rx(30)));
  assert.equal(vmd.faces.get('a')[0].weight, 0.5);
  // the default curve (20,20)-(107,107) is linear
  assert.equal(keys[1].tables[0], null);
});

test('Bezier solver inverts the x curve', () => {
  const t = solveInterpolationX(0.3, 0.8, 0.1);
  const x = (1 + 3 * 0.8 - 3 * 0.1) * t ** 3 + (3 * 0.1 - 6 * 0.8) * t ** 2 + 3 * 0.8 * t;
  assert.ok(close(x, 0.3, 1e-3));
});

function vmdOf(spec) {
  return parseVmd(writeVmd(spec));
}

test('a looping FULL motion interpolates and loops; no smoothing when smooth is OFF', () => {
  const pose = makePose(['head']);
  const mm = new MotionManager(pose);
  const vmd = vmdOf({ bones: [{ name: 'head', frame: 0, pos: [0, 0, 0], rot: rx(0) }, { name: 'head', frame: 10, pos: [0, 10, 0], rot: rx(40) }] });
  mm.startMotion(vmd, 'base', true, false, false, false, 0);
  mm.update(0);
  assert.ok(closeArr(pose.bones[0].pos, [0, 0, 0]));
  mm.update(5); // applies frame 0, then advances to 5
  mm.update(0); // applies frame 5
  assert.ok(closeArr(pose.bones[0].pos, [0, 5, 0]));
  assert.ok(closeArr(pose.bones[0].rot, rx(20)));
  mm.update(5); // reaches the end: loops
  assert.ok(mm.players[0].statusFlag === 1);
});

test('smooth start blends from the pose before the motion over 20 frames', () => {
  const pose = makePose(['head']);
  pose.bones[0].pos = [0, 20, 0];
  const mm = new MotionManager(pose);
  const vmd = vmdOf({ bones: [{ name: 'head', frame: 0, pos: [0, 0, 0], rot: rx(0) }, { name: 'head', frame: 100, pos: [0, 0, 0], rot: rx(0) }] });
  mm.startMotion(vmd, 'a', false, false, true, false, 0);
  mm.update(0); // smear frame 20 → fully the snapshot
  assert.ok(closeArr(pose.bones[0].pos, [0, 20, 0]));
  mm.update(10);
  mm.update(0); // 10 of 20 frames left → halfway
  assert.ok(closeArr(pose.bones[0].pos, [0, 10, 0]));
});

test('higher priority overrides; PART skips bones with a single key; ONCE ends and is reported', () => {
  const pose = makePose(['head', 'arm']);
  const mm = new MotionManager(pose);
  const base = vmdOf({ bones: [
    { name: 'head', frame: 0, pos: [0, 1, 0], rot: rx(0) }, { name: 'head', frame: 30, pos: [0, 1, 0], rot: rx(0) },
    { name: 'arm', frame: 0, pos: [0, 2, 0], rot: rx(0) }, { name: 'arm', frame: 30, pos: [0, 2, 0], rot: rx(0) },
  ] });
  const part = vmdOf({ bones: [
    { name: 'head', frame: 0, pos: [0, 9, 0], rot: rx(0) }, { name: 'head', frame: 4, pos: [0, 9, 0], rot: rx(0) },
    { name: 'arm', frame: 0, pos: [0, 7, 0], rot: rx(0) }, // single key: ignored in PART
  ] });
  mm.startMotion(base, 'base', true, false, false, false, 0);
  mm.startMotion(part, 'nod', false, true, false, false, 1);
  assert.deepEqual(mm.players.map((p) => p.name), ['base', 'nod']);
  mm.update(1);
  assert.ok(closeArr(pose.bones[0].pos, [0, 9, 0]));
  assert.ok(closeArr(pose.bones[1].pos, [0, 2, 0]));
  let deleted = [];
  for (let i = 0; i < 6 && !deleted.length; i += 1) {
    mm.update(1);
    deleted = mm.justDeleted();
  }
  assert.deepEqual(deleted, ['nod']);
  mm.update(1);
  assert.ok(closeArr(pose.bones[0].pos, [0, 1, 0]));
  assert.equal(mm.getRunning('nod'), null);
});

test('delete with smooth fades out over 20 frames; a lower priority is inserted before', () => {
  const pose = makePose(['head']);
  const mm = new MotionManager(pose);
  const still = (y) => vmdOf({ bones: [{ name: 'head', frame: 0, pos: [0, y, 0], rot: rx(0) }, { name: 'head', frame: 100, pos: [0, y, 0], rot: rx(0) }] });
  mm.startMotion(still(0), 'base', true, false, false, false, 0);
  mm.startMotion(still(10), 'top', false, false, true, false, 5);
  mm.startMotion(still(5), 'mid', false, false, false, false, 2);
  assert.deepEqual(mm.players.map((p) => p.name), ['base', 'mid', 'top']);
  for (let i = 0; i < 25; i += 1) mm.update(1);
  assert.ok(closeArr(pose.bones[0].pos, [0, 10, 0]));
  mm.deleteMotion('top');
  mm.update(1);
  assert.deepEqual(mm.justDeleted(), ['top']);
  mm.update(10); // ending blend 20/20 applied, then 10 frames left
  mm.update(0); // 10/20 over the pose below
  assert.ok(close(pose.bones[0].pos[1], 5 + 5 * (10 / 20), 1e-3));
});

test('faces: replace, 0↔1 steps are not interpolated, MODE_FACE_ADD', () => {
  const pose = makePose([], ['blink', 'smile']);
  const mm = new MotionManager(pose);
  const vmd = vmdOf({ faces: [
    { name: 'blink', frame: 0, weight: 0 }, { name: 'blink', frame: 1, weight: 1 }, { name: 'blink', frame: 9, weight: 1 },
    { name: 'smile', frame: 0, weight: 0.2 }, { name: 'smile', frame: 9, weight: 0.2 },
  ] });
  mm.startMotion(vmd, 'f', false, false, false, false, 0);
  mm.update(0.4);
  mm.update(0);
  assert.equal(pose.faces[0].weight, 0);
  pose.faces[1].weight = 0.5;
  assert.equal(mm.configureMotion('f', 'MODE_FACE_ADD', 'smile'), true);
  mm.update(0);
  assert.ok(close(pose.faces[1].weight, 0.7));
});

test('MOTION_ACCELERATE changes the speed over the given frames', () => {
  const pose = makePose(['head']);
  const mm = new MotionManager(pose);
  const vmd = vmdOf({ bones: [{ name: 'head', frame: 0, pos: [0, 0, 0], rot: rx(0) }, { name: 'head', frame: 1000, pos: [0, 1000, 0], rot: rx(0) }] });
  mm.startMotion(vmd, 'a', true, false, false, false, 0);
  assert.equal(mm.setMotionSpeedRate('a', 2, 0, -1), true);
  assert.equal(mm.updateMotionSpeedRate(1), true);
  assert.deepEqual(mm.justAccelerated(), ['a']);
  mm.update(10);
  mm.update(0);
  assert.ok(close(pose.bones[0].pos[1], 20));
});

test('status constant is exported', () => {
  assert.equal(STATUS_DELETED, 2);
});
