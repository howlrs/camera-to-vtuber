import {
  FaceLandmarker,
  HandLandmarker,
  type NormalizedLandmark,
  PoseLandmarker,
} from '@mediapipe/tasks-vision';
import type { HandObservation, Landmark, Side, TrackingFrame } from '../core/types.ts';
import { HandIdentityTracker } from './HandIdentity.ts';
import type { Tracker, TrackerInitContext } from './Tracker.ts';

const copy = (l: NormalizedLandmark): Landmark => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility });

/**
 * 478 face landmarks + 52 blendshapes + facial transformation matrix.
 *
 * MediaPipe's face detector is short-range: in upper-body/full-body framing the face is too small
 * to be found. When pose landmarks are available and the head is small in the frame, the head
 * region (from nose/eyes/ears) is cropped, upscaled and tracked instead, then mapped back.
 * Requires the pose tracker to run first in the same frame.
 */
export class FaceTracker implements Tracker {
  readonly id = 'face';
  enabled = true;
  interval = 1;
  /** Head box size relative to frame width below which cropping kicks in (far subjects only). */
  cropBelow = 0.2;
  cropAbove = 0.28;
  private task: FaceLandmarker | null = null;
  private last: TrackingFrame['face'] = null;
  private frame = 0;
  private cropping = false;
  private canvas = document.createElement('canvas');

