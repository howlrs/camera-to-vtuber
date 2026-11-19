import { Quaternion, Vector3 } from 'three';
import type { AvatarPoint, AvatarSpaceFrame, BodyPointName, HumanBoneName, Side } from '../core/types.ts';
import { AXIS_X, AXIS_Y, AXIS_Z, fromTo, frameRotation, scaleRotation, smoothstep, toLocal } from './math.ts';
import { Hysteresis } from './Stabilizers.ts';

/**
 * Body solver: avatar-space landmarks -> local rotations of VRM normalized bones.
 *
 * Limbs use hinge-plane decomposition: the upper segment's twist is chosen so that the elbow/knee
 * hinge axis is perpendicular to the plane spanned by both segments, which makes the lower joint
 * a pure hinge (no candy-wrapper twist). Near-straight limbs fall back to minimal rotations.
 */

export interface BodySolverOptions {
  /** Solve legs/hips (full-body framing). */
  legs: boolean;
  /** Minimum landmark confidence to drive a bone. */
  minVisibility: number;
  /** Portion of the torso pitch applied (webcams exaggerate forward lean). */
  torsoPitchScale: number;
}

export interface BodySolution {
  bones: Map<HumanBoneName, Quaternion>;
  /** World (avatar-space) rotation of the bone the neck attaches to; used by the face solver. */
  neckParentWorld: Quaternion;
  /** World rotation of each lower arm, used by the hand solver. */
  lowerArmWorld: Partial<Record<Side, Quaternion>>;
  confidence: number;
  armConfidence: Partial<Record<Side, number>>;
}

interface LimbRest {
  axis: Vector3;
  hinge: Vector3;
}

// VRM T-pose, palms down. Left arm extends to +X; the elbow flexes the forearm toward +Z.
const ARM_REST: Record<Side, LimbRest> = {
  left: { axis: new Vector3(1, 0, 0), hinge: new Vector3(0, -1, 0) },
  right: { axis: new Vector3(-1, 0, 0), hinge: new Vector3(0, 1, 0) },
};
// Legs point down; the knee flexes the shin toward -Z.
const LEG_REST: LimbRest = { axis: new Vector3(0, -1, 0), hinge: new Vector3(1, 0, 0) };

const _d1 = new Vector3();
const _d2 = new Vector3();
const _n = new Vector3();
const _v = new Vector3();
const _q = new Quaternion();

export class BodySolver {
  options: BodySolverOptions = { legs: false, minVisibility: 0.5, torsoPitchScale: 0.6 };
  /** Last valid hinge normals keep straight limbs stable. */
  private lastHinge = new Map<string, Vector3>();
  // Enter/exit thresholds stop limbs flickering when landmarks hover near the frame edge.
  private torsoGate = new Hysteresis(0.5, 0.3);
  private armGate = { left: new Hysteresis(0.55, 0.35), right: new Hysteresis(0.55, 0.35) };
  private legGate = { left: new Hysteresis(0.65, 0.45), right: new Hysteresis(0.65, 0.45) };
  hasUpperChest = true;
  /** Below this elbow confidence the elbow is reconstructed by IK. */
  elbowMinVisibility = 0.5;
  /** How each arm was solved in the last frame (for diagnostics/UI). */
  readonly armModes: Record<Side, 'measured' | 'ik' | 'off'> = { left: 'off', right: 'off' };
  /** Segment lengths learned while the whole arm is visible (meters). */
  private learnedLengths: Partial<Record<Side, { upper: number; lower: number }>> = {};

