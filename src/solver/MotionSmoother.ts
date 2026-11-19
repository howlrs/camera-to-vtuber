import { Quaternion, Vector3 } from 'three';
import type { HumanBoneName, MotionFrame } from '../core/types.ts';
import { emptyMotion } from '../core/types.ts';
import { FilterBank, OneEuroFilter, type OneEuroParams, QuaternionFilter } from '../coords/filters.ts';
import { restPose } from './idlePose.ts';

/**
 * Stage 4: temporal filtering + graceful degradation.
 * - One Euro filtering per bone/expression (different presets per body region).
 * - Bones that stop being observed ease back to the idle pose instead of freezing.
 */

const PRESETS: Record<'head' | 'torso' | 'body' | 'finger' | 'expr' | 'eye', OneEuroParams> = {
  head: { minCutoff: 1.0, beta: 0.3, dCutoff: 1 },
  // Torso orientation comes from shoulder landmarks that are often at the frame edge: smooth hard.
  torso: { minCutoff: 0.35, beta: 0.15, dCutoff: 1 },
  body: { minCutoff: 0.9, beta: 0.35, dCutoff: 1 },
  finger: { minCutoff: 0.8, beta: 0.2, dCutoff: 1 },
  expr: { minCutoff: 2.0, beta: 0.8, dCutoff: 1 },
  eye: { minCutoff: 1.2, beta: 0.4, dCutoff: 1 },
};

function presetFor(bone: string): OneEuroParams {
  if (bone === 'head' || bone === 'neck') return PRESETS.head;
  if (TORSO.includes(bone)) return PRESETS.torso;
  if (/Thumb|Index|Middle|Ring|Little/.test(bone)) return PRESETS.finger;
  return PRESETS.body;
}

const TORSO = ['hips', 'spine', 'chest', 'upperChest'];
const IDENTITY = new Quaternion();

export class MotionSmoother {
  /** Share of the head rotation (relative to the torso) given to the neck bone. */
  neckShare = 0.35;
  private headWorld = new QuaternionFilter(PRESETS.head);
  private headSeen = -Infinity;
  /** Seconds a bone keeps its last value before easing back to idle. */
  holdTime = 0.35;
  /** Ease-back speed toward idle (1/s). */
  returnRate = 4;
  /** Seconds to blend from the idle/last pose into tracking when a bone is (re)acquired. */
  fadeIn = 0.3;

  private boneFilters = new Map<string, QuaternionFilter>();
  private exprFilters = new FilterBank(() => new OneEuroFilter(PRESETS.expr));
  private eyeYaw = new OneEuroFilter(PRESETS.eye);
  private eyePitch = new OneEuroFilter(PRESETS.eye);
  private state = new Map<HumanBoneName, { q: Quaternion; lastSeen: number; weight: number }>();
  private exprState = new Map<string, { v: number; lastSeen: number }>();
  private hips = new Vector3();
  private eye = { yaw: 0, pitch: 0 };

  smooth(raw: MotionFrame, now: number, dt: number): MotionFrame {
    const out = emptyMotion();
    out.confidence = { ...raw.confidence };

    for (const [bone, q] of raw.bones) {
      let f = this.boneFilters.get(bone);
      if (!f) {
        f = new QuaternionFilter(presetFor(bone));
        this.boneFilters.set(bone, f);
      }
      const filtered = f.filter(q, now);
      let st = this.state.get(bone);
      if (!st) {
        st = { q: restPose(bone).clone(), lastSeen: now, weight: 0 };
        this.state.set(bone, st);
      } else if (now - st.lastSeen > this.holdTime) {
        st.weight = 0; // reacquired after a loss: blend in instead of snapping
      }
      st.weight = Math.min(1, st.weight + dt / this.fadeIn);
      if (st.weight >= 1) st.q.copy(filtered);
      else st.q.slerp(filtered, st.weight);
      st.lastSeen = now;
    }

    const ease = 1 - Math.exp(-this.returnRate * dt);
    for (const [bone, st] of this.state) {
      if (now - st.lastSeen > this.holdTime) {
        st.q.slerp(restPose(bone), ease);
        this.boneFilters.get(bone)?.reset();
      }
      out.bones.set(bone, st.q.clone());
    }

    // Head: filter in world space, then express it relative to the smoothed torso chain.
    if (raw.headWorld) {
      const hw = this.headWorld.filter(raw.headWorld, now);
      this.headSeen = now;
      const torso = new Quaternion();
      for (const b of TORSO) torso.multiply(out.bones.get(b as HumanBoneName) ?? IDENTITY);
      const total = torso.invert().multiply(hw);
      const neck = new Quaternion().slerp(total, this.neckShare);
      const head = neck.clone().invert().multiply(total);
      for (const [bone, q] of [['neck', neck], ['head', head]] as const) {
        out.bones.set(bone, q);
        const st = this.state.get(bone);
        if (st) st.q.copy(q);
        else this.state.set(bone, { q: q.clone(), lastSeen: now, weight: 1 });
      }
    } else if (now - this.headSeen > this.holdTime) {
      this.headWorld.reset();
    }

    for (const [name, v] of raw.expressions) {
      const fv = this.exprFilters.get(name).filter(v, now);
      this.exprState.set(name, { v: Math.min(1, Math.max(0, fv)), lastSeen: now });
    }
    for (const [name, st] of this.exprState) {
      if (now - st.lastSeen > this.holdTime) st.v *= 1 - ease;
      out.expressions.set(name, st.v);
    }

    if (raw.eye) {
      this.eye.yaw = this.eyeYaw.filter(raw.eye.yaw, now);
      this.eye.pitch = this.eyePitch.filter(raw.eye.pitch, now);
    } else {
      this.eye.yaw *= 1 - ease;
      this.eye.pitch *= 1 - ease;
    }
    out.eye = { ...this.eye };

    if (raw.hipsOffset) this.hips.lerp(raw.hipsOffset, 0.3);
    else this.hips.multiplyScalar(1 - ease);
    out.hipsOffset = this.hips.clone();
    return out;
  }

  reset(): void {
    this.headWorld.reset();
    this.boneFilters.clear();
    this.exprFilters.reset();
    this.state.clear();
    this.exprState.clear();
  }
}
