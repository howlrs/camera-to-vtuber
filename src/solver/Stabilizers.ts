import { Quaternion } from 'three';

/**
 * Per-person neutral face. MediaPipe blendshapes have large, person-specific resting values
 * (e.g. mouthPucker 0.5–0.9 or browInnerUp 0.3 on a relaxed face), which would otherwise show up
 * as permanent expressions. The baseline tracks a low percentile of each shape: it follows
 * decreases quickly and increases slowly, so a sustained expression is only absorbed over
 * ~a minute while the resting value is learned within seconds. `capture()` snapshots it
 * explicitly (front calibration).
 */
export class BlendshapeBaseline {
  /** Rate (1/s) at which the baseline rises toward higher values. */
  riseRate = 0.02;
  /** Rate (1/s) at which the baseline falls toward lower values. */
  fallRate = 2.5;
  /** Shapes excluded from the baseline (gaze is calibrated separately). */
  exclude = /^eyeLook/;
  maxBaseline = 0.85;
  private base = new Map<string, number>();

  apply(shapes: Record<string, number>, dt: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(shapes)) {
      if (this.exclude.test(k)) {
        out[k] = v;
        continue;
      }
      let b = this.base.get(k);
      if (b === undefined) b = v;
      else {
        const rate = v < b ? this.fallRate : this.riseRate;
        b += (v - b) * Math.min(1, rate * dt);
      }
      b = Math.min(b, this.maxBaseline);
      this.base.set(k, b);
      out[k] = Math.max(0, Math.min(1, (v - b) / (1 - b)));
    }
    return out;
  }

  capture(shapes: Record<string, number>): void {
    for (const [k, v] of Object.entries(shapes)) {
      if (!this.exclude.test(k)) this.base.set(k, Math.min(v, this.maxBaseline));
    }
  }

  get(k: string): number | undefined {
    return this.base.get(k);
  }

  reset(): void {
    this.base.clear();
  }
}

/**
 * Rejects single-frame rotation glitches (e.g. a face matrix that flips for one frame): a jump
 * larger than `maxStepDeg` is held back until it persists for `confirmFrames` frames.
 */
export class RotationSpikeGate {
  maxStepDeg = 25;
  confirmFrames = 3;
  private last: Quaternion | null = null;
  private pending = 0;

  filter(q: Quaternion): Quaternion {
    if (!this.last) {
      this.last = q.clone();
      return q;
    }
    const step = (this.last.angleTo(q) * 180) / Math.PI;
    if (step > this.maxStepDeg && this.pending < this.confirmFrames - 1) {
      this.pending++;
      return this.last.clone();
    }
    this.pending = 0;
    this.last.copy(q);
    return q;
  }

  reset(): void {
    this.last = null;
    this.pending = 0;
  }
}

/** Boolean with separate enter/exit thresholds, to stop limbs flickering near a threshold. */
export class Hysteresis {
  active = false;
  constructor(
    public enter: number,
    public exit: number,
  ) {}

  update(value: number): boolean {
    this.active = this.active ? value >= this.exit : value >= this.enter;
    return this.active;
  }
}
