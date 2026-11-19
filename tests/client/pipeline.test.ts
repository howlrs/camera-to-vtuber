import { describe, expect, it } from 'vitest';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { CoordinateSpace, swapBlendshapeSides } from '../../src/coords/CoordinateSpace.ts';
import { OneEuroFilter, QuaternionFilter } from '../../src/coords/filters.ts';
import { BodySolver } from '../../src/solver/BodySolver.ts';
import { blendshapesToExpressions, DEFAULT_FACE_CALIBRATION, gaze } from '../../src/solver/FaceSolver.ts';
import { HandSolver } from '../../src/solver/HandSolver.ts';
import { MotionSolver } from '../../src/solver/MotionSolver.ts';
import { ExpressionMixer } from '../../src/avatar/ExpressionMixer.ts';
import { categorizeMaterial } from '../../src/avatar/AvatarRig.ts';
import { assignSides } from '../../src/tracking/MediaPipeTrackers.ts';
import type { HandObservation, Landmark, TrackingFrame } from '../../src/core/types.ts';

// ----------------------------------------------------------------- synthetic MediaPipe data
// Camera space: +x image right, +y down, +z away from camera. A person facing the camera has
// their LEFT side on the image RIGHT (+x).

type Pts = Partial<Record<number, [number, number, number]>>;

function poseWorld(overrides: Pts = {}): Landmark[] {
  const base: Pts = {
    0: [0, -0.65, -0.05],
    11: [0.2, -0.5, 0], 12: [-0.2, -0.5, 0], // shoulders
    13: [0.45, -0.5, 0], 14: [-0.45, -0.5, 0], // elbows (T-pose)
    15: [0.7, -0.5, 0], 16: [-0.7, -0.5, 0], // wrists
    17: [0.78, -0.5, 0.02], 18: [-0.78, -0.5, 0.02], // pinky (toward the back)
    19: [0.78, -0.5, -0.02], 20: [-0.78, -0.5, -0.02], // index (toward the camera)
    23: [0.1, 0, 0], 24: [-0.1, 0, 0],
    25: [0.1, 0.45, 0], 26: [-0.1, 0.45, 0],
    27: [0.1, 0.9, 0], 28: [-0.1, 0.9, 0],
    31: [0.1, 0.95, -0.1], 32: [-0.1, 0.95, -0.1],
  };
  const all = { ...base, ...overrides };
  return Array.from({ length: 33 }, (_, i) => {
    const p = all[i] ?? [0, 0, 0];
    return { x: p[0], y: p[1], z: p[2], visibility: 0.99 };
  });
}

function frame(world: Landmark[], extra: Partial<TrackingFrame> = {}): TrackingFrame {
  const image = world.map((l) => ({ x: 0.5 + l.x * 0.4, y: 0.6 + l.y * 0.4, z: l.z, visibility: l.visibility }));
  return { timestamp: 0, width: 1280, height: 720, face: null, pose: { landmarks: image, world }, hands: [], timings: {}, ...extra };
}

const deg = (r: number) => (r * 180) / Math.PI;
/** Direction a bone's rest axis ends up pointing to in avatar space. */
function worldDir(...chain: (Quaternion | undefined)[]): (rest: Vector3) => Vector3 {
  const q = new Quaternion();
  for (const c of chain) if (c) q.multiply(c);
  return (rest) => rest.clone().applyQuaternion(q);
}

function solve(world: Landmark[], mirror: boolean, legs = false) {
  const coords = new CoordinateSpace();
  coords.options.mirror = mirror;
  const solver = new BodySolver();
  solver.options.legs = legs;
  return solver.solve(coords.convert(frame(world)))!;
}

// ----------------------------------------------------------------- coordinates

