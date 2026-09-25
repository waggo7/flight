// Quaternion arithmetic on flat number arrays (x, y, z, w at an offset), written as plain
// scalar code so the GDScript port (godot/core/hero_pose_graph.gd) can mirror it line by line
// in 64-bit floats. Conventions match three.js: Euler order XYZ (intrinsic), q = qx * qy * qz,
// Hamilton product, and a rotation applies as q * v * q⁻¹.

export type QuatArray = Float64Array | number[];

/** out[o..o+3] = the quaternion of Euler angles (x, y, z), order XYZ (three.js setFromEuler). */
export function quatFromEulerXYZ(out: QuatArray, o: number, x: number, y: number, z: number): void {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  out[o] = s1 * c2 * c3 + c1 * s2 * s3;
  out[o + 1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[o + 2] = c1 * c2 * s3 + s1 * s2 * c3;
  out[o + 3] = c1 * c2 * c3 - s1 * s2 * s3;
}

/** out[o..] = a[ao..] * b[bo..]. `out` may alias either input. */
export function quatMultiply(out: QuatArray, o: number, a: QuatArray, ao: number, b: QuatArray, bo: number): void {
  const ax = a[ao];
  const ay = a[ao + 1];
  const az = a[ao + 2];
  const aw = a[ao + 3];
  const bx = b[bo];
  const by = b[bo + 1];
  const bz = b[bo + 2];
  const bw = b[bo + 3];
  out[o] = ax * bw + aw * bx + ay * bz - az * by;
  out[o + 1] = ay * bw + aw * by + az * bx - ax * bz;
  out[o + 2] = az * bw + aw * bz + ax * by - ay * bx;
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** out[o..] = the conjugate (the inverse, for unit quaternions) of q[qo..]. */
export function quatConjugate(out: QuatArray, o: number, q: QuatArray, qo: number): void {
  out[o] = -q[qo];
  out[o + 1] = -q[qo + 1];
  out[o + 2] = -q[qo + 2];
  out[o + 3] = q[qo + 3];
}

/** Normalise in place; a zero quaternion becomes the identity. */
export function quatNormalize(q: QuatArray, o: number): void {
  const length = Math.sqrt(q[o] * q[o] + q[o + 1] * q[o + 1] + q[o + 2] * q[o + 2] + q[o + 3] * q[o + 3]);
  if (length < 1e-12) {
    q[o] = 0;
    q[o + 1] = 0;
    q[o + 2] = 0;
    q[o + 3] = 1;
    return;
  }
  q[o] /= length;
  q[o + 1] /= length;
  q[o + 2] /= length;
  q[o + 3] /= length;
}

export function quatDot(a: QuatArray, ao: number, b: QuatArray, bo: number): number {
  return a[ao] * b[bo] + a[ao + 1] * b[bo + 1] + a[ao + 2] * b[bo + 2] + a[ao + 3] * b[bo + 3];
}

/** out[o..] = identity. */
export function quatIdentity(out: QuatArray, o: number): void {
  out[o] = 0;
  out[o + 1] = 0;
  out[o + 2] = 0;
  out[o + 3] = 1;
}

/** out[o..] = p⁻¹ * r * p * q: rotate a joint's local rotation q by r, given in the frame whose orientation is p. */
export function quatRotateInFrame(out: QuatArray, o: number, p: QuatArray, po: number, r: QuatArray, ro: number, q: QuatArray, qo: number, scratch: QuatArray): void {
  quatMultiply(scratch, 0, r, ro, p, po); // r * p
  quatMultiply(scratch, 0, scratch, 0, q, qo); // r * p * q
  quatConjugate(scratch, 4, p, po); // p⁻¹
  quatMultiply(out, o, scratch, 4, scratch, 0);
}