  async init({ fileset, delegate, modelBase }: TrackerInitContext): Promise<void> {
    this.canvas.width = this.canvas.height = 384;
    this.task = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${modelBase}/face_landmarker.task`, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  }

  detect(video: HTMLVideoElement, ts: number, out: TrackingFrame): void {
    if (!this.task) return;
    if (this.frame++ % this.interval === 0) {
      const W = video.videoWidth;
      const H = video.videoHeight;
      const box = headBox(out.pose?.landmarks, W, H);
      if (!box) this.cropping = false;
      else if (this.cropping && box.size / W > this.cropAbove) this.cropping = false;
      else if (!this.cropping && box.size / W < this.cropBelow) this.cropping = true;

      let input: HTMLVideoElement | HTMLCanvasElement = video;
      let map = (l: NormalizedLandmark): Landmark => copy(l);
      if (this.cropping && box) {
        const S = this.canvas.width;
        const g = this.canvas.getContext('2d')!;
        g.fillStyle = '#000';
        g.fillRect(0, 0, S, S);
        g.drawImage(video, box.x, box.y, box.size, box.size, 0, 0, S, S);
        input = this.canvas;
        map = (l) => ({ x: (box.x + l.x * box.size) / W, y: (box.y + l.y * box.size) / H, z: (l.z * box.size) / W });
      }
      const r = this.task.detectForVideo(input, ts);
      if (r.faceLandmarks.length) {
        const shapes: Record<string, number> = {};
        for (const c of r.faceBlendshapes[0]?.categories ?? []) shapes[c.categoryName] = c.score;
        this.last = {
          landmarks: r.faceLandmarks[0].map(map),
          blendshapes: shapes,
          matrix: r.facialTransformationMatrixes?.[0]?.data ? Array.from(r.facialTransformationMatrixes[0].data) : null,
        };
      } else {
        this.last = null;
      }
    }
    out.face = this.last;
  }

  get mode(): 'full' | 'crop' {
    return this.cropping ? 'crop' : 'full';
  }

  close(): void {
    this.task?.close();
    this.task = null;
  }
}

/**
 * Square head region in pixels from pose landmarks (0 nose, 2/5 eyes, 7/8 ears, 9/10 mouth).
 * Uses the largest of several size cues so turning the head (ears overlapping) doesn't shrink it.
 */
export function headBox(pose: Landmark[] | undefined, W: number, H: number): { x: number; y: number; size: number } | null {
  if (!pose || pose.length < 11) return null;
  const nose = pose[0];
  if ((nose.visibility ?? 1) < 0.5) return null;
  const px = (i: number) => ({ x: pose[i].x * W, y: pose[i].y * H });
  const ears = Math.hypot(px(7).x - px(8).x, px(7).y - px(8).y);
  const eyes = Math.hypot(px(2).x - px(5).x, px(2).y - px(5).y);
  const eyeMid = { x: (px(2).x + px(5).x) / 2, y: (px(2).y + px(5).y) / 2 };
  const mouthMid = { x: (px(9).x + px(10).x) / 2, y: (px(9).y + px(10).y) / 2 };
  const eyeToMouth = Math.hypot(eyeMid.x - mouthMid.x, eyeMid.y - mouthMid.y);
  const width = Math.max(ears, eyes * 2.2, eyeToMouth * 3.2);
  if (!(width > 4)) return null;
  const size = width * 2.4;
  const n = px(0);
  return { x: n.x - size / 2, y: n.y - size * 0.55, size };
}

/** 33 pose landmarks (image + world). */
export class PoseTracker implements Tracker {
  readonly id = 'pose';
  enabled = true;
  interval = 1;
  /** 'lite' is faster; 'full' is more accurate. */
  variant: 'lite' | 'full' = 'full';
  private task: PoseLandmarker | null = null;
  private last: TrackingFrame['pose'] = null;
  private frame = 0;

  async init({ fileset, delegate, modelBase }: TrackerInitContext): Promise<void> {
    this.task = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${modelBase}/pose_landmarker_${this.variant}.task`, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  detect(video: HTMLVideoElement, ts: number, out: TrackingFrame): void {
    if (!this.task) return;
    if (this.frame++ % this.interval === 0) {
      const r = this.task.detectForVideo(video, ts);
      this.last = r.landmarks.length
        ? { landmarks: r.landmarks[0].map(copy), world: r.worldLandmarks[0].map(copy) }
        : null;
    }
    out.pose = this.last;
  }

  close(): void {
    this.task?.close();
    this.task = null;
  }
}

/**
 * Up to two hands. MediaPipe labels handedness assuming a mirrored selfie image, so the label is
 * inverted to get the anatomical side for our (unmirrored) view; HandIdentityTracker then combines
 * that label with pose anchors and frame-to-frame continuity to decide left/right.
 */
export class HandTracker implements Tracker {
  readonly id = 'hands';
  enabled = true;
  interval = 1;
  private task: HandLandmarker | null = null;
  private last: HandObservation[] = [];
  /** Tracks which detected hand is left/right across frames (thumb/pinky anchors + continuity). */
  readonly identity = new HandIdentityTracker();
  private frame = 0;

  async init({ fileset, delegate, modelBase }: TrackerInitContext): Promise<void> {
    this.task = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${modelBase}/hand_landmarker.task`, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  detect(video: HTMLVideoElement, ts: number, out: TrackingFrame): void {
    if (!this.task) return;
    if (this.frame++ % this.interval === 0) {
      const r = this.task.detectForVideo(video, ts);
      const hands: HandObservation[] = [];
      r.landmarks.forEach((lms, i) => {
        const label = r.handedness[i]?.[0];
        const labelSide: Side = label?.categoryName === 'Left' ? 'right' : 'left';
        hands.push({
          side: labelSide,
          landmarks: lms.map(copy),
          world: (r.worldLandmarks[i] ?? []).map(copy),
          score: label?.score ?? 0.5,
        });
      });
      this.last = hands;
    }
    out.hands = this.identity.assign(this.last, out.pose?.landmarks, ts / 1000);
  }

  close(): void {
    this.task?.close();
    this.task = null;
  }
}

/** Stateless side assignment (single frame) — see HandIdentityTracker for the tracked version. */
export function assignSides(hands: HandObservation[], pose: Landmark[] | undefined): HandObservation[] {
  return new HandIdentityTracker().assign(hands, pose, 0);
}
