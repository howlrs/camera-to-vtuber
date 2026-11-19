import { Matrix4, Quaternion, Vector3 } from 'three';
import type {
  AvatarPoint,
  AvatarSpaceFrame,
  BodyPointName,
  Landmark,
  Side,
  TrackingFrame,
} from '../core/types.ts';

/**
 * Stage 2 of the pipeline: "座標化".
 *
 * MediaPipe camera space: +x = image right, +y = image down, +z = away from the camera.
 * Avatar space (VRM 1.0 / three.js): +X = avatar's left, +Y = up, +Z = toward the viewer.
 *
 * Unmirrored ("anatomical") mapping is a 180° rotation about X: (x, -y, -z).
 * Mirrored mapping additionally flips X and swaps left/right so the avatar behaves like a mirror
 * image of the performer (raise your right hand -> the hand on the same screen side rises).
 */

/** MediaPipe Pose landmark indices keyed by the person's anatomical side. */
const POSE_INDEX: Record<BodyPointName, number> = {
  nose: 0,
  leftEye: 2, rightEye: 5,
  leftEar: 7, rightEar: 8,
  leftMouth: 9, rightMouth: 10,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftPinky: 17, rightPinky: 18,
  leftIndex: 19, rightIndex: 20,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftFootIndex: 31, rightFootIndex: 32,
};

const BODY_POINTS = Object.keys(POSE_INDEX) as BodyPointName[];

export function swapSideName<T extends string>(name: T): T {
  if (name.startsWith('left')) return ('right' + name.slice(4)) as T;
  if (name.startsWith('right')) return ('left' + name.slice(5)) as T;
  return name;
}

export function otherSide(side: Side): Side {
  return side === 'left' ? 'right' : 'left';
}

/** Swap "Left"/"Right" suffixes of ARKit blendshape names (eyeBlinkLeft <-> eyeBlinkRight). */
export function swapBlendshapeSides(src: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(src)) {
    const key = k.endsWith('Left') ? k.slice(0, -4) + 'Right' : k.endsWith('Right') ? k.slice(0, -5) + 'Left' : k;
    out[key] = v;
  }
  return out;
}

export interface CoordinateOptions {
  /** Output behaves like a mirror image of the performer. */
  mirror: boolean;
  /**
   * The camera itself delivers a horizontally flipped image (some webcams/drivers do). MediaPipe
   * then sees a mirror-image person whose left/right are swapped; flipping once more undoes it.
   */
  inputMirrored: boolean;
  /**
   * MediaPipe's per-side blendshapes are named for the *image* side on unmirrored input in some
   * model versions. When true, "...Left" blendshapes are treated as the image-left side.
   */
  blendshapeImageSides: boolean;
}

export class CoordinateSpace {
  options: CoordinateOptions = { mirror: true, inputMirrored: false, blendshapeImageSides: false };
  /** Inverse of the camera tilt captured during calibration (applied to every vector/rotation). */
  readonly calibration = new Quaternion();

  private readonly tmpM = new Matrix4();
  private readonly tmpQ = new Quaternion();
  private readonly tmpP = new Vector3();
  private readonly tmpS = new Vector3();

  /** Whether X is flipped / sides swapped between MediaPipe's view and the avatar. */
  get flip(): boolean {
    return this.options.mirror !== this.options.inputMirrored;
  }

  /** Convert a camera-space vector (world landmark) to avatar space. */
  toAvatar(l: Landmark, out = new Vector3()): Vector3 {
    out.set(this.flip ? -l.x : l.x, -l.y, -l.z);
    return out.applyQuaternion(this.calibration);
  }

  /**
   * Head rotation from the facial transformation matrix. MediaPipe's metric space is already
   * right-handed with +y up and +z toward the camera, i.e. the avatar convention for the
   * unmirrored case; mirroring reflects X which maps quaternion (x, y, z, w) -> (x, -y, -z, w).
   */
  headRotation(matrix: number[], out = new Quaternion()): Quaternion {
    this.tmpM.fromArray(matrix);
    this.tmpM.decompose(this.tmpP, this.tmpQ, this.tmpS);
    out.copy(this.tmpQ);
    if (this.flip) out.set(out.x, -out.y, -out.z, out.w);
    return out.premultiply(this.calibration).normalize();
  }

  /** Sides in the *output* (avatar) frame for a person's anatomical side. */
  avatarSide(personSide: Side): Side {
    return this.flip ? otherSide(personSide) : personSide;
  }

  /**
   * Capture the current head orientation as "looking straight at the screen", compensating for a
   * camera placed above/below/beside the monitor. Pass the latest *calibrated* head rotation
   * (as produced by headRotation); repeated calibration composes correctly.
   */
  calibrate(currentHeadRotation: Quaternion): void {
    // R_true = C^-1 * R_observed. With R_cal = C_old * R_obs, the new C = R_cal^-1 * C_old.
    this.calibration.premultiply(currentHeadRotation.clone().invert()).normalize();
  }

  resetCalibration(): void {
    this.calibration.identity();
  }

  convert(frame: TrackingFrame): AvatarSpaceFrame {
    const out: AvatarSpaceFrame = {
      timestamp: frame.timestamp,
      head: null,
      blendshapes: null,
      body: null,
      hands: {},
      handScores: {},
    };

    if (frame.face) {
      if (frame.face.matrix) {
        out.head = { rotation: this.headRotation(frame.face.matrix), confidence: 1 };
      }
      // Blendshape sides: normalize to the person's anatomical side, then to the avatar's side.
      let shapes = frame.face.blendshapes;
      if (this.options.blendshapeImageSides) shapes = swapBlendshapeSides(shapes);
      if (this.flip) shapes = swapBlendshapeSides(shapes);
      out.blendshapes = shapes;
    }

    if (frame.pose && frame.pose.world.length >= 33) {
      const body = new Map<BodyPointName, AvatarPoint>();
      for (const name of BODY_POINTS) {
        const lm = frame.pose.world[POSE_INDEX[name]];
        const imageLm = frame.pose.landmarks[POSE_INDEX[name]];
        // Shoulders just below the bottom edge (close-up webcam framing) are extrapolated well
        // enough to orient the torso; other points must be on screen.
        const v = Math.min(lm.visibility ?? imageLm?.visibility ?? 1, onScreen(imageLm, name.endsWith('Shoulder')));
        body.set(this.flip ? swapSideName(name) : name, { p: this.toAvatar(lm), v });
      }
      out.body = body;
    }

    for (const hand of frame.hands) {
      const side = this.avatarSide(hand.side);
      out.hands[side] = hand.world.map((l) => this.toAvatar(l));
      out.handScores[side] = hand.score;
    }
    return out;
  }
}

/** Landmarks MediaPipe extrapolates outside the frame are unreliable; fade them out. */
export function onScreen(l: Landmark | undefined, lenientBottom = false): number {
  if (!l) return 0;
  const margin = 0.02;
  if (l.x < -margin || l.x > 1 + margin || l.y < -margin) return 0.1;
  if (l.y <= 1 + margin) return 1;
  return lenientBottom ? Math.max(0.1, Math.min(1, (1.3 - l.y) / 0.28)) : 0.1;
}

export { POSE_INDEX };
