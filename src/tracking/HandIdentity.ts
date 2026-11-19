import type { HandObservation, Landmark, Side } from '../core/types.ts';

/**
 * Decides which detected hand is the left and which is the right, robustly enough for both
 * hands moving in view at once (crossing, touching, passing in front of the face).
 *
 * Each hand is matched through *anchor* keypoints — wrist, thumb, index knuckle and pinky — so
 * that the thumb/pinky side of the hand participates, not just the wrist:
 *  1. Pose anchors: MediaPipe Pose also localises each side's wrist / thumb / index / pinky.
 *  2. Temporal continuity: hands move continuously; anchors are compared with last frame's.
 *  3. Handedness label: MediaPipe's chirality estimate from the hand's appearance.
 * The cheapest assignment wins, and swapping an established identity needs the alternative to
 * win for several consecutive frames.
 */

/** Hand landmark indices used as anchors: wrist, thumb CMC, thumb tip, index MCP, pinky MCP, pinky tip. */
const ANCHORS = { wrist: 0, thumbCmc: 1, thumbTip: 4, indexMcp: 5, middleMcp: 9, pinkyMcp: 17, pinkyTip: 20 } as const;
/** Pose landmark indices of each side's hand points (anatomical sides of MediaPipe's view). */
const POSE_HAND: Record<Side, { wrist: number; pinky: number; index: number; thumb: number }> = {
  left: { wrist: 15, pinky: 17, index: 19, thumb: 21 },
  right: { wrist: 16, pinky: 18, index: 20, thumb: 22 },
};

interface Pt {
  x: number;
  y: number;
}

export interface HandIdentityWeights {
  pose: number;
  /** Continuity weight when two hands are visible (they can be confused with each other). */
  temporal: number;
  /** Continuity weight for a lone hand: only damps flicker, pose + label decide its side. */
  temporalSingle: number;
  label: number;
  /**
   * Pose cost for a side whose wrist the pose model cannot see. A visible hand is unlikely to
   * belong to an arm whose wrist is hidden, so this is high (not zero).
   */
  unseenSide: number;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

function handScale(h: HandObservation): number {
  const l = h.landmarks;
  if (l.length < 21) return 0.05;
  return Math.max(0.02, dist(l[ANCHORS.wrist], l[ANCHORS.middleMcp]));
}

function anchorPoints(h: HandObservation): Pt[] {
  const l = h.landmarks;
  if (l.length < 21) return [l[0]];
  return [l[ANCHORS.wrist], l[ANCHORS.thumbCmc], l[ANCHORS.thumbTip], l[ANCHORS.indexMcp], l[ANCHORS.pinkyMcp], l[ANCHORS.pinkyTip]];
}

export class HandIdentityTracker {
  weights: HandIdentityWeights = { pose: 1, temporal: 2, temporalSingle: 0.5, label: 0.5, unseenSide: 3 };
  /** Seconds after which last frame's anchors no longer count as continuity. */
  memory = 0.35;
  /** Consecutive frames the opposite assignment must win before identities are swapped. */
  confirmFrames = 6;
  /** Number of identity swaps accepted (diagnostics). */
  swaps = 0;
  private prev: Partial<Record<Side, { pts: Pt[]; t: number }>> = {};
  private challenger = 0;

  /**
   * @param hands detections; `side` is the side implied by MediaPipe's handedness label
   * @param pose  pose image landmarks of the same frame (optional)
   * @param t     timestamp in seconds
   */
  assign(hands: HandObservation[], pose: Landmark[] | undefined, t: number): HandObservation[] {
    const cands = dedupe(hands)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    if (cands.length === 0) return [];

    const options: Side[][] = cands.length === 1 ? [['left'], ['right']] : [['left', 'right'], ['right', 'left']];
    const temporal = cands.length === 1 ? this.weights.temporalSingle : this.weights.temporal;
    const costs = options.map((sides) => sides.reduce((sum, side, i) => sum + this.cost(cands[i], side, pose, t, temporal), 0));
    let best = costs[0] <= costs[1] ? 0 : 1;

    // Sticky identity: if continuity favours the other option, require a sustained win to swap.
    const continuity = this.continuityChoice(cands, options, t);
    if (continuity !== null && continuity !== best) {
      this.challenger++;
      if (this.challenger < this.confirmFrames) best = continuity;
      else {
        this.challenger = 0;
        this.swaps++;
      }
    } else {
      this.challenger = 0;
    }

    const out = cands.map((h, i) => ({ ...h, side: options[best][i] }));
    for (const h of out) this.prev[h.side] = { pts: anchorPoints(h), t };
    return out;
  }

