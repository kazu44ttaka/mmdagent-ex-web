/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDAgent/src/lib/MMDAgent_utils.cpp (str2rot)
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * Small vector / quaternion helpers matching Bullet (btVector3, btQuaternion),
 * which MMDAgent-EX uses for all pose math. Quaternions are [x, y, z, w].
 */

/** @typedef {[number, number, number]} Vec3 */
/** @typedef {[number, number, number, number]} Quat */

export const DEG = Math.PI / 180;

/** @returns {Quat} */
export const quatIdentity = () => [0, 0, 0, 1];

/** @returns {Vec3} */
export const vecZero = () => [0, 0, 0];

/**
 * btQuaternion::setEulerZYX(yawZ, pitchY, rollX), from "rx,ry,rz" in degrees
 * (MMDAgent_str2rot).
 * @param {Vec3} rotDeg
 * @returns {Quat}
 */
export function quatFromEulerDeg(rotDeg) {
  const hx = (rotDeg[0] * DEG) / 2;
  const hy = (rotDeg[1] * DEG) / 2;
  const hz = (rotDeg[2] * DEG) / 2;
  const cr = Math.cos(hx), sr = Math.sin(hx);
  const cp = Math.cos(hy), sp = Math.sin(hy);
  const cy = Math.cos(hz), sy = Math.sin(hz);
  return [
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
    cr * cp * cy + sr * sp * sy,
  ];
}

/**
 * btQuaternion(axis, angle)
 * @param {Vec3} axis normalized
 * @param {number} angle radians
 * @returns {Quat}
 */
export function quatFromAxisAngle(axis, angle) {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/**
 * a * b (Bullet operator*)
 * @param {Quat} a
 * @param {Quat} b
 * @returns {Quat}
 */
export function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] + a[1] * b[3] + a[2] * b[0] - a[0] * b[2],
    a[3] * b[2] + a[2] * b[3] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** @param {Quat} q @returns {Quat} */
export function quatInverse(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** @param {Quat} a @param {Quat} b */
export function quatDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/**
 * btQuaternion::slerp: the shorter way round; returns `a` when nearly equal.
 * @param {Quat} a
 * @param {Quat} b
 * @param {number} t
 * @returns {Quat}
 */
export function slerp(a, b, t) {
  const mag = Math.sqrt(quatDot(a, a) * quatDot(b, b));
  const product = quatDot(a, b) / mag;
  const abs = Math.abs(product);
  if (abs < 1 - 1e-7) {
    const theta = Math.acos(abs);
    const d = Math.sin(theta);
    const sign = product < 0 ? -1 : 1;
    const s0 = Math.sin((1 - t) * theta) / d;
    const s1 = Math.sin(sign * t * theta) / d;
    return [a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1, a[3] * s0 + b[3] * s1];
  }
  return [a[0], a[1], a[2], a[3]];
}

/**
 * btQuaternion::nearest: `b` or `-b`, whichever is closer to `a`.
 * @param {Quat} a
 * @param {Quat} b
 * @returns {Quat}
 */
export function quatNearest(a, b) {
  const diff = [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
  const sum = [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
  return quatDot(diff, diff) < quatDot(sum, sum) ? [b[0], b[1], b[2], b[3]] : [-b[0], -b[1], -b[2], -b[3]];
}

/**
 * Rotate a vector by a quaternion.
 * @param {Quat} q
 * @param {Vec3} v
 * @returns {Vec3}
 */
export function quatRotate(q, v) {
  const r = quatMul(quatMul(q, [v[0], v[1], v[2], 0]), quatInverse(q));
  return [r[0], r[1], r[2]];
}

/** @param {Vec3} a @param {Vec3} b @param {number} t @returns {Vec3} */
export function vlerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {Vec3} a @param {number} s @returns {Vec3} */
export const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
/** @param {Vec3} a */
export const vlength = (a) => Math.hypot(a[0], a[1], a[2]);

/**
 * "x,y,z" → numbers, or null (MMDAgent_str2fvec with 3 values).
 * @param {string} s
 * @returns {Vec3 | null}
 */
export function parseVec3(s) {
  const p = String(s ?? '').split(',').map((v) => Number(v.trim()));
  if (p.length !== 3 || !p.every(Number.isFinite)) return null;
  return /** @type {Vec3} */ (p);
}