  solve(frame: AvatarSpaceFrame): BodySolution | null {
    const body = frame.body;
    if (!body) return null;
    const ls = body.get('leftShoulder');
    const rs = body.get('rightShoulder');
    if (!ls || !rs) return null;
    const shoulderConf = Math.min(ls.v, rs.v);
    if (!this.torsoGate.update(shoulderConf)) return null;

    const bones = new Map<HumanBoneName, Quaternion>();
    const lh = body.get('leftHip')!;
    const rh = body.get('rightHip')!;
    const hipsVisible = Math.min(lh.v, rh.v) >= this.options.minVisibility;

    // ---- hips
    const hipsWorld = new Quaternion();
    const hipMid = new Vector3().addVectors(lh.p, rh.p).multiplyScalar(0.5);
    const shoulderMid = new Vector3().addVectors(ls.p, rs.p).multiplyScalar(0.5);
    if (this.options.legs && hipsVisible) {
      const up = _v.subVectors(shoulderMid, hipMid);
      frameRotation(AXIS_X, AXIS_Y, _d1.subVectors(lh.p, rh.p), up, hipsWorld) ?? hipsWorld.identity();
      bones.set('hips', hipsWorld.clone());
    }

    // ---- torso: x from the shoulder line, y from hips->shoulders (or world up when hips unseen)
    const torsoWorld = new Quaternion();
    const shoulderLine = new Vector3().subVectors(ls.p, rs.p);
    const up = hipsVisible ? new Vector3().subVectors(shoulderMid, hipMid) : AXIS_Y.clone();
    if (!frameRotation(AXIS_X, AXIS_Y, shoulderLine, up, torsoWorld)) torsoWorld.identity();
    limitPitch(torsoWorld, this.options.torsoPitchScale);

    const spineTotal = toLocal(hipsWorld, torsoWorld);
    if (this.hasUpperChest) {
      bones.set('spine', scaleRotation(spineTotal, 0.4));
      bones.set('chest', scaleRotation(spineTotal, 0.3));
      bones.set('upperChest', scaleRotation(spineTotal, 0.3));
    } else {
      bones.set('spine', scaleRotation(spineTotal, 0.5));
      bones.set('chest', scaleRotation(spineTotal, 0.5));
    }
    // After distributing, the chain's world rotation ≈ torsoWorld.
    const chestWorld = hipsWorld.clone().multiply(spineTotal);

    // ---- arms (shoulder bones stay at rest; their world rotation equals the chest's)
    const lowerArmWorld: Partial<Record<Side, Quaternion>> = {};
    const armConfidence: Partial<Record<Side, number>> = {};
    for (const side of ['left', 'right'] as const) {
      const s = body.get(`${side}Shoulder`)!;
      const e = body.get(`${side}Elbow`)!;
      const w = body.get(`${side}Wrist`)!;
      // A detected hand means the wrist is clearly in view even if pose visibility is modest —
      // but only when the pose also sees something there, so a hand never drags a hidden arm.
      const wristV = frame.hands[side] && w.v >= 0.25 ? Math.max(w.v, 0.8) : w.v;
      // The elbow is not required: in close-up webcam framing it is usually below the frame while
      // the raised hand is clearly visible. Then the elbow is reconstructed by two-bone IK.
      const conf = Math.min(s.v, wristV);
      armConfidence[side] = conf;
      if (!this.armGate[side].update(conf)) {
        this.armModes[side] = 'off';
        continue;
      }
      const shoulderWidth = ls.p.distanceTo(rs.p);
      const lengths = this.armLengths(side, s, e, w, shoulderWidth);
      let elbow = e.p;
      if (e.v < this.elbowMinVisibility) {
        elbow = solveElbowIK(s.p, w.p, lengths.upper, lengths.lower, this.elbowPole(side, s.p, e.p, w.p));
        this.armModes[side] = 'ik';
      } else {
        this.armModes[side] = 'measured';
      }
      const limb = this.solveLimb(`arm-${side}`, ARM_REST[side], s.p, elbow, w.p, chestWorld);
      bones.set(`${side}UpperArm`, limb.upperLocal);
      bones.set(`${side}LowerArm`, limb.lowerLocal);
      lowerArmWorld[side] = limb.lowerWorld;
    }

    // ---- legs
    if (this.options.legs && hipsVisible) {
      for (const side of ['left', 'right'] as const) {
        const h = body.get(`${side}Hip`)!;
        const k = body.get(`${side}Knee`)!;
        const a = body.get(`${side}Ankle`)!;
        if (!this.legGate[side].update(Math.min(h.v, k.v, a.v))) continue;
        const limb = this.solveLimb(`leg-${side}`, LEG_REST, h.p, k.p, a.p, hipsWorld);
        bones.set(`${side}UpperLeg`, limb.upperLocal);
        bones.set(`${side}LowerLeg`, limb.lowerLocal);
        const foot = solveFoot(body, side, limb.lowerWorld, this.options.minVisibility);
        if (foot) bones.set(`${side}Foot`, foot);
      }
    }

    return {
      bones,
      neckParentWorld: chestWorld,
      lowerArmWorld,
      confidence: shoulderConf,
      armConfidence,
    };
  }

  private armLengths(side: Side, s: AvatarPoint, e: AvatarPoint, w: AvatarPoint, shoulderWidth: number) {
    let l = this.learnedLengths[side];
    if (!l) {
      // Typical adult proportions relative to MediaPipe's shoulder-joint distance.
      l = { upper: shoulderWidth * 0.85, lower: shoulderWidth * 0.75 };
      this.learnedLengths[side] = l;
    }
    if (Math.min(s.v, e.v, w.v) > 0.7) {
      l.upper += (s.p.distanceTo(e.p) - l.upper) * 0.05;
      l.lower += (e.p.distanceTo(w.p) - l.lower) * 0.05;
    }
    return l;
  }