  reset(): void {
    this.prev = {};
    this.challenger = 0;
  }

  private cost(h: HandObservation, side: Side, pose: Landmark[] | undefined, t: number, temporal: number): number {
    const scale = handScale(h);
    const anchors = anchorPoints(h);
    let cost = 0;

    // 1. Pose anchors (wrist + thumb + index + pinky of that side). Blend between the anchor
    //    distance (wrist seen) and a high "unseen" cost (wrist hidden / off screen).
    if (pose && pose.length >= 23) {
      const p = POSE_HAND[side];
      const w = pose[p.wrist];
      const onScreen = w.x > -0.02 && w.x < 1.02 && w.y > -0.02 && w.y < 1.02 ? 1 : 0;
      const seen = Math.min(1, Math.max(0, ((w.visibility ?? 1) - 0.15) / 0.35)) * onScreen;
      const l = h.landmarks;
      const d =
        l.length >= 21
          ? (dist(l[ANCHORS.wrist], w) +
              dist(l[ANCHORS.thumbTip], pose[p.thumb]) +
              dist(l[ANCHORS.indexMcp], pose[p.index]) +
              dist(l[ANCHORS.pinkyMcp], pose[p.pinky])) /
            4
          : dist(l[0], w);
      cost += this.weights.pose * (seen * Math.min(4, d / scale) + (1 - seen) * this.weights.unseenSide);
    }

    // 2. Temporal continuity: far from this side's last hand costs, and so does looking like the
    //    hand that had the *other* side last frame. Capped so consistent pose + label evidence can
    //    still correct a wrong identity.
    for (const prevSide of ['left', 'right'] as const) {
      const prev = this.recent(prevSide, t);
      if (!prev || prev.pts.length !== anchors.length) continue;
      const d = anchors.reduce((sum, a, i) => sum + dist(a, prev.pts[i]), 0) / anchors.length / scale;
      cost += prevSide === side ? temporal * Math.min(2, d) : temporal * 2 * Math.max(0, 1 - d);
    }

    // 3. Handedness label from MediaPipe (chirality from appearance).
    if (h.side !== side) cost += this.weights.label * h.score;
    return cost;
  }

  private recent(side: Side, t: number) {
    const p = this.prev[side];
    return p && t - p.t < this.memory ? p : null;
  }

  /**
   * Which option keeps the previous identities: each hand is matched to the nearest recent hand
   * of last frame (if close); an option "breaks" continuity when it gives a hand the other side.
   * Returns null when both options are equally continuous (or there is no history).
   */
  private continuityChoice(cands: HandObservation[], options: Side[][], t: number): number | null {
    const nearest = cands.map((h) => {
      const a = anchorPoints(h);
      let best: { side: Side; d: number } | null = null;
      for (const side of ['left', 'right'] as const) {
        const p = this.recent(side, t);
        if (!p || p.pts.length !== a.length) continue;
        const d = a.reduce((sum, pt, k) => sum + dist(pt, p.pts[k]), 0) / a.length / handScale(h);
        if (d < 1 && (!best || d < best.d)) best = { side, d };
      }
      return best;
    });
    const breaks = options.map((sides) => sides.reduce((n, side, i) => n + (nearest[i] && nearest[i]!.side !== side ? 1 : 0), 0));
    if (breaks[0] === breaks[1]) return null;
    return breaks[0] < breaks[1] ? 0 : 1;
  }
}

/**
 * Drop duplicate detections of the same physical hand. All anchors (incl. thumb and pinky) must
 * coincide, so two real hands touching at the wrists are kept apart.
 */
function dedupe(hands: HandObservation[]): HandObservation[] {
  if (hands.length < 2) return hands;
  const out: HandObservation[] = [];
  for (const h of [...hands].sort((a, b) => b.score - a.score)) {
    const a = anchorPoints(h);
    const dup = out.some((o) => {
      const b = anchorPoints(o);
      if (a.length !== b.length) return dist(a[0], b[0]) < handScale(o) * 0.3;
      return a.reduce((sum, pt, i) => sum + dist(pt, b[i]), 0) / a.length < handScale(o) * 0.3;
    });
    if (!dup) out.push(h);
  }
  return out;
}
