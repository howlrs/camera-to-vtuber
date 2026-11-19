import { describe, expect, it } from 'vitest';
import { HandIdentityTracker } from '../../src/tracking/HandIdentity.ts';
import type { HandObservation, Landmark, Side } from '../../src/core/types.ts';

// Image space (+x right, +y down). Palm facing the camera, fingers up: a person's LEFT hand has
// its thumb toward image right (+x) in an unmirrored image, the RIGHT hand toward image left.
function hand(wx: number, wy: number, thumbDir: 1 | -1, label: Side, score = 0.9): HandObservation {
  const l: Landmark[] = Array.from({ length: 21 }, () => ({ x: wx, y: wy - 0.06, z: 0 }));
  const set = (i: number, dx: number, dy: number) => (l[i] = { x: wx + dx, y: wy + dy, z: 0 });
  set(0, 0, 0);
  set(1, thumbDir * 0.02, -0.02);
  set(4, thumbDir * 0.055, -0.05);
  set(5, thumbDir * 0.022, -0.08);
  set(9, 0, -0.085);
  set(17, -thumbDir * 0.025, -0.07);
  set(20, -thumbDir * 0.03, -0.12);
  return { side: label, landmarks: l, world: [], score };
}

function pose(left: { w: [number, number]; t: [number, number]; i: [number, number]; p: [number, number] }, right: typeof left): Landmark[] {
  const p: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  const put = (i: number, [x, y]: [number, number]) => (p[i] = { x, y, z: 0, visibility: 0.9 });
  put(15, left.w); put(21, left.t); put(19, left.i); put(17, left.p);
  put(16, right.w); put(22, right.t); put(20, right.i); put(18, right.p);
  return p;
}
const anchorsOf = (h: HandObservation) => ({
  w: [h.landmarks[0].x, h.landmarks[0].y] as [number, number],
  t: [h.landmarks[4].x, h.landmarks[4].y] as [number, number],
  i: [h.landmarks[5].x, h.landmarks[5].y] as [number, number],
  p: [h.landmarks[17].x, h.landmarks[17].y] as [number, number],
});
const sidesOf = (out: HandObservation[], a: HandObservation) => out.find((h) => h.landmarks[0] === a.landmarks[0] || (h.landmarks[0].x === a.landmarks[0].x && h.landmarks[4].x === a.landmarks[4].x))!.side;

describe('HandIdentityTracker', () => {
  it('uses thumb/pinky anchors when the wrists are together (hands touching)', () => {
    const A = hand(0.5, 0.6, 1, 'left'); // person's left hand
    const B = hand(0.5, 0.6, -1, 'left'); // person's right hand, but mislabelled "left"
    const p = pose(anchorsOf(A), anchorsOf(B));
    const out = new HandIdentityTracker().assign([A, B], p, 0);
    expect(sidesOf(out, A)).toBe('left');
    expect(sidesOf(out, B)).toBe('right');
  });

  it('keeps identities through a short pose swap (e.g. arms crossing)', () => {
    const tr = new HandIdentityTracker();
    const A = hand(0.65, 0.6, 1, 'left');
    const B = hand(0.35, 0.6, -1, 'right');
    const good = pose(anchorsOf(A), anchorsOf(B));
    const swapped = pose(anchorsOf(B), anchorsOf(A));
    for (let i = 0; i < 10; i++) tr.assign([A, B], good, i / 60);
    for (let i = 10; i < 13; i++) {
      const out = tr.assign([B, A], swapped, i / 60); // detection order and pose both flip
      expect(sidesOf(out, A)).toBe('left');
      expect(sidesOf(out, B)).toBe('right');
    }
    expect(tr.swaps).toBe(0);
  });

  it('ignores a one-frame handedness label flip', () => {
    const tr = new HandIdentityTracker();
    const A = hand(0.65, 0.6, 1, 'left');
    for (let i = 0; i < 10; i++) tr.assign([A], undefined, i / 60);
    const flipped = { ...A, side: 'right' as Side, score: 1 };
    expect(tr.assign([flipped], undefined, 10 / 60)[0].side).toBe('left');
  });

  it('follows two hands that cross each other', () => {
    const tr = new HandIdentityTracker();
    // Left hand moves from right to left across the image while the right hand does the opposite.
    for (let i = 0; i <= 40; i++) {
      const x = 0.7 - (0.4 * i) / 40;
      const A = hand(x, 0.6, 1, 'left');
      const B = hand(1 - x, 0.62, -1, 'right');
      const out = tr.assign([A, B], undefined, i / 60);
      expect(sidesOf(out, A)).toBe('left');
      expect(sidesOf(out, B)).toBe('right');
    }
  });

  it('corrects a wrong identity when pose and label consistently disagree', () => {
    const tr = new HandIdentityTracker();
    const A = hand(0.7, 0.6, 1, 'right', 0.3); // starts wrongly labelled, no pose yet
    for (let i = 0; i < 5; i++) tr.assign([A], undefined, i / 60);
    const fixed = { ...A, side: 'left' as Side, score: 0.95 };
    const p = pose(anchorsOf(A), anchorsOf(hand(0.3, 0.6, -1, 'right')));
    let side: Side = 'right';
    for (let i = 5; i < 20; i++) side = tr.assign([fixed], p, i / 60)[0].side;
    expect(side).toBe('left');
    expect(tr.swaps).toBe(1);
  });
});

describe('single raised hand in close-up framing (real-camera regression)', () => {
  // Pose sees the LEFT wrist clearly (vis 0.97) and the RIGHT arm is hidden below the frame.
  const closeUpPose = (h: HandObservation): Landmark[] => {
    const p = pose(anchorsOf(h), { w: [0.3, 1.2], t: [0.3, 1.25], i: [0.3, 1.25], p: [0.3, 1.25] });
    for (const i of [16, 18, 20, 22]) p[i].visibility = 0.12;
    // pose thumb/index/pinky are only rough in practice: offset them a bit
    p[21] = { ...p[21], x: p[21].x + 0.03 };
    p[19] = { ...p[19], y: p[19].y + 0.03 };
    return p;
  };

  it('puts the hand on the side whose wrist the pose sees, not the hidden one', () => {
    const H = hand(0.7, 0.45, 1, 'left');
    expect(new HandIdentityTracker().assign([H], closeUpPose(H), 0)[0].side).toBe('left');
  });

  it('even against a misleading handedness label', () => {
    const H = hand(0.7, 0.45, 1, 'right', 0.95);
    expect(new HandIdentityTracker().assign([H], closeUpPose(H), 0)[0].side).toBe('left');
  });

  it('recovers within a few frames from an identity established on the hidden side', () => {
    const tr = new HandIdentityTracker();
    const H = hand(0.7, 0.45, 1, 'right', 0.95);
    for (let i = 0; i < 10; i++) tr.assign([H], undefined, i / 60); // no pose: label says right
    let side: Side = 'right';
    const fixed = { ...H, side: 'left' as Side };
    for (let i = 10; i < 20; i++) side = tr.assign([fixed], closeUpPose(H), i / 60)[0].side;
    expect(side).toBe('left');
  });
});
