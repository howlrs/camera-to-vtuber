import { MathUtils, Quaternion, Vector3 } from 'three';
import type { AvatarPoint, BodyPointName, HumanBoneName, Side } from '../core/types.ts';
import { angleBetween, frameRotation, toLocal } from './math.ts';

/**
 * Hand solver: wrist orientation + finger curls from MediaPipe hand world landmarks (21 points),
 * or a coarse wrist orientation from pose landmarks (wrist/index/pinky) when no hand was found.
 *
 * Rest (VRM T-pose, palm down): fingers point along the arm (+X left / -X right) and the
 * index-side of the palm faces forward (+Z) for both hands.
 */

const FINGERS = [
  { name: 'Index', joints: [0, 5, 6, 7, 8] },
  { name: 'Middle', joints: [0, 9, 10, 11, 12] },
  { name: 'Ring', joints: [0, 13, 14, 15, 16] },
  { name: 'Little', joints: [0, 17, 18, 19, 20] },
] as const;

const REST_AXIS: Record<Side, Vector3> = { left: new Vector3(1, 0, 0), right: new Vector3(-1, 0, 0) };
const REST_SIDE = new Vector3(0, 0, 1);
// Curling moves fingertips toward the palm (-Y): about +Z by -θ (left) / +θ (right).
const CURL_AXIS = new Vector3(0, 0, 1);
const CURL_SIGN: Record<Side, number> = { left: -1, right: 1 };
// Thumb flex axes (perpendicular to the thumb's diagonal rest direction, tip moving to -Y).
const THUMB_AXIS: Record<Side, Vector3> = {
  left: new Vector3(1, 0, -1).normalize(),
  right: new Vector3(1, 0, 1).normalize(),
};

const MAX_CURL = MathUtils.degToRad(100);
const PALM_BASELINE = MathUtils.degToRad(12);

export interface HandSolution {
  bones: Map<HumanBoneName, Quaternion>;
}

const _a = new Vector3();
const _b = new Vector3();

export class HandSolver {
  /** Global multiplier for finger curls (1 = as measured). */
  curlGain = 1.1;

  solve(
    side: Side,
    points: Vector3[] | undefined,
    lowerArmWorld: Quaternion | undefined,
    body: Map<BodyPointName, AvatarPoint> | null,
  ): HandSolution | null {
    const bones = new Map<HumanBoneName, Quaternion>();
    const handWorld = points && points.length === 21 ? palmFromHand(side, points) : palmFromPose(side, body);
    if (handWorld && lowerArmWorld) bones.set(`${side}Hand`, toLocal(lowerArmWorld, handWorld));

    if (points && points.length === 21) {
      const sign = CURL_SIGN[side];
      for (const f of FINGERS) {
        const [w, mcp, pip, dip, tip] = f.joints.map((i) => points[i]);
        const curls = [
          Math.max(0, angleBetween(_a.subVectors(mcp, w), _b.subVectors(pip, mcp)) - PALM_BASELINE),
          angleBetween(_a.subVectors(pip, mcp), _b.subVectors(dip, pip)),
          angleBetween(_a.subVectors(dip, pip), _b.subVectors(tip, dip)),
        ];
        const names = ['Proximal', 'Intermediate', 'Distal'] as const;
        names.forEach((seg, i) => {
          const angle = Math.min(curls[i] * this.curlGain, MAX_CURL);
          bones.set(`${side}${f.name}${seg}` as HumanBoneName, new Quaternion().setFromAxisAngle(CURL_AXIS, sign * angle));
        });
      }
      // Thumb: 1 = CMC, 2 = MCP, 3 = IP, 4 = tip
      const t = points;
      const flexMcp = angleBetween(_a.subVectors(t[2], t[1]), _b.subVectors(t[3], t[2]));
      const flexIp = angleBetween(_a.subVectors(t[3], t[2]), _b.subVectors(t[4], t[3]));
      const axis = THUMB_AXIS[side];
      bones.set(`${side}ThumbMetacarpal`, new Quaternion().setFromAxisAngle(axis, Math.min(flexMcp * 0.3, 0.6)));
      bones.set(`${side}ThumbProximal`, new Quaternion().setFromAxisAngle(axis, Math.min(flexMcp * 0.8, 1.2)));
      bones.set(`${side}ThumbDistal`, new Quaternion().setFromAxisAngle(axis, Math.min(flexIp * this.curlGain, 1.4)));
    }
    return bones.size ? { bones } : null;
  }
}

/** Palm orientation from the hand landmarker: finger axis = wrist->middle MCP, side = pinky->index. */
export function palmFromHand(side: Side, p: Vector3[]): Quaternion | null {
  const axis = new Vector3().subVectors(p[9], p[0]);
  const across = new Vector3().subVectors(p[5], p[17]);
  return frameRotation(REST_AXIS[side], REST_SIDE, axis, across);
}

/** Coarse palm orientation from pose landmarks (wrist, index knuckle, pinky knuckle). */
function palmFromPose(side: Side, body: Map<BodyPointName, AvatarPoint> | null): Quaternion | null {
  if (!body) return null;
  const w = body.get(`${side}Wrist`)!;
  const i = body.get(`${side}Index`)!;
  const p = body.get(`${side}Pinky`)!;
  if (Math.min(w.v, i.v, p.v) < 0.5) return null;
  const axis = new Vector3().addVectors(i.p, p.p).multiplyScalar(0.5).sub(w.p);
  const across = new Vector3().subVectors(i.p, p.p);
  return frameRotation(REST_AXIS[side], REST_SIDE, axis, across);
}
