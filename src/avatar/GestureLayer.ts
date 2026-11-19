import { Euler, Quaternion, Vector3 } from 'three';
import type { Gesture } from '../../shared/protocol.ts';
import type { HumanBoneName, MotionFrame } from '../core/types.ts';

/**
 * Additive procedural motion layered on top of tracking: AI-triggered gestures (nod, wave, …)
 * plus subtle idle breathing so the avatar never looks frozen.
 */

interface Active {
  gesture: Gesture;
  start: number;
  duration: number;
}

const DURATION: Record<Gesture, number> = {
  none: 0,
  nod: 1.2,
  shake: 1.4,
  tilt: 1.8,
  bounce: 1.0,
  wave: 2.4,
  thinking: 2.5,
};

const deg = Math.PI / 180;
const _e = new Euler();
const _q = new Quaternion();

export class GestureLayer {
  breathing = true;
  private active: Active[] = [];

  play(gesture: Gesture, now: number): void {
    if (gesture === 'none') return;
    this.active = this.active.filter((a) => a.gesture !== gesture);
    this.active.push({ gesture, start: now, duration: DURATION[gesture] });
  }

  apply(motion: MotionFrame, now: number): void {
    this.active = this.active.filter((a) => now - a.start < a.duration);

    if (this.breathing) {
      const b = Math.sin(now * 2 * Math.PI * 0.22);
      premul(motion, 'chest', b * 0.8, 0, 0);
      premul(motion, 'upperChest', b * 0.5, 0, 0);
    }

    for (const a of this.active) {
      const t = (now - a.start) / a.duration; // 0..1
      const env = Math.sin(Math.PI * Math.min(1, t)); // ease in/out
      switch (a.gesture) {
        case 'nod':
          premul(motion, 'head', Math.sin(t * Math.PI * 4) * 14 * env, 0, 0);
          break;
        case 'shake':
          premul(motion, 'head', 0, Math.sin(t * Math.PI * 6) * 16 * env, 0);
          break;
        case 'tilt':
          premul(motion, 'head', 0, 0, 14 * env);
          premul(motion, 'neck', 0, 0, 6 * env);
          break;
        case 'bounce': {
          const off = motion.hipsOffset ?? new Vector3();
          off.y += Math.abs(Math.sin(t * Math.PI * 3)) * 0.035 * env;
          motion.hipsOffset = off;
          break;
        }
        case 'wave': {
          // Only animate the arm when the performer's own right arm isn't being tracked.
          if (motion.confidence.right > 0.5) break;
          // Right arm rests along -X; negative Z rotation lifts it (idle = +68° down, raised = -25°).
          override(motion, 'rightUpperArm', 0, 0, 68 - 93 * env);
          override(motion, 'rightLowerArm', 0, 0, -(75 + Math.sin(t * Math.PI * 8) * 22) * env);
          override(motion, 'rightHand', 0, 0, 0);
          break;
        }
        case 'thinking':
          premul(motion, 'head', -6 * env, 8 * env, 10 * env);
          if (motion.eye) motion.eye.pitch -= 8 * env;
          break;
      }
    }
  }
}

function premul(motion: MotionFrame, bone: HumanBoneName, x: number, y: number, z: number): void {
  const base = motion.bones.get(bone) ?? new Quaternion();
  _q.setFromEuler(_e.set(x * deg, y * deg, z * deg));
  motion.bones.set(bone, base.clone().multiply(_q));
}

function override(motion: MotionFrame, bone: HumanBoneName, x: number, y: number, z: number): void {
  motion.bones.set(bone, new Quaternion().setFromEuler(new Euler(x * deg, y * deg, z * deg)));
}
