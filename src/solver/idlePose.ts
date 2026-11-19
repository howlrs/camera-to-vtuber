import { Euler, Quaternion } from 'three';
import type { HumanBoneName } from '../core/types.ts';

/**
 * Relaxed idle pose used when a bone is not observed (arms down instead of the VRM T-pose,
 * slightly curled fingers). Values are local rotations of VRM normalized bones.
 */
const deg = Math.PI / 180;
const IDLE: Partial<Record<HumanBoneName, Quaternion>> = {};

function set(bone: HumanBoneName, x: number, y: number, z: number) {
  IDLE[bone] = new Quaternion().setFromEuler(new Euler(x * deg, y * deg, z * deg, 'XYZ'));
}

set('leftUpperArm', 0, 0, -68);
set('rightUpperArm', 0, 0, 68);
set('leftLowerArm', 0, -12, 0);
set('rightLowerArm', 0, 12, 0);
set('leftHand', 0, 0, -6);
set('rightHand', 0, 0, 6);
for (const finger of ['Index', 'Middle', 'Ring', 'Little'] as const) {
  for (const seg of ['Proximal', 'Intermediate', 'Distal'] as const) {
    set(`left${finger}${seg}`, 0, 0, -14);
    set(`right${finger}${seg}`, 0, 0, 14);
  }
}

const IDENTITY = Object.freeze(new Quaternion());

export function restPose(bone: HumanBoneName): Quaternion {
  return IDLE[bone] ?? (IDENTITY as Quaternion);
}

export function idleBones(): HumanBoneName[] {
  return Object.keys(IDLE) as HumanBoneName[];
}
