import { describe, expect, it } from 'vitest';
import { Euler, Quaternion } from 'three';
import { BlendshapeBaseline, Hysteresis, RotationSpikeGate } from '../../src/solver/Stabilizers.ts';
import { blendshapesToExpressions, DEFAULT_FACE_CALIBRATION } from '../../src/solver/FaceSolver.ts';
import { onScreen } from '../../src/coords/CoordinateSpace.ts';
import { headBox } from '../../src/tracking/MediaPipeTrackers.ts';
import type { Landmark } from '../../src/core/types.ts';

// Values below mirror what the diagnostics recorded from a real webcam (relaxed face).
describe('BlendshapeBaseline', () => {
  it('learns a high resting mouthPucker so a relaxed face shows no "ou"', () => {
    const base = new BlendshapeBaseline();
    let rel: Record<string, number> = {};
    for (let i = 0; i < 120; i++) {
      const pucker = 0.55 + 0.4 * Math.abs(Math.sin(i * 0.7)); // noisy 0.55..0.95 at rest
      rel = base.apply({ mouthPucker: pucker, jawOpen: 0.01 + 0.03 * Math.abs(Math.sin(i)) }, 1 / 60);
    }
    const expr = blendshapesToExpressions(rel, DEFAULT_FACE_CALIBRATION);
    expect(expr.get('ou')).toBe(0);
  });

  it('still reports a real expression above the learned baseline', () => {
    const base = new BlendshapeBaseline();
    for (let i = 0; i < 60; i++) base.apply({ mouthSmileLeft: 0.05, mouthSmileRight: 0.05 }, 1 / 60);
    const rel = base.apply({ mouthSmileLeft: 0.8, mouthSmileRight: 0.8 }, 1 / 60);
    expect(rel.mouthSmileLeft).toBeGreaterThan(0.75);
  });

  it('only slowly absorbs a sustained expression', () => {
    const base = new BlendshapeBaseline();
    base.apply({ browInnerUp: 0 }, 0);
    let rel = 0;
    for (let i = 0; i < 600; i++) rel = base.apply({ browInnerUp: 0.7 }, 1 / 60).browInnerUp; // 10 s
    expect(rel).toBeGreaterThan(0.55);
  });

  it('capture() makes the current face neutral and leaves gaze untouched', () => {
    const base = new BlendshapeBaseline();
    base.capture({ browInnerUp: 0.4, eyeLookOutLeft: 0.3 });
    const rel = base.apply({ browInnerUp: 0.4, eyeLookOutLeft: 0.3 }, 1 / 60);
    expect(rel.browInnerUp).toBeCloseTo(0);
    expect(rel.eyeLookOutLeft).toBe(0.3);
  });
});

describe('RotationSpikeGate', () => {
  const rot = (rollDeg: number) => new Quaternion().setFromEuler(new Euler(0, 0, (rollDeg * Math.PI) / 180));

  it('rejects a one-frame 45° flip', () => {
    const gate = new RotationSpikeGate();
    gate.filter(rot(0));
    expect(gate.filter(rot(45)).angleTo(rot(0))).toBeCloseTo(0);
    expect(gate.filter(rot(1)).angleTo(rot(1))).toBeCloseTo(0);
  });

  it('accepts a jump that persists', () => {
    const gate = new RotationSpikeGate();
    gate.filter(rot(0));
    gate.filter(rot(45));
    gate.filter(rot(45));
    expect(gate.filter(rot(45)).angleTo(rot(45))).toBeCloseTo(0);
  });
});

describe('Hysteresis', () => {
  it('does not flicker around a single threshold', () => {
    const h = new Hysteresis(0.65, 0.4);
    const seq = [0.5, 0.7, 0.55, 0.45, 0.5, 0.35, 0.5].map((v) => h.update(v));
    expect(seq).toEqual([false, true, true, true, true, false, false]);
  });
});

describe('framing helpers', () => {
  it('keeps shoulders slightly below the frame usable, but not wrists', () => {
    expect(onScreen({ x: 0.5, y: 1.1, z: 0 }, true)).toBeGreaterThan(0.6);
    expect(onScreen({ x: 0.5, y: 1.1, z: 0 }, false)).toBe(0.1);
  });

  it('head box does not shrink when the head turns (ears overlap)', () => {
    const pose = (earSpread: number): Landmark[] => {
      const p: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
      p[0] = { x: 0.5, y: 0.45, z: 0, visibility: 1 }; // nose
      p[2] = { x: 0.52, y: 0.4, z: 0 }; p[5] = { x: 0.48 + 0.04 * (1 - earSpread), y: 0.4, z: 0 }; // eyes
      p[7] = { x: 0.5 + 0.1 * earSpread, y: 0.42, z: 0 }; p[8] = { x: 0.5 - 0.1 * earSpread, y: 0.42, z: 0 }; // ears
      p[9] = { x: 0.51, y: 0.52, z: 0 }; p[10] = { x: 0.49, y: 0.52, z: 0 }; // mouth
      return p;
    };
    const frontal = headBox(pose(1), 1280, 720)!.size;
    const turned = headBox(pose(0.15), 1280, 720)!.size;
    expect(turned / frontal).toBeGreaterThan(0.75);
  });
});

describe('MotionSmoother head isolation', () => {
  it('keeps the face still when only the torso jitters', async () => {
    const { MotionSmoother } = await import('../../src/solver/MotionSmoother.ts');
    const { emptyMotion } = await import('../../src/core/types.ts');
    const smoother = new MotionSmoother();
    const headWorld = new Quaternion().setFromEuler(new Euler(0.1, 0.3, 0));
    let maxDev = 0;
    for (let i = 0; i < 180; i++) {
      const raw = emptyMotion();
      const jitter = new Quaternion().setFromEuler(new Euler(0, ((i % 2 ? 1 : -1) * 5 * Math.PI) / 180, 0));
      raw.bones.set('chest', jitter);
      raw.headWorld = headWorld;
      const out = smoother.smooth(raw, i / 60, 1 / 60);
      const world = new Quaternion();
      for (const b of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'] as const) world.multiply(out.bones.get(b) ?? new Quaternion());
      if (i > 30) maxDev = Math.max(maxDev, (world.angleTo(headWorld) * 180) / Math.PI);
    }
    expect(maxDev).toBeLessThan(0.5);
  });
});
