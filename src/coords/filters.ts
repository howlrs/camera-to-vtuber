import { Quaternion, Vector3 } from 'three';

/**
 * One Euro filter (Casiez et al. 2012): low jitter when still, low lag when moving fast.
 * minCutoff: lower = smoother at rest. beta: higher = less lag during fast motion.
 */
export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroParams = { minCutoff: 1.2, beta: 0.4, dCutoff: 1.0 };

function smoothingFactor(cutoff: number, dt: number): number {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  params: OneEuroParams;

  constructor(params: OneEuroParams = DEFAULT_ONE_EURO) {
    this.params = params;
  }

  /** @param t timestamp in seconds */
  filter(value: number, t: number): number {
    if (this.x === null || t <= this.t) {
      this.x = value;
      this.t = t;
      return value;
    }
    const dt = t - this.t;
    this.t = t;
    const { minCutoff, beta, dCutoff } = this.params;
    const rawDx = (value - this.x) / dt;
    this.dx += smoothingFactor(dCutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += smoothingFactor(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}

export class VectorFilter {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  private fz: OneEuroFilter;

  constructor(params: OneEuroParams = DEFAULT_ONE_EURO) {
    this.fx = new OneEuroFilter(params);
    this.fy = new OneEuroFilter(params);
    this.fz = new OneEuroFilter(params);
  }

  filter(v: Vector3, t: number, out = new Vector3()): Vector3 {
    return out.set(this.fx.filter(v.x, t), this.fy.filter(v.y, t), this.fz.filter(v.z, t));
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
}

/** One Euro filtering on the rotation manifold: adaptive slerp driven by angular speed. */
export class QuaternionFilter {
  private q: Quaternion | null = null;
  private speed = 0;
  private t = 0;
  params: OneEuroParams;

  constructor(params: OneEuroParams = DEFAULT_ONE_EURO) {
    this.params = params;
  }

  filter(value: Quaternion, t: number, out = new Quaternion()): Quaternion {
    if (this.q === null || t <= this.t) {
      this.q = value.clone();
      this.t = t;
      return out.copy(value);
    }
    const dt = t - this.t;
    this.t = t;
    const target = value.clone();
    // Keep both quaternions in the same hemisphere so slerp takes the short path.
    if (this.q.dot(target) < 0) target.set(-target.x, -target.y, -target.z, -target.w);
    const angle = this.q.angleTo(target);
    const { minCutoff, beta, dCutoff } = this.params;
    this.speed += smoothingFactor(dCutoff, dt) * (angle / dt - this.speed);
    const cutoff = minCutoff + beta * Math.abs(this.speed);
    this.q.slerp(target, smoothingFactor(cutoff, dt));
    return out.copy(this.q);
  }

  reset(): void {
    this.q = null;
    this.speed = 0;
  }
}

/** Keyed bank of filters, created lazily — used by the motion smoother. */
export class FilterBank<F extends { reset(): void }> {
  private map = new Map<string, F>();
  private factory: () => F;

  constructor(factory: () => F) {
    this.factory = factory;
  }

  get(key: string): F {
    let f = this.map.get(key);
    if (!f) {
      f = this.factory();
      this.map.set(key, f);
    }
    return f;
  }

  reset(): void {
    for (const f of this.map.values()) f.reset();
  }
}
