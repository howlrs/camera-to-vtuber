import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { VRMSpringBoneJoint, VRMSpringBoneManager } from '@pixiv/three-vrm';
import { breeze, findHairJoints, HairPhysics, softenSpring } from '../../src/avatar/HairPhysics.ts';

// A head with one hanging strand behind it, simulated by three-vrm's own spring joints.
// Spring values mirror the samples: Twist (stiffness 0.5, drag 0.4, ~8.5 cm bones) and
// Seed-san (stiffness 4, drag 1 = no inertia, ~6.5 cm bones).
interface StrandOptions {
  name?: string;
  stiffness: number;
  drag: number;
  gravity?: number;
  segments: number;
  length: number;
  /** Model size factor (all bone offsets are multiplied by it). */
  scale?: number;
  /** VRM 0.x layout: three-vrm also makes the strand's last bone a joint, with no child. */
  vrm0?: boolean;
  /** Turn the model 180° after the springs were initialised, like VRMUtils.rotateVRM0. */
  turnAround?: boolean;
  /** Skip the reset VrmAvatar does after loading (to show why it is needed). */
  skipReset?: boolean;
}

function strandRig(o: StrandOptions) {
  const k = o.scale ?? 1;
  const root = new Object3D();
  const head = new Object3D();
  head.name = 'Head';
  head.position.set(0, 1.5 * k, 0);
  root.add(head);
  const hips = new Object3D();
  hips.name = 'Hips';
  hips.position.set(0, 1 * k, 0);
  root.add(hips);

  const bones: Object3D[] = [];
  let parent = head;
  for (let i = 0; i <= o.segments; i++) {
    const b = new Object3D();
    b.name = `${o.name ?? 'J_Sec_Hair'}${i}`;
    if (i === 0) b.position.set(0, 0.05 * k, -0.09 * k);
    else b.position.set(0, -o.length * k, 0);
    parent.add(b);
    bones.push(b);
    parent = b;
  }
  // A skirt joint on the hips: not hair, must keep its authored settings.
  const skirt = new Object3D();
  skirt.name = 'J_Sec_L_Skirt';
  const skirtEnd = new Object3D();
  skirtEnd.position.set(0, -0.2, 0.05);
  hips.add(skirt);
  skirt.add(skirtEnd);
  root.updateMatrixWorld(true);

  const manager = new VRMSpringBoneManager();
  for (let i = 0; i < (o.vrm0 ? o.segments + 1 : o.segments); i++) {
    manager.addJoint(
      new VRMSpringBoneJoint(bones[i], bones[i + 1] ?? null, {
        stiffness: o.stiffness,
        dragForce: o.drag,
        gravityPower: o.gravity ?? 0,
        gravityDir: new Vector3(0, -1, 0),
        hitRadius: 0.01,
      }),
    );
  }
  const skirtJoint = new VRMSpringBoneJoint(skirt, skirtEnd, { stiffness: 1, dragForce: 0.4, gravityPower: 0, hitRadius: 0.02 });
  manager.addJoint(skirtJoint);
  manager.setInitState();
  if (o.turnAround) {
    root.rotation.y = Math.PI;
    root.updateMatrixWorld(true);
  }
  const hair = new HairPhysics(manager, head);
  if (!o.skipReset) hair.reset();

  const tmp = new Vector3();
  /** Strand tip's sideways bend (deg) in the head's frame; 0 = hanging straight down. */
  const bend = () => {
    root.updateMatrixWorld(true);
    const tip = head.worldToLocal(bones[o.segments].getWorldPosition(tmp)).sub(bones[0].position);
    return (Math.atan2(tip.x, -tip.y) * 180) / Math.PI;
  };
  return { root, head, hair, manager, skirtJoint, bend };
}

type Rig = ReturnType<typeof strandRig>;

/** Run `seconds` at `fps`, posing the head by yaw(t) (deg) each frame; returns [t, bend] samples. */
function run(rig: Rig, fps: number, seconds: number, yaw: (t: number) => number): [number, number][] {
  const out: [number, number][] = [];
  const dt = 1 / fps;
  for (let i = 1; i <= Math.round(seconds * fps); i++) {
    const t = i * dt;
    rig.head.rotation.set(0, (yaw(t) * Math.PI) / 180, 0);
    rig.head.updateMatrix();
    rig.hair.update(dt);
    out.push([t, rig.bend()]);
  }
  return out;
}

