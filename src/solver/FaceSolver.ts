import { MathUtils, Quaternion } from 'three';
import type { HumanBoneName } from '../core/types.ts';
import { remap01, scaleRotation, toLocal } from './math.ts';

/**
 * Face solver: head/neck rotation from the facial transformation matrix, VRM expressions from
 * ARKit-style blendshapes, and eye gaze. Blendshape sides are expected in the avatar's frame
 * (CoordinateSpace already swapped them when mirroring).
 */

export interface FaceCalibration {
  /** Blink blendshape value considered fully open / fully closed. */
  blinkOpen: number;
  blinkClosed: number;
  /** Max eye rotation in degrees for a full eyeLook* blendshape. */
  gazeYaw: number;
  gazePitch: number;
  /** Fraction of the head rotation given to the neck. */
  neckShare: number;
  /** Gaze at calibration time (camera beside the monitor), subtracted from the measured gaze. */
  gazeOffset: { yaw: number; pitch: number };
}

export const DEFAULT_FACE_CALIBRATION: FaceCalibration = {
  blinkOpen: 0.3,
  blinkClosed: 0.62,
  gazeYaw: 18,
  gazePitch: 12,
  neckShare: 0.35,
  gazeOffset: { yaw: 0, pitch: 0 },
};

export interface FaceSolution {
  bones: Map<HumanBoneName, Quaternion>;
  expressions: Map<string, number>;
  eye: { yaw: number; pitch: number };
}

export class FaceSolver {
  calibration: FaceCalibration = { ...DEFAULT_FACE_CALIBRATION, gazeOffset: { yaw: 0, pitch: 0 } };
  /** Last measured gaze before the offset (for calibration). */
  lastRawGaze = { yaw: 0, pitch: 0 };

  solve(
    headWorld: Quaternion | null,
    neckParentWorld: Quaternion,
    shapes: Record<string, number> | null,
  ): FaceSolution | null {
    if (!headWorld && !shapes) return null;
    const bones = new Map<HumanBoneName, Quaternion>();
    if (headWorld) {
      const total = toLocal(neckParentWorld, headWorld);
      const neck = scaleRotation(total, this.calibration.neckShare);
      const head = neck.clone().invert().multiply(total);
      bones.set('neck', neck);
      bones.set('head', head);
    }
    const expressions = shapes ? blendshapesToExpressions(shapes, this.calibration) : new Map<string, number>();
    let eye = { yaw: 0, pitch: 0 };
    if (shapes) {
      this.lastRawGaze = gaze(shapes, { ...this.calibration, gazeOffset: { yaw: 0, pitch: 0 } });
      eye = gaze(shapes, this.calibration);
    }
    return { bones, expressions, eye };
  }
}

const b = (s: Record<string, number>, k: string) => s[k] ?? 0;
const avg = (s: Record<string, number>, k: string) => (b(s, `${k}Left`) + b(s, `${k}Right`)) / 2;

/** ARKit 52 -> VRM 1.0 preset expressions. Left/right are the avatar's sides. */
export function blendshapesToExpressions(s: Record<string, number>, cal: FaceCalibration): Map<string, number> {
  const out = new Map<string, number>();

  // Eyes: stabilise near-symmetric blinks so the avatar doesn't wink from noise.
  let bl = remap01(b(s, 'eyeBlinkLeft'), cal.blinkOpen, cal.blinkClosed);
  let br = remap01(b(s, 'eyeBlinkRight'), cal.blinkOpen, cal.blinkClosed);
  if (Math.abs(bl - br) < 0.25) bl = br = (bl + br) / 2;
  out.set('blinkLeft', bl);
  out.set('blinkRight', br);

  // Mouth: classify by openness (jaw) x width (smile/stretch) x roundness (funnel/pucker).
  // あ wide open, い narrow+spread, う small+round, え medium+spread, お medium+round.
  const jaw = b(s, 'jawOpen');
  const funnel = b(s, 'mouthFunnel');
  const pucker = b(s, 'mouthPucker');
  const smile = avg(s, 'mouthSmile');
  const stretch = avg(s, 'mouthStretch');
  const speak = remap01(jaw, 0.04, 0.12); // mouth actually moving
  const open = remap01(jaw, 0.05, 0.55);
  const width = remap01(Math.max(smile, stretch * 1.2), 0.15, 0.6);
  // Pucker is very noisy on many faces; funnel carries most of the roundness signal.
  const round = Math.min(1, remap01(funnel, 0.05, 0.35) * 0.7 + remap01(pucker, 0.5, 0.95) * 0.4);
  const v = {
    aa: open * (1 - round * 0.8) * (1 - width * 0.5),
    ih: speak * width * (1 - round) * (1 - Math.min(1, open * 1.5)),
    ee: speak * width * (1 - round) * Math.min(1, open * 2.5),
    ou: speak * round * (1 - open),
    oh: speak * round * Math.min(1, open * 2),
  };
  const total = v.aa + v.ih + v.ee + v.ou + v.oh;
  const norm = total > 1 ? 1 / total : 1;
  for (const [k, val] of Object.entries(v)) out.set(k, val * norm);

  // Emotions. Spread lips while speaking (い/え) are not a smile; cheek squint still is.
  const smileRaw = remap01(smile + avg(s, 'cheekSquint') * 0.5, 0.35, 0.85);
  const happy = Math.max(smileRaw * (1 - 0.85 * speak * width), remap01(avg(s, 'cheekSquint'), 0.3, 0.7));
  // Raised brows alone (common while talking) give at most a hint of surprise; wide eyes make it.
  const brows = b(s, 'browInnerUp') * 0.5 + avg(s, 'browOuterUp') * 0.5;
  const surprised = remap01(brows, 0.35, 0.8) * (0.35 + 0.65 * remap01(avg(s, 'eyeWide'), 0.05, 0.35));
  const angry = remap01(avg(s, 'browDown') + avg(s, 'noseSneer') * 0.5, 0.35, 0.8);
  const sad = remap01(avg(s, 'mouthFrown') + b(s, 'browInnerUp') * 0.3 - smile, 0.3, 0.75);
  out.set('happy', happy);
  out.set('surprised', surprised * (1 - happy));
  out.set('angry', angry * (1 - happy));
  out.set('sad', sad * (1 - happy));
  return out;
}

/** Eye direction from eyeLook* blendshapes. +yaw = avatar's left, +pitch = down (VRM lookAt). */
export function gaze(s: Record<string, number>, cal: FaceCalibration): { yaw: number; pitch: number } {
  // Looking toward the avatar's left: left eye looks out, right eye looks in.
  const toLeft = (b(s, 'eyeLookOutLeft') + b(s, 'eyeLookInRight')) / 2;
  const toRight = (b(s, 'eyeLookInLeft') + b(s, 'eyeLookOutRight')) / 2;
  const down = avg(s, 'eyeLookDown');
  const up = avg(s, 'eyeLookUp');
  const off = cal.gazeOffset ?? { yaw: 0, pitch: 0 };
  return {
    yaw: MathUtils.clamp(MathUtils.clamp((toLeft - toRight) * 1.6, -1, 1) * cal.gazeYaw - off.yaw, -cal.gazeYaw, cal.gazeYaw),
    pitch: MathUtils.clamp(MathUtils.clamp((down - up) * 1.6, -1, 1) * cal.gazePitch - off.pitch, -cal.gazePitch, cal.gazePitch),
  };
}
