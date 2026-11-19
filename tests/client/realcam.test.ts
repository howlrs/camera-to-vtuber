import { describe, expect, it } from 'vitest';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { blendshapesToExpressions, DEFAULT_FACE_CALIBRATION } from '../../src/solver/FaceSolver.ts';
import { CoordinateSpace } from '../../src/coords/CoordinateSpace.ts';
import { headFromPose, MotionSolver } from '../../src/solver/MotionSolver.ts';
import type { AvatarPoint, BodyPointName, Landmark, TrackingFrame } from '../../src/core/types.ts';

// Regression cases from the guided real-camera session (2026-11-19).

const cal = DEFAULT_FACE_CALIBRATION;
const dominant = (shapes: Record<string, number>) => {
  const e = blendshapesToExpressions(shapes, cal);
  const vis = ['aa', 'ih', 'ou', 'ee', 'oh'].map((k) => [k, e.get(k) ?? 0] as const);
  return { top: vis.sort((a, b) => b[1] - a[1])[0][0], e };
};

describe('vowel classification', () => {
  it('あ: wide open jaw', () => expect(dominant({ jawOpen: 0.6 }).top).toBe('aa'));
  it('い: small opening with spread lips, and no smile', () => {
    const { top, e } = dominant({ jawOpen: 0.14, mouthSmileLeft: 0.7, mouthSmileRight: 0.7, mouthStretchLeft: 0.3, mouthStretchRight: 0.3 });
    expect(top).toBe('ih');
    expect(e.get('happy')!).toBeLessThan(0.3);
  });
  it('う: small rounded opening', () => expect(dominant({ jawOpen: 0.12, mouthPucker: 0.95, mouthFunnel: 0.2 }).top).toBe('ou'));
  it('え: medium opening with spread lips', () =>
    expect(dominant({ jawOpen: 0.38, mouthStretchLeft: 0.45, mouthStretchRight: 0.45, mouthSmileLeft: 0.3, mouthSmileRight: 0.3 }).top).toBe('ee'));
  it('お: medium rounded opening', () => expect(dominant({ jawOpen: 0.4, mouthFunnel: 0.4, mouthPucker: 0.8 }).top).toBe('oh'));
  it('keeps visemes from summing above 1', () => {
    const { e } = dominant({ jawOpen: 0.5, mouthFunnel: 0.3, mouthSmileLeft: 0.5, mouthSmileRight: 0.5 });
    const sum = ['aa', 'ih', 'ou', 'ee', 'oh'].reduce((t, k) => t + (e.get(k) ?? 0), 0);
    expect(sum).toBeLessThanOrEqual(1.0001);
  });
  it('a closed-mouth smile is still happy', () => {
    expect(blendshapesToExpressions({ jawOpen: 0.01, mouthSmileLeft: 0.8, mouthSmileRight: 0.8 }, cal).get('happy')!).toBeGreaterThan(0.7);
  });
  it('raised brows without wide eyes are only a hint of surprise', () => {
    const e = blendshapesToExpressions({ browInnerUp: 0.8, browOuterUpLeft: 0.8, browOuterUpRight: 0.8 }, cal);
    expect(e.get('surprised')!).toBeLessThan(0.4);
  });
});

describe('camera that delivers a flipped image', () => {
  // The performer winks their RIGHT eye; a flipped feed makes MediaPipe report "Left".
  const frame = (shapes: Record<string, number>): TrackingFrame => ({
    timestamp: 0, width: 1280, height: 720, face: { landmarks: [], blendshapes: shapes, matrix: null }, pose: null, hands: [], timings: {},
  });

  it('maps the performer’s right eye to the avatar’s left eye in mirror mode', () => {
    const c = new CoordinateSpace();
    c.options.mirror = true;
    c.options.inputMirrored = true;
    const s = c.convert(frame({ eyeBlinkLeft: 0.7, eyeBlinkRight: 0.1 })).blendshapes!;
    // flip = mirror XOR inputMirrored = false: sides pass through unchanged.
    expect(s.eyeBlinkLeft).toBe(0.7);
    expect(c.flip).toBe(false);
  });

  it('is equivalent to an unflipped camera when both are toggled', () => {
    const a = new CoordinateSpace();
    a.options.mirror = false;
    a.options.inputMirrored = false;
    const b = new CoordinateSpace();
    b.options.mirror = true;
    b.options.inputMirrored = true;
    const l: Landmark = { x: 0.3, y: -0.2, z: 0.1 };
    expect(a.toAvatar(l).toArray()).toEqual(b.toAvatar(l).toArray());
  });
});