const at = (samples: [number, number][], t: number) =>
  samples.reduce((best, s) => (Math.abs(s[0] - t) < Math.abs(best[0] - t) ? s : best))[1];

/** Head turns 30° over `turn` seconds, then holds. */
const turnAndHold = (turn: number) => (t: number) => 30 * Math.min(1, t / turn);

const TWIST = { stiffness: 0.5, drag: 0.4, gravity: 0.1, segments: 5, length: 0.085 };
const SEED = { stiffness: 4, drag: 1, segments: 6, length: 0.065 };

describe('findHairJoints', () => {
  const head = new Object3D();
  const hips = new Object3D();
  const joint = (name: string, parent: Object3D) => {
    const bone = new Object3D();
    bone.name = name;
    parent.add(bone);
    return { bone };
  };

  it('picks joints named like hair (VRoid, Seed-san, generic) and ignores clothes', () => {
    const joints = [
      joint('J_Sec_Hair1_01', head), joint('hair_tail_1', head), joint('HairJoint-12ab', head),
      joint('J_Sec_L_TopsUpperArmInside', hips), joint('robo_wire', hips), joint('Cat_Ear_L', head),
    ];
    expect(findHairJoints(joints, head).map((j) => j.bone.name)).toEqual(['J_Sec_Hair1_01', 'hair_tail_1', 'HairJoint-12ab']);
  });

  it('recognises Japanese and other common hair bone names, but not look-alikes', () => {
    const names = ['前髪_1', '後ろ髪', 'もみあげ_L', 'アホ毛', 'おさげ1', 'Bangs_L', 'fringe.001', 'Braid_R_02', 'Maegami', 'UshiroGami_2', 'Sidelock_L'];
    const joints = [...names.map((n) => joint(n, head)), joint('Bangle_L', hips), joint('Tail_1', hips), joint('Ribbon_L', head)];
    expect(findHairJoints(joints, head).map((j) => j.bone.name)).toEqual(names);
  });

  it('falls back to every spring under the head when no bone says "hair"', () => {
    const joints = [joint('Bone.001', head), joint('Skirt', hips)];
    expect(findHairJoints(joints, head).map((j) => j.bone.name)).toEqual(['Bone.001']);
  });
});

describe('softenSpring', () => {
  it('keeps the authored values at sway 0', () => {
    expect(softenSpring({ stiffness: 4, dragForce: 1 }, 0.065, 0, 0)).toEqual({ stiffness: 4, dragForce: 1 });
  });

  it('gives a no-inertia model (drag 1) a loose, low-drag strand root', () => {
    const s = softenSpring({ stiffness: 4, dragForce: 1 }, 0.065, 0, 1);
    expect(s.dragForce).toBeCloseTo(0.1);
    expect(s.stiffness).toBeCloseTo(0.065 * 3);
  });

  it('keeps joints further down a strand stiffer and more damped than the root', () => {
    const root = softenSpring({ stiffness: 4, dragForce: 1 }, 0.065, 0, 1);
    const mid = softenSpring({ stiffness: 4, dragForce: 1 }, 0.065, 2, 1);
    const tip = softenSpring({ stiffness: 4, dragForce: 1 }, 0.065, 5, 1);
    expect(mid.stiffness).toBeGreaterThan(root.stiffness);
    expect(mid.dragForce).toBeGreaterThan(root.dragForce);
    expect(tip.stiffness).toBeGreaterThan(mid.stiffness);
    expect(tip.dragForce).toBeCloseTo(0.8);
  });

  it('never stiffens or damps beyond the authored values, and looser sway softens more', () => {
    expect(softenSpring({ stiffness: 0.2, dragForce: 0.05 }, 0.085, 0, 1)).toEqual({ stiffness: 0.2, dragForce: 0.05 });
    const standard = softenSpring({ stiffness: 4, dragForce: 1 }, 0.065, 1, 1);
    const loose = softenSpring({ stiffness: 4, dragForce: 1 }, 0.065, 1, 2);
    expect(loose.stiffness).toBeLessThan(standard.stiffness);
    expect(loose.dragForce).toBeLessThan(standard.dragForce);
  });

  it('treats short bones as 3 cm long, and leaves millimetre bones as authored', () => {
    expect(softenSpring({ stiffness: 1.2, dragForce: 1 }, 0.02, 0, 1).stiffness).toBeCloseTo(0.03 * 3);
    // Seed-san's 2–4 mm bangs flipped to ~110° under real head motion when softened.
    expect(softenSpring({ stiffness: 1.2, dragForce: 1 }, 0.002, 0, 1)).toEqual({ stiffness: 1.2, dragForce: 1 });
  });
});

