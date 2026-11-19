import { type Object3D, Quaternion, Vector3 } from 'three';
import type { VRMSpringBoneJoint, VRMSpringBoneManager } from '@pixiv/three-vrm';

/**
 * Hair sway on top of the model's own spring bones (VRMC_springBone / VRM 0.x secondaryAnimation).
 *
 * - Steps every spring of the model at a fixed 60 Hz. three-vrm applies `dragForce` once per
 *   update call, so stepping once per rendered frame would make hair stiffer on 120/144 Hz
 *   displays and floppier at 30 fps.
 * - Softens the hair joints (`sway`) so hair keeps swinging after the head moves, even on models
 *   authored with drag 1 (no inertia). Each VRM spring joint is pulled toward its parent's
 *   direction, so a uniformly soft chain curls and folds; only the root of each strand is made
 *   really loose, and joints further down get stiffer and more damped, so the strand swings as
 *   a whole instead of hooking at the tip. Stiffness is capped relative to bone length, so the
 *   result is similar on any model. Clothes and accessories keep the author's settings.
 * - Adds an optional breeze (`wind`) through the joints' external-force (gravity) slot. Every
 *   joint of a strand gets the same force, sized by the strand's total compliance, so a strand
 *   bends mostly near its root and its tip turns by about atan(wind) on any model.
 */

export interface HairSettings {
  /** 0 = the model's own spring settings, 1 = standard sway, 2 = loose. */
  sway: number;
  /** Breeze strength; roughly the tangent of a strand tip's bend in a full gust. 0 = no wind. */
  wind: number;
}

export const DEFAULT_HAIR_SETTINGS: HairSettings = { sway: 1, wind: 0.15 };

/** Fixed physics step (s). */
export const HAIR_STEP = 1 / 60;
/** Steps simulated at most per frame; the rest of a long hitch is dropped instead of catching up. */
const MAX_STEPS = 4;
/** stiffness / bone length (1/s) allowed at a strand's root at sway 1; ×(1 + depth)² further down. */
const ROOT_RELATIVE_STIFFNESS = 3;
/** dragForce allowed at a strand's root at sway 1, growing by DRAG_PER_DEPTH up to MAX_DRAG. */
const ROOT_DRAG = 0.1;
const DRAG_PER_DEPTH = 0.15;
const MAX_DRAG = 0.8;
/** Bones shorter than this are softened as if this long. */
const MIN_SOFTEN_LENGTH = 0.03;
/**
 * Bones shorter than this keep the author's settings: a few-millimetre bone acts as a pivot, and
 * inertia (in metres) turns into huge rotations (Seed-san's 2–4 mm bangs flipped to ~110°).
 */
const MIN_SWAY_LENGTH = 0.01;

/** Hair bone names seen in VRoid (J_Sec_Hair…, HairJoint-…), Blender/Unity rigs and MMD-style Japanese rigs. */
const HAIR_NAME =
  /hair|kami|(?:mae|ushiro|yoko|ato|ura)gami|ahoge|ponytail|twintail|pigtail|braid|sidelock|momiage|(?<![a-z])(?:bangs?|fringe)(?![a-z])|髪|もみあげ|アホ毛|ｱﾎ毛|おさげ|三つ編|ポニーテール|ツインテ/i;

export interface SpringParams {
  stiffness: number;
  dragForce: number;
}

/**
 * Spring parameters for a hair joint at the given sway (0 returns the authored values).
 * `depth` is the joint's index along its strand (0 = root). Never stiffer or more damped than authored.
 */
export function softenSpring(base: SpringParams, boneLength: number, depth: number, sway: number): SpringParams {
  if (!(sway > 0) || boneLength < MIN_SWAY_LENGTH) return { stiffness: base.stiffness, dragForce: base.dragForce };
  const length = Math.max(boneLength, MIN_SOFTEN_LENGTH);
  return {
    stiffness: Math.min(base.stiffness, (length * ROOT_RELATIVE_STIFFNESS * (1 + depth) ** 2) / sway),
    dragForce: Math.min(base.dragForce, Math.min(ROOT_DRAG + DRAG_PER_DEPTH * depth, MAX_DRAG) / Math.sqrt(sway)),
  };
}

/**
 * Breeze direction × gust strength at time t (world space; the avatar faces +Z). `phase`
 * de-synchronizes strands. Mostly side-to-side with a light push backward; |result| < 1.2.
 */
export function breeze(t: number, phase: number, out = new Vector3()): Vector3 {
  const gust = 0.6 + 0.4 * Math.sin(0.31 * t) * Math.sin(0.83 * t + 1.3);
  const side = 0.7 * Math.sin(1.7 * t + phase) + 0.3 * Math.sin(3.1 * t + 1.9 * phase);
  return out.set(
    side * gust,
    0.15 * Math.sin(2.3 * t + phase),
    -(0.35 + 0.25 * Math.sin(1.1 * t + 0.7 * phase)) * gust,
  );
}

/** Spring joints that belong to hair: by bone name, else (unnamed rigs) everything under the head. */
export function findHairJoints<J extends { bone: Object3D }>(joints: Iterable<J>, head: Object3D | null): J[] {
  const all = [...joints];
  const named = all.filter((j) => hasHairName(j.bone, head));
  if (named.length || !head) return named;
  return all.filter((j) => isDescendant(j.bone, head));
}