describe('head fallback from pose', () => {
  const body = (yaw: number): Map<BodyPointName, AvatarPoint> => {
    const q = new Quaternion().setFromEuler(new Euler(0, yaw, 0));
    const pts: [BodyPointName, number, number, number][] = [
      ['leftEar', 0.075, 1.6, -0.02], ['rightEar', -0.075, 1.6, -0.02],
      ['leftEye', 0.03, 1.63, 0.08], ['rightEye', -0.03, 1.63, 0.08],
      ['leftMouth', 0.02, 1.54, 0.08], ['rightMouth', -0.02, 1.54, 0.08],
    ];
    return new Map(pts.map(([n, x, y, z]) => [n, { p: new Vector3(x, y, z).applyQuaternion(q), v: 0.9 }]));
  };

  it('recovers yaw from ears/eyes/mouth', () => {
    const q = headFromPose(body(0.5))!;
    expect(new Euler().setFromQuaternion(q, 'YXZ').y).toBeCloseTo(0.5, 1);
  });

  it('keeps the head turning while the face is lost', () => {
    const coords = new CoordinateSpace();
    coords.options.mirror = false;
    const solver = new MotionSolver();
    const space = (yaw: number, withFace: boolean, t: number) => {
      const s = coords.convert({ timestamp: t, width: 1, height: 1, face: null, pose: null, hands: [], timings: {} });
      s.body = body(yaw);
      if (withFace) s.head = { rotation: new Quaternion().setFromEuler(new Euler(0, yaw, 0)), confidence: 1 };
      return s;
    };
    for (let i = 0; i < 60; i++) solver.solve(space(0.1, true, i * 16));
    // The face is lost mid-turn; the head keeps turning ~6° per frame (a brisk real turn).
    let m = solver.solve(space(0.2, false, 61 * 16));
    for (let i = 1; i <= 4; i++) m = solver.solve(space(0.2 + i * 0.1, false, (61 + i) * 16));
    expect(new Euler().setFromQuaternion(m.headWorld!, 'YXZ').y).toBeGreaterThan(0.55);
  });
});

void Matrix4;

describe('raised hand with the elbow below the frame (close-up webcam)', () => {
  it('two-bone IK keeps segment lengths and reaches the wrist', async () => {
    const { solveElbowIK } = await import('../../src/solver/BodySolver.ts');
    const s = new Vector3(0.18, 1.4, 0);
    const w = new Vector3(0.3, 1.65, 0.1);
    const e = solveElbowIK(s, w, 0.28, 0.25, new Vector3(0.3, -1, -0.2).normalize());
    expect(e.distanceTo(s)).toBeCloseTo(0.28, 3);
    expect(e.distanceTo(w)).toBeCloseTo(0.25, 3);
    expect(e.y).toBeLessThan(w.y); // bends downward
  });

  it('moves the arm (and hand) from the shoulder + visible hand alone', async () => {
    const { BodySolver } = await import('../../src/solver/BodySolver.ts');
    const coords = new CoordinateSpace();
    coords.options.mirror = false;
    // Camera space (+x image right, +y down). Person's LEFT hand raised beside the face;
    // the elbow is predicted below the frame with low visibility.
    const world: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.9 }));
    const image: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
    const put = (i: number, wx: number, wy: number, ix: number, iy: number, v = 0.95) => {
      world[i] = { x: wx, y: wy, z: 0, visibility: v };
      image[i] = { x: ix, y: iy, z: 0, visibility: v };
    };
    put(11, 0.18, -0.45, 0.7, 0.95); put(12, -0.18, -0.45, 0.3, 0.95); // shoulders at the bottom edge
    put(13, 0.32, -0.2, 0.85, 1.25, 0.2); // elbow below the frame
    put(15, 0.24, -0.72, 0.75, 0.45, 0.45); // wrist beside the face, modest visibility
    put(23, 0.1, 0, 0.6, 1.6, 0.01); put(24, -0.1, 0, 0.4, 1.6, 0.01);
    const hand = { side: 'left' as const, landmarks: [{ x: 0.75, y: 0.45, z: 0 }], world: [], score: 0.9 };
    const f: TrackingFrame = { timestamp: 0, width: 1280, height: 720, face: null, pose: { landmarks: image, world }, hands: [hand], timings: {} };
    const solver = new BodySolver();
    const sol = solver.solve(coords.convert(f))!;
    expect(solver.armModes.left).toBe('ik');
    const q = new Quaternion();
    for (const b of ['spine', 'chest', 'upperChest', 'leftUpperArm', 'leftLowerArm'] as const) q.multiply(sol.bones.get(b) ?? new Quaternion());
    const forearm = new Vector3(1, 0, 0).applyQuaternion(q);
    expect(forearm.y).toBeGreaterThan(0.5); // forearm points clearly up toward the raised hand
    expect(sol.lowerArmWorld.left).toBeDefined(); // so the hand/fingers get solved too
  });
});