describe('HairPhysics', () => {
  it('behaves the same at 30, 60 and 144 fps (fixed physics step)', () => {
    const results = [30, 60, 144].map((fps) => {
      const rig = strandRig(TWIST);
      rig.hair.configure({ sway: 1, wind: 0 });
      return run(rig, fps, 1.2, turnAndHold(0.25));
    });
    for (const t of [0.2, 0.4, 0.7, 1.1]) {
      const ref = at(results[1], t);
      expect(Math.abs(at(results[0], t) - ref)).toBeLessThan(1.5);
      expect(Math.abs(at(results[2], t) - ref)).toBeLessThan(1.5);
    }
  });

  /** How far the strand swings past rest (deg) after a quick 30° head turn stops. */
  const overshoot = (opts: StrandOptions, sway: number) => {
    const rig = strandRig(opts);
    rig.hair.configure({ sway, wind: 0 });
    const samples = run(rig, 60, 1.5, turnAndHold(0.15));
    const lagSign = Math.sign(at(samples, 0.15));
    return Math.max(0, ...samples.filter(([t]) => t > 0.15).map(([, b]) => -lagSign * b));
  };

  it('makes stiff, no-inertia hair swing past rest after the head stops (Seed-san-like)', () => {
    expect(overshoot(SEED, 0)).toBeLessThan(0.5); // authored drag 1: follows without swinging
    expect(overshoot(SEED, 1)).toBeGreaterThan(10);
    expect(overshoot(SEED, 2)).toBeGreaterThan(overshoot(SEED, 1));
  });

  it('makes already soft hair swing back visibly too (Twist-like)', () => {
    expect(overshoot(TWIST, 0)).toBeLessThan(1);
    expect(overshoot(TWIST, 1)).toBeGreaterThan(5);
  });

  it('keeps a still head still without wind, and sways it gently with a breeze', () => {
    const still = strandRig(TWIST);
    still.hair.configure({ sway: 1, wind: 0 });
    const calm = run(still, 60, 4, () => 0).filter(([t]) => t > 1).map(([, b]) => Math.abs(b));
    expect(Math.max(...calm)).toBeLessThan(0.5);

    const breezy = strandRig(TWIST);
    breezy.hair.configure({ sway: 1, wind: 0.15 });
    const bends = run(breezy, 60, 8, () => 0).filter(([t]) => t > 1).map(([, b]) => b);
    expect(Math.max(...bends) - Math.min(...bends)).toBeGreaterThan(3);
    expect(Math.max(...bends.map(Math.abs))).toBeLessThan(15);
  });

  it('stays finite and never flips over at the strongest settings with a hard head shake', () => {
    for (const opts of [TWIST, SEED]) {
      const rig = strandRig(opts);
      rig.hair.configure({ sway: 2, wind: 0.5 });
      // ±25° at 1.5 Hz peaks near 240°/s, far faster than a performer's head normally turns.
      const bends = run(rig, 45, 6, (t) => 25 * Math.sin(t * 2 * Math.PI * 1.5)).map(([, b]) => b);
      expect(bends.every(Number.isFinite)).toBe(true);
      expect(Math.max(...bends.map(Math.abs))).toBeLessThan(100);
    }
  });

  it('leaves non-hair springs (clothes) with their authored settings', () => {
    const rig = strandRig(TWIST);
    rig.hair.configure({ sway: 2, wind: 0.5 });
    run(rig, 60, 0.5, () => 0);
    expect(rig.hair.jointCount).toBe(TWIST.segments);
    expect(rig.skirtJoint.settings.stiffness).toBe(1);
    expect(rig.skirtJoint.settings.dragForce).toBe(0.4);
    expect(rig.skirtJoint.settings.gravityPower).toBe(0);
  });

  it('restores the authored springs when sway and wind go back to 0', () => {
    const rig = strandRig(SEED);
    rig.hair.configure({ sway: 1.5, wind: 0.4 });
    run(rig, 60, 0.5, () => 0);
    rig.hair.configure({ sway: 0, wind: 0 });
    const joint = [...rig.manager.joints][0];
    expect(joint.settings.stiffness).toBe(4);
    expect(joint.settings.dragForce).toBe(1);
    expect(joint.settings.gravityPower).toBe(0);
    expect(joint.settings.gravityDir.toArray()).toEqual([0, -1, 0]);
  });

  it('reset() puts the hair back to rest after a swing', () => {
    const rig = strandRig(TWIST);
    run(rig, 60, 0.2, turnAndHold(0.1));
    expect(rig.hair.deflection().max).toBeGreaterThan(3);
    rig.hair.reset();
    expect(rig.hair.deflection().max).toBeLessThan(1e-6);
  });

  it('drops the backlog of a long hitch instead of simulating it all at once', () => {
    const rig = strandRig(TWIST);
    let steps = 0;
    const update = rig.manager.update.bind(rig.manager);
    rig.manager.update = (dt: number) => {
      steps++;
      update(dt);
    };
    rig.hair.update(2);
    expect(steps).toBe(4);
  });
});