  /**
   * Bend direction for the IK elbow: MediaPipe still predicts an (occluded) elbow, which tells
   * which way the arm bends; blend it with an anatomical default (down, outward, slightly back).
   */
  private elbowPole(side: Side, s: Vector3, predictedElbow: Vector3, w: Vector3): Vector3 {
    const out = side === 'left' ? 1 : -1;
    const pole = new Vector3(0.35 * out, -1, -0.25).normalize();
    const axis = new Vector3().subVectors(w, s).normalize();
    const hint = new Vector3().subVectors(predictedElbow, s);
    hint.addScaledVector(axis, -hint.dot(axis));
    if (hint.length() > 0.03) pole.multiplyScalar(0.4).addScaledVector(hint.normalize(), 0.6);
    return pole.normalize();
  }

  private solveLimb(key: string, rest: LimbRest, root: Vector3, mid: Vector3, end: Vector3, parentWorld: Quaternion) {
    const d1 = _d1.subVectors(mid, root);
    const d2 = _d2.subVectors(end, mid);
    const n = _n.crossVectors(d1, d2);
    const sinBend = n.length() / Math.max(d1.length() * d2.length(), 1e-9);

    // Hinge-aligned world rotation fixes the upper segment's twist. When the limb is nearly
    // straight the bend plane is undefined, so the last reliable hinge keeps the twist stable;
    // with no history at all we fall back to the minimal (twist-free) rotation.
    let hinge = this.lastHinge.get(key);
    if (sinBend > 0.08) {
      const fresh = n.clone().normalize();
      // Blend in gently near the threshold to avoid a pop when the bend first becomes visible.
      hinge = hinge ? hinge.lerp(fresh, smoothstep(0.08, 0.3, sinBend)).normalize() : fresh;
      this.lastHinge.set(key, hinge);
    }
    const upperWorld = (hinge && frameRotation(rest.axis, rest.hinge, d1, hinge)) || fromTo(rest.axis, d1);

    const upperLocal = toLocal(parentWorld, upperWorld);
    // Forearm/shin direction in the upper segment's local frame, projected onto the hinge plane.
    const local = _v.copy(d2).applyQuaternion(_q.copy(upperWorld).invert());
    const projected = local.clone().addScaledVector(rest.hinge, -local.dot(rest.hinge));
    const lowerDir = projected.lengthSq() > 0.25 * local.lengthSq() ? projected : local;
    const lowerLocal = fromTo(rest.axis, lowerDir);
    const lowerWorld = upperWorld.clone().multiply(lowerLocal);
    return { upperLocal, lowerLocal, lowerWorld };
  }
}

/**
 * Two-bone IK: elbow position for a shoulder `s`, wrist `w`, segment lengths and a bend direction.
 * When the wrist is out of reach the arm is straightened toward it.
 */
export function solveElbowIK(s: Vector3, w: Vector3, upper: number, lower: number, pole: Vector3): Vector3 {
  const axis = new Vector3().subVectors(w, s);
  const dist = axis.length();
  if (dist < 1e-6) return s.clone().addScaledVector(pole, upper);
  axis.divideScalar(dist);
  const d = Math.min(Math.max(dist, Math.abs(upper - lower) + 1e-4), upper + lower - 1e-4);
  const along = (upper * upper - lower * lower + d * d) / (2 * d);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  const bend = pole.clone().addScaledVector(axis, -pole.dot(axis));
  if (bend.lengthSq() < 1e-8) bend.set(0, -1, 0).addScaledVector(axis, axis.y);
  bend.normalize();
  return s.clone().addScaledVector(axis, along).addScaledVector(bend, height);
}

/** Scale the pitch component (rotation about X) of a torso rotation by `scale`. */
function limitPitch(q: Quaternion, scale: number): void {
  if (scale >= 1) return;
  const forward = AXIS_Z.clone().applyQuaternion(q);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -forward.y)));
  const correction = new Quaternion().setFromAxisAngle(AXIS_X.clone().applyQuaternion(q), -pitch * (1 - scale));
  q.premultiply(correction).normalize();
}

function solveFoot(
  body: Map<BodyPointName, AvatarPoint>,
  side: Side,
  lowerLegWorld: Quaternion,
  minVis: number,
): Quaternion | null {
  const ankle = body.get(`${side}Ankle`)!;
  const toe = body.get(`${side}FootIndex`)!;
  if (Math.min(ankle.v, toe.v) < minVis) return null;
  // Rest foot points forward (+Z) from the ankle.
  const world = fromTo(AXIS_Z, new Vector3().subVectors(toe.p, ankle.p));
  return toLocal(lowerLegWorld, world);
}