function hasHairName(bone: Object3D, stop: Object3D | null): boolean {
  for (let o: Object3D | null = bone; o && o !== stop; o = o.parent) if (HAIR_NAME.test(o.name)) return true;
  return false;
}

function isDescendant(o: Object3D, ancestor: Object3D): boolean {
  for (let p = o.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

interface HairJoint {
  joint: VRMSpringBoneJoint;
  base: SpringParams;
  /** Authored external force (gravityDir × gravityPower), and its parts as authored. */
  gravity: Vector3;
  baseDir: Vector3;
  basePower: number;
  length: number;
  /** Index along the strand (0 = root). */
  depth: number;
  /** Strand root bone (joints of one strand share the breeze). */
  strand: Object3D;
  /** Breeze force per unit wind: 1 / the strand's compliance (Σ 1/stiffness). */
  windScale: number;
  phase: number;
  rest: Quaternion;
}

/** Spring manager surface used here (three-vrm's VRMSpringBoneManager). */
type SpringManager = Pick<VRMSpringBoneManager, 'joints' | 'update' | 'reset'>;

const _v = new Vector3();
const _w = new Vector3();

export class HairPhysics {
  readonly settings: HairSettings = { ...DEFAULT_HAIR_SETTINGS };
  private readonly hair: HairJoint[];
  private acc = 0;
  private time = 0;

  /**
   * @param manager the model's spring bones; HairPhysics becomes their only driver.
   * @param head raw head bone (hair is found under it when bone names don't say "hair").
   * World matrices must be current (rest pose) when constructing.
   */
  constructor(
    private readonly manager: SpringManager,
    head: Object3D | null,
  ) {
    const headPos = head ? head.getWorldPosition(new Vector3()) : new Vector3();
    const joints = findHairJoints(manager.joints, head);
    const bones = new Set(joints.map((j) => j.bone));
    const strand = joints.map((j) => {
      let root = j.bone;
      let depth = 0;
      while (root.parent && bones.has(root.parent)) {
        root = root.parent;
        depth++;
      }
      return { root, depth };
    });

    this.hair = joints.map((joint, i) => {
      const s = joint.settings;
      const from = joint.bone.getWorldPosition(new Vector3());
      const to = joint.child
        ? joint.child.getWorldPosition(new Vector3())
        : joint.bone.localToWorld(joint.initialLocalChildPosition.clone());
      const { root, depth } = strand[i];
      const p = root.getWorldPosition(new Vector3()).sub(headPos);
      return {
        joint,
        base: { stiffness: s.stiffness, dragForce: s.dragForce },
        gravity: s.gravityDir.clone().multiplyScalar(s.gravityPower),
        baseDir: s.gravityDir.clone(),
        basePower: s.gravityPower,
        length: to.distanceTo(from),
        depth,
        strand: root,
        windScale: 0,
        // A strand moves as one; neighbouring strands (~5 cm apart) are slightly out of phase.
        phase: 9 * p.x + 5 * p.y,
        rest: joint.bone.quaternion.clone(),
      };
    });
    this.configure({});
  }

  /** Number of spring joints treated as hair. */
  get jointCount(): number {
    return this.hair.length;
  }

  configure(settings: Partial<HairSettings>): void {
    Object.assign(this.settings, settings);
    const compliance = new Map<Object3D, number>();
    for (const h of this.hair) {
      const s = h.joint.settings;
      Object.assign(s, softenSpring(h.base, h.length, h.depth, this.settings.sway));
      s.gravityDir.copy(h.baseDir);
      s.gravityPower = h.basePower;
      compliance.set(h.strand, (compliance.get(h.strand) ?? 0) + 1 / Math.max(s.stiffness, 1e-4));
    }
    // Each joint bends by about force/stiffness relative to its parent; these add up to the tip.
    for (const h of this.hair) h.windScale = 1 / compliance.get(h.strand)!;
  }

  /** Advance the springs by a frame's dt in fixed steps (call after the pose is applied). */
  update(dt: number): void {
    if (!(dt > 0)) return;
    this.acc = Math.min(this.acc + dt, HAIR_STEP * MAX_STEPS);
    while (this.acc >= HAIR_STEP) {
      this.acc -= HAIR_STEP;
      this.time += HAIR_STEP;
      if (this.settings.wind > 0) this.blow();
      this.manager.update(HAIR_STEP);
    }
  }

  /** Put every spring back to rest relative to the current pose (after a teleport/pose snap). */
  reset(): void {
    this.acc = 0;
    this.manager.reset();
  }

  /** Current hair bend from rest, in degrees (for diagnostics). */
  deflection(): { mean: number; max: number } {
    let sum = 0;
    let max = 0;
    for (const h of this.hair) {
      const d = (h.joint.bone.quaternion.angleTo(h.rest) * 180) / Math.PI;
      sum += d;
      max = Math.max(max, d);
    }
    return { mean: this.hair.length ? sum / this.hair.length : 0, max };
  }

  private blow(): void {
    const wind = this.settings.wind;
    for (const h of this.hair) {
      const force = breeze(this.time, h.phase, _w).multiplyScalar(wind * h.windScale).add(h.gravity);
      const power = force.length();
      const s = h.joint.settings;
      if (power > 1e-9) s.gravityDir.copy(_v.copy(force).divideScalar(power));
      s.gravityPower = power;
    }
  }
}