describe('HairPhysics on other models', () => {
  it('handles VRM 0.x strands whose last joint has no child bone', () => {
    const rig = strandRig({ ...SEED, vrm0: true });
    expect(rig.hair.jointCount).toBe(SEED.segments + 1);
    rig.hair.configure({ sway: 1, wind: 0.3 });
    const bends = run(rig, 60, 4, (t) => 30 * Math.sin(t * 2 * Math.PI * 0.8)).map(([, b]) => b);
    expect(bends.every(Number.isFinite)).toBe(true);
    expect(Math.max(...bends.map(Math.abs))).toBeGreaterThan(5);
    expect(Math.max(...bends.map(Math.abs))).toBeLessThan(80);
  });

  it('starts calm on a model turned around after loading (VRM 0.x faces -Z)', () => {
    const calm = (skipReset: boolean) => {
      const rig = strandRig({ ...TWIST, vrm0: true, turnAround: true, skipReset });
      rig.hair.configure({ sway: 1, wind: 0 });
      return Math.max(...run(rig, 60, 1, () => 0).map(([, b]) => Math.abs(b)));
    };
    expect(calm(true)).toBeGreaterThan(10); // stale spring state from before the turn
    expect(calm(false)).toBeLessThan(0.5);
  });

  it('swings by a similar angle on smaller and larger models', () => {
    const swing = (scale: number) => {
      const rig = strandRig({ ...SEED, scale });
      rig.hair.configure({ sway: 1, wind: 0 });
      return Math.max(...run(rig, 60, 1.5, turnAndHold(0.15)).map(([, b]) => Math.abs(b)));
    };
    const ref = swing(1);
    for (const scale of [0.6, 1.6]) {
      expect(swing(scale)).toBeGreaterThan(ref * 0.7);
      expect(swing(scale)).toBeLessThan(ref * 1.3);
    }
  });

  it('bends long and short strands by a similar breeze angle', () => {
    const range = (opts: StrandOptions) => {
      const rig = strandRig(opts);
      rig.hair.configure({ sway: 1, wind: 0.3 });
      const bends = run(rig, 60, 8, () => 0).filter(([t]) => t > 1).map(([, b]) => b);
      return Math.max(...bends) - Math.min(...bends);
    };
    const long = range({ ...TWIST, segments: 7 });
    const short = range({ ...SEED, segments: 2, length: 0.04 });
    expect(long).toBeGreaterThan(3);
    expect(short).toBeGreaterThan(3);
    expect(Math.max(long, short) / Math.min(long, short)).toBeLessThan(2.5);
  });
});

describe('breeze', () => {
  it('is bounded and varies with time and strand phase', () => {
    let maxLen = 0;
    for (let t = 0; t < 60; t += 0.05) maxLen = Math.max(maxLen, breeze(t, 0.7).length());
    expect(maxLen).toBeLessThan(1.2);
    expect(breeze(3, 0).distanceTo(breeze(3, 1.5))).toBeGreaterThan(0.05);
    expect(breeze(3, 0).distanceTo(breeze(4, 0))).toBeGreaterThan(0.05);
  });
});
