import { Quaternion, Vector3 } from 'three';
import type { AvatarPoint, AvatarSpaceFrame, BodyPointName, MotionFrame } from '../core/types.ts';
import { AXIS_X, AXIS_Y, frameRotation } from './math.ts';
import { emptyMotion } from '../core/types.ts';
import { BodySolver } from './BodySolver.ts';
import { FaceSolver } from './FaceSolver.ts';
import { HandSolver } from './HandSolver.ts';
import { BlendshapeBaseline, RotationSpikeGate } from './Stabilizers.ts';

/**
 * Stage 3: avatar-space observations -> MotionFrame (VRM normalized local rotations + expressions).
 * Each sub-solver is replaceable; the MotionSolver only wires their dependencies
 * (body -> neck parent for the head, lower-arm world rotation for the hands).
 */
export class MotionSolver {
  readonly body = new BodySolver();
  readonly face = new FaceSolver();
  readonly hand = new HandSolver();
  readonly baseline = new BlendshapeBaseline();
  readonly headGate = new RotationSpikeGate();
  enableHands = true;
  private lastT = 0;
  /** Chest orientation used for the head when the torso is not visible this frame. */
  private neckParent = new Quaternion();
  /** Learned rotation from the pose-derived head frame to the face-matrix head frame. */
  private headOffset: Quaternion | null = null;

  solve(frame: AvatarSpaceFrame): MotionFrame {
    const motion = emptyMotion();
    const t = frame.timestamp / 1000;
    const dt = this.lastT ? Math.min(0.5, Math.max(0, t - this.lastT)) : 0;
    this.lastT = t;
    const body = this.body.solve(frame);
    // Keep the head's reference frame continuous when the torso flickers in/out of view.
    if (body) this.neckParent.copy(body.neckParentWorld);
    else this.neckParent.slerp(IDENTITY, 1 - Math.exp(-2 * dt));
    if (body) {
      for (const [k, q] of body.bones) motion.bones.set(k, q);
      motion.confidence.body = body.confidence;
    }

    // Face matrix is primary; when the face is lost (large turns), fall back to a head frame
    // from pose ears/eyes/mouth, corrected by the offset learned while both were available.
    let headRot = frame.head?.rotation ?? null;
    const poseHead = frame.body ? headFromPose(frame.body) : null;
    if (headRot && poseHead) {
      const target = headRot.clone().multiply(poseHead.clone().invert());
      this.headOffset = this.headOffset ? this.headOffset.slerp(target, 0.05) : target;
    } else if (!headRot && poseHead && this.headOffset) {
      headRot = this.headOffset.clone().multiply(poseHead);
    }
    if (!headRot) this.headGate.reset();
    const head = headRot ? this.headGate.filter(headRot) : null;
    const shapes = frame.blendshapes ? this.baseline.apply(frame.blendshapes, dt) : null;
    const face = this.face.solve(head, this.neckParent, shapes);
    motion.headWorld = head ? head.clone() : null;
    if (face) {
      for (const [k, q] of face.bones) motion.bones.set(k, q);
      for (const [k, v] of face.expressions) motion.expressions.set(k, v);
      motion.eye = face.eye;
      motion.confidence.face = frame.head?.confidence ?? (head ? 0.4 : 0);
    }

    if (this.enableHands && body) {
      for (const side of ['left', 'right'] as const) {
        if (!body.lowerArmWorld[side]) continue;
        const hand = this.hand.solve(side, frame.hands[side], body.lowerArmWorld[side], frame.body);
        if (!hand) continue;
        for (const [k, q] of hand.bones) motion.bones.set(k, q);
        motion.confidence[side] = frame.handScores[side] ?? body.armConfidence[side] ?? 0;
      }
    }
    return motion;
  }

  /** Treat the current face as neutral: blendshape baseline and gaze offset. */
  calibrateNeutral(rawShapes: Record<string, number> | null): void {
    if (rawShapes) this.baseline.capture(rawShapes);
    this.face.calibration.gazeOffset = { ...this.face.lastRawGaze };
  }

  resetCalibration(): void {
    this.baseline.reset();
    this.face.calibration.gazeOffset = { yaw: 0, pitch: 0 };
  }
}

const IDENTITY = new Quaternion();

/** Coarse head orientation from pose landmarks: X = right ear -> left ear, Y = mouth -> eyes. */
export function headFromPose(body: Map<BodyPointName, AvatarPoint>): Quaternion | null {
  const g = (n: BodyPointName) => body.get(n);
  const le = g('leftEar'), re = g('rightEar'), ly = g('leftEye'), ry = g('rightEye'), lm = g('leftMouth'), rm = g('rightMouth');
  if (!le || !re || !ly || !ry || !lm || !rm) return null;
  if (Math.min(le.v, re.v, ly.v, ry.v, lm.v, rm.v) < 0.3) return null;
  const across = new Vector3().subVectors(le.p, re.p);
  const up = new Vector3().addVectors(ly.p, ry.p).sub(lm.p).sub(rm.p);
  return frameRotation(AXIS_X, AXIS_Y, across, up);
}