describe('CoordinateSpace', () => {
  it('maps camera space to avatar space without mirroring as a 180° turn about X', () => {
    const c = new CoordinateSpace();
    c.options.mirror = false;
    expect(c.toAvatar({ x: 0.3, y: -0.5, z: 0.2 }).toArray()).toEqual([0.3, 0.5, -0.2]);
  });

  it('mirrors X and swaps anatomical sides when mirroring', () => {
    const c = new CoordinateSpace();
    c.options.mirror = true;
    const space = c.convert(frame(poseWorld()));
    // The person's LEFT shoulder (+x in camera) becomes the avatar's RIGHT shoulder at -X.
    expect(space.body!.get('rightShoulder')!.p.x).toBeCloseTo(-0.2);
    expect(space.body!.get('leftShoulder')!.p.x).toBeCloseTo(0.2);
    expect(c.avatarSide('left')).toBe('right');
  });

  it('keeps the avatar facing the viewer for an identity face matrix, and mirrors yaw', () => {
    const c = new CoordinateSpace();
    const yaw = new Matrix4().makeRotationY(0.4);
    c.options.mirror = false;
    const q1 = c.headRotation(yaw.toArray());
    expect(new Euler().setFromQuaternion(q1).y).toBeCloseTo(0.4);
    c.options.mirror = true;
    const q2 = c.headRotation(yaw.toArray());
    expect(new Euler().setFromQuaternion(q2).y).toBeCloseTo(-0.4);
    expect(c.headRotation(new Matrix4().toArray()).angleTo(new Quaternion())).toBeCloseTo(0);
  });

  it('calibration makes the current head pose neutral and composes on repeat', () => {
    const c = new CoordinateSpace();
    const tilted = new Matrix4().makeRotationX(0.3).toArray();
    c.calibrate(c.headRotation(tilted));
    expect(c.headRotation(tilted).angleTo(new Quaternion())).toBeLessThan(1e-6);
    c.calibrate(c.headRotation(tilted)); // second calibration at the same pose is a no-op
    expect(c.headRotation(tilted).angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('swaps Left/Right blendshape suffixes', () => {
    expect(swapBlendshapeSides({ eyeBlinkLeft: 1, jawOpen: 0.5 })).toEqual({ eyeBlinkRight: 1, jawOpen: 0.5 });
  });
});

// ----------------------------------------------------------------- body

describe('BodySolver', () => {
  it('produces identity arm rotations for a T-pose', () => {
    const sol = solve(poseWorld(), false);
    for (const b of ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'] as const) {
      expect(deg(sol.bones.get(b)!.angleTo(new Quaternion()))).toBeLessThan(1);
    }
  });

  it('points the upper arm down when the arm hangs', () => {
    const sol = solve(poseWorld({ 13: [0.22, -0.2, 0], 15: [0.24, 0.05, 0] }), false);
    const dir = worldDir(sol.bones.get('spine'), sol.bones.get('chest'), sol.bones.get('upperChest'), sol.bones.get('leftUpperArm'))(new Vector3(1, 0, 0));
    expect(dir.y).toBeLessThan(-0.95); // left arm (rest +X) now points down
  });

  it('bends the elbow as a pure hinge toward the camera', () => {
    // Left forearm points toward the camera (camera z negative) from a T-pose upper arm.
    const sol = solve(poseWorld({ 15: [0.45, -0.5, -0.25] }), false);
    const lower = sol.bones.get('leftLowerArm')!;
    const axis = new Vector3(lower.x, lower.y, lower.z).normalize();
    expect(Math.abs(axis.y)).toBeGreaterThan(0.99); // rotation purely about the hinge (Y)
    expect(deg(2 * Math.acos(Math.min(1, Math.abs(lower.w))))).toBeCloseTo(90, 0);
    const dir = worldDir(sol.bones.get('leftUpperArm'), lower)(new Vector3(1, 0, 0));
    expect(dir.z).toBeGreaterThan(0.95); // forearm toward the viewer (+Z)
  });

  it('raises the avatar LEFT arm when a mirrored performer raises their RIGHT arm', () => {
    const sol = solve(poseWorld({ 14: [-0.2, -0.75, 0], 16: [-0.2, -1.0, 0] }), true);
    const left = worldDir(sol.bones.get('spine'), sol.bones.get('chest'), sol.bones.get('upperChest'), sol.bones.get('leftUpperArm'))(new Vector3(1, 0, 0));
    const right = worldDir(sol.bones.get('rightUpperArm'))(new Vector3(-1, 0, 0));
    expect(left.y).toBeGreaterThan(0.95);
    expect(Math.abs(right.y)).toBeLessThan(0.1);
  });

  it('solves legs only in full-body mode', () => {
    expect(solve(poseWorld(), false, false).bones.has('leftUpperLeg')).toBe(false);
    const sol = solve(poseWorld({ 25: [0.1, 0.4, -0.2], 27: [0.1, 0.8, -0.15] }), false, true);
    const thigh = worldDir(sol.bones.get('hips'), sol.bones.get('leftUpperLeg'))(new Vector3(0, -1, 0));
    expect(thigh.z).toBeGreaterThan(0.3); // knee forward toward the viewer
  });

  it('turns the torso with the shoulder line (yaw)', () => {
    const sol = solve(poseWorld({ 11: [0.17, -0.5, 0.1], 12: [-0.17, -0.5, -0.1] }), false);
    const chest = worldDir(sol.bones.get('spine'), sol.bones.get('chest'), sol.bones.get('upperChest'))(new Vector3(0, 0, 1));
    // Left shoulder moved away from the camera: the chest faces toward the avatar's left (+X).
    expect(chest.x).toBeGreaterThan(0.3);
  });
});

// ----------------------------------------------------------------- hands

function handPoints(curl: number): Vector3[] {
  // Avatar-space left hand at rest: fingers along +X, index toward +Z, palm facing -Y.
  const pts: Vector3[] = Array.from({ length: 21 }, () => new Vector3());
  const bases = { 5: 0.025, 9: 0, 13: -0.02, 17: -0.038 } as Record<number, number>;
  for (const mcp of [5, 9, 13, 17]) {
    let p = new Vector3(0.08, 0, bases[mcp]);
    let dir = new Vector3(1, 0, 0);
    pts[mcp] = p.clone();
    for (let j = 1; j <= 3; j++) {
      dir = dir.clone().applyAxisAngle(new Vector3(0, 0, 1), -curl); // curl toward -Y
      p = p.clone().addScaledVector(dir, 0.025);
      pts[mcp + j] = p.clone();
    }
  }
  pts[1] = new Vector3(0.02, 0, 0.03);
  pts[2] = new Vector3(0.04, 0, 0.05);
  pts[3] = new Vector3(0.06, 0, 0.065);
  pts[4] = new Vector3(0.08, 0, 0.075);
  return pts;
}

describe('HandSolver', () => {
  it('leaves a flat hand nearly straight and identity at the wrist', () => {
    const sol = new HandSolver().solve('left', handPoints(0), new Quaternion(), null)!;
    expect(deg(sol.bones.get('leftHand')!.angleTo(new Quaternion()))).toBeLessThan(2);
    expect(deg(sol.bones.get('leftIndexIntermediate')!.angleTo(new Quaternion()))).toBeLessThan(2);
  });

  it('curls fingers toward the palm (-Y) for a fist', () => {
    const sol = new HandSolver().solve('left', handPoints(1.2), new Quaternion(), null)!;
    const tip = new Vector3(1, 0, 0).applyQuaternion(sol.bones.get('leftMiddleIntermediate')!);
    expect(tip.y).toBeLessThan(-0.8);
  });
});

// ----------------------------------------------------------------- face

describe('FaceSolver', () => {
  const cal = DEFAULT_FACE_CALIBRATION;

  it('maps blink and jaw to VRM expressions', () => {
    const e = blendshapesToExpressions({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9, jawOpen: 0.6 }, cal);
    expect(e.get('blinkLeft')).toBe(1);
    expect(e.get('aa')).toBeGreaterThan(0.9);
    expect(e.get('happy')).toBe(0);
  });

  it('keeps a real wink but symmetrises noise', () => {
    const wink = blendshapesToExpressions({ eyeBlinkLeft: 0.8, eyeBlinkRight: 0.1 }, cal);
    expect(wink.get('blinkLeft')).toBe(1);
    expect(wink.get('blinkRight')).toBe(0);
    const noise = blendshapesToExpressions({ eyeBlinkLeft: 0.5, eyeBlinkRight: 0.45 }, cal);
    expect(noise.get('blinkLeft')).toBeCloseTo(noise.get('blinkRight')!);
  });

  it('derives gaze yaw toward the avatar left (+) from eyeLook shapes', () => {
    expect(gaze({ eyeLookOutLeft: 0.6, eyeLookInRight: 0.6 }, cal).yaw).toBeGreaterThan(10);
    expect(gaze({ eyeLookDownLeft: 0.6, eyeLookDownRight: 0.6 }, cal).pitch).toBeGreaterThan(5);
  });

  it('splits the head rotation between neck and head through MotionSolver', () => {
    const coords = new CoordinateSpace();
    coords.options.mirror = false;
    const m = new Matrix4().makeRotationY(0.5).toArray();
    const f = frame(poseWorld(), { face: { landmarks: [], blendshapes: {}, matrix: m } });
    const motion = new MotionSolver().solve(coords.convert(f));
    const total = motion.bones.get('neck')!.clone().multiply(motion.bones.get('head')!);
    expect(new Euler().setFromQuaternion(total).y).toBeCloseTo(0.5, 2);
  });
});

// ----------------------------------------------------------------- misc

describe('filters', () => {
  it('One Euro converges to a constant input', () => {
    const f = new OneEuroFilter();
    let v = 0;
    for (let i = 0; i < 120; i++) v = f.filter(i === 0 ? 0 : 1, i / 60);
    expect(v).toBeCloseTo(1, 2);
  });

  it('quaternion filter stays normalized and converges', () => {
    const f = new QuaternionFilter();
    const target = new Quaternion().setFromEuler(new Euler(0.5, 0.2, 0));
    let q = new Quaternion();
    f.filter(new Quaternion(), 0);
    for (let i = 1; i < 240; i++) q = f.filter(target, i / 60);
    expect(q.length()).toBeCloseTo(1, 6);
    expect(q.angleTo(target)).toBeLessThan(0.01);
  });
});

describe('ExpressionMixer', () => {
  it('lets AI hints raise emotions temporarily and voice override the mouth', () => {
    const mixer = new ExpressionMixer();
    mixer.hint('happy', 1, 2, 0);
    const during = mixer.mix(new Map([['aa', 0.2]]), 1);
    expect(during.get('happy')).toBeGreaterThan(0.7);
    expect(mixer.mix(new Map(), 3).get('happy')).toBe(0);
    mixer.setVoice({ oh: 1 }, 1);
    const speaking = mixer.mix(new Map([['aa', 1]]), 3);
    expect(speaking.get('oh')).toBe(1);
    expect(speaking.get('aa')).toBe(0);
  });
});

describe('material categories (VRoid naming)', () => {
  it('follows the sample naming scheme', () => {
    expect(categorizeMaterial('Hair_00_HAIR')).toBe('HAIR');
    expect(categorizeMaterial('Tops_01_CLOTH')).toBe('CLOTH');
    expect(categorizeMaterial('EyeIris_00_EYE')).toBe('EYE');
    expect(categorizeMaterial('huku_bake')).toBe('CLOTH');
    expect(categorizeMaterial('body_bake')).toBe('SKIN');
  });
});

describe('hand side assignment', () => {
  const hand = (x: number, side: 'left' | 'right'): HandObservation => ({
    side,
    landmarks: [{ x, y: 0.5, z: 0 }],
    world: [],
    score: 1,
  });
  it('matches hands to the nearest pose wrist regardless of the handedness label', () => {
    const pose = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
    pose[15] = { x: 0.8, y: 0.5, z: 0 }; // person's left wrist appears on image right
    pose[16] = { x: 0.2, y: 0.5, z: 0 };
    const out = assignSides([hand(0.21, 'left'), hand(0.79, 'left')], pose);
    expect(out.map((h) => h.side)).toEqual(['right', 'left']);
  });
});
