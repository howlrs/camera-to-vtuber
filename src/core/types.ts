import type { Quaternion, Vector3 } from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';

export type HumanBoneName = VRMHumanBoneName;
export type Side = 'left' | 'right';

/** A MediaPipe landmark. Image landmarks are normalized 0..1; world landmarks are meters. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

// ------------------------------------------------------------------ stage 1: raw observations

export interface FaceObservation {
  /** 478 normalized image landmarks. */
  landmarks: Landmark[];
  /** 52 ARKit-style blendshape scores keyed by category name. */
  blendshapes: Record<string, number>;
  /** 4x4 column-major facial transformation matrix (canonical face -> camera metric space). */
  matrix: number[] | null;
}

export interface PoseObservation {
  /** 33 normalized image landmarks. */
  landmarks: Landmark[];
  /** 33 world landmarks in meters, origin at hip center, camera axes. */
  world: Landmark[];
}

export interface HandObservation {
  /** Anatomical side of the person (already corrected for MediaPipe's selfie assumption). */
  side: Side;
  landmarks: Landmark[];
  world: Landmark[];
  score: number;
}

/** Everything the trackers saw in one camera frame (image/camera coordinate conventions). */
export interface TrackingFrame {
  timestamp: number;
  width: number;
  height: number;
  face: FaceObservation | null;
  pose: PoseObservation | null;
  hands: HandObservation[];
  /** Per-tracker processing time in ms. */
  timings: Record<string, number>;
}

// ------------------------------------------------------------------ stage 2: avatar space

export interface AvatarPoint {
  p: Vector3;
  /** 0..1 confidence. */
  v: number;
}

/**
 * Observations converted into avatar space (+X = avatar's left, +Y up, +Z = avatar forward
 * toward the viewer), with sides already swapped when mirroring. Keys use avatar-side names.
 */
export interface AvatarSpaceFrame {
  timestamp: number;
  head: { rotation: Quaternion; confidence: number } | null;
  blendshapes: Record<string, number> | null;
  body: Map<BodyPointName, AvatarPoint> | null;
  hands: Partial<Record<Side, Vector3[]>>;
  handScores: Partial<Record<Side, number>>;
}

export type BodyPointName =
  | 'nose'
  | 'leftEye' | 'rightEye'
  | 'leftEar' | 'rightEar'
  | 'leftMouth' | 'rightMouth'
  | 'leftShoulder' | 'rightShoulder'
  | 'leftElbow' | 'rightElbow'
  | 'leftWrist' | 'rightWrist'
  | 'leftIndex' | 'rightIndex'
  | 'leftPinky' | 'rightPinky'
  | 'leftHip' | 'rightHip'
  | 'leftKnee' | 'rightKnee'
  | 'leftAnkle' | 'rightAnkle'
  | 'leftFootIndex' | 'rightFootIndex';

// ------------------------------------------------------------------ stage 3: motion

/**
 * Pose of a VRM-normalized humanoid: local rotations relative to a T-pose whose bones all have
 * identity rest rotations (three-vrm "normalized bones"), plus expression weights.
 */
export interface MotionFrame {
  bones: Map<HumanBoneName, Quaternion>;
  /** Hips translation offset from rest, meters (avatar space). */
  hipsOffset: Vector3 | null;
  /** VRM expression name -> 0..1 */
  expressions: Map<string, number>;
  /** Eye direction in degrees (VRM lookAt: +yaw = avatar left, +pitch = down). */
  eye: { yaw: number; pitch: number } | null;
  /**
   * Head orientation in avatar space. The smoother filters this in world space and re-derives the
   * neck/head locals from the *smoothed* torso, so torso jitter never shakes the face.
   */
  headWorld: Quaternion | null;
  confidence: { face: number; body: number; left: number; right: number };
}

export function emptyMotion(): MotionFrame {
  return {
    bones: new Map(),
    hipsOffset: null,
    expressions: new Map(),
    eye: null,
    headWorld: null,
    confidence: { face: 0, body: 0, left: 0, right: 0 },
  };
}
