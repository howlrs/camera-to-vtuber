import { MathUtils, Matrix4, Quaternion, Vector3 } from 'three';

export const AXIS_X = Object.freeze(new Vector3(1, 0, 0));
export const AXIS_Y = Object.freeze(new Vector3(0, 1, 0));
export const AXIS_Z = Object.freeze(new Vector3(0, 0, 1));

const _m1 = new Matrix4();
const _m2 = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();

/**
 * Rotation from an orthonormal frame built from (primary, secondary) to an orthonormal frame
 * built from (primary', secondary'). The primary axis is matched exactly; the secondary axis is
 * matched as closely as possible (Gram-Schmidt). Returns null when the target is degenerate.
 */
export function frameRotation(
  restPrimary: Vector3,
  restSecondary: Vector3,
  primary: Vector3,
  secondary: Vector3,
  out = new Quaternion(),
): Quaternion | null {
  const restBasis = basis(restPrimary, restSecondary, _m1);
  const targetBasis = basis(primary, secondary, _m2);
  if (!restBasis || !targetBasis) return null;
  // q = B * A^-1 ; A is orthonormal so A^-1 = A^T
  restBasis.transpose();
  targetBasis.multiply(restBasis);
  return out.setFromRotationMatrix(targetBasis);
}

function basis(primary: Vector3, secondary: Vector3, m: Matrix4): Matrix4 | null {
  const x = _a.copy(primary);
  if (x.lengthSq() < 1e-12) return null;
  x.normalize();
  const y = _b.copy(secondary).addScaledVector(x, -secondary.dot(x));
  if (y.lengthSq() < 1e-12) return null;
  y.normalize();
  const z = _c.crossVectors(x, y);
  return m.makeBasis(x, y, z);
}

/** Minimal rotation taking direction a to direction b. */
export function fromTo(a: Vector3, b: Vector3, out = new Quaternion()): Quaternion {
  return out.setFromUnitVectors(_a.copy(a).normalize(), _b.copy(b).normalize());
}

/** Fraction `t` of a rotation (slerp from identity). */
export function scaleRotation(q: Quaternion, t: number, out = new Quaternion()): Quaternion {
  return out.identity().slerp(q, t);
}

/** local = parentWorld^-1 * childWorld */
export function toLocal(parentWorld: Quaternion, childWorld: Quaternion, out = new Quaternion()): Quaternion {
  return out.copy(parentWorld).invert().multiply(childWorld);
}

export function axisAngle(axis: Vector3, radians: number, out = new Quaternion()): Quaternion {
  return out.setFromAxisAngle(axis, radians);
}

/** Linear remap with clamping to 0..1. */
export function remap01(v: number, lo: number, hi: number): number {
  return MathUtils.clamp((v - lo) / (hi - lo), 0, 1);
}

/** Unsigned angle between two vectors in radians (0 if degenerate). */
export function angleBetween(a: Vector3, b: Vector3): number {
  if (a.lengthSq() < 1e-12 || b.lengthSq() < 1e-12) return 0;
  return a.angleTo(b);
}

export function smoothstep(lo: number, hi: number, v: number): number {
  const t = MathUtils.clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}
