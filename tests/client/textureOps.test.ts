import { describe, expect, it } from 'vitest';
import {
  hexToRgb,
  keyAlphaPixels,
  keyUnusedPixels,
  labToRgb,
  linearToSrgb,
  neutralShade,
  OVERLAY_MAX_COVERAGE,
  overlayWeights,
  recolorPixels,
  rgbToLab,
  srgbToLinear,
} from '../../src/avatar/TextureOps.ts';

type Px = [number, number, number, number];
const pixels = (...px: Px[]) => new Uint8ClampedArray(px.flat());
const rgbAt = (d: Uint8ClampedArray, p: number) => [d[p * 4]!, d[p * 4 + 1]!, d[p * 4 + 2]!] as [number, number, number];
const L = (rgb: [number, number, number]) => rgbToLab(...rgb)[0];
/** Max per-channel difference. */
const diff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
const hue = (rgb: [number, number, number]) => {
  const [, a, b] = rgbToLab(...rgb);
  return Math.atan2(b, a);
};

describe('recolorPixels', () => {
  it('maps a flat texture to the target color', () => {
    const d = pixels([90, 60, 40, 255], [90, 60, 40, 255]);
    expect(recolorPixels(d, 2, '#c0d0e0')).toBe(true);
    expect(diff(rgbAt(d, 0), hexToRgb('#c0d0e0'))).toBeLessThanOrEqual(1);
  });

  it('dark brown hair -> platinum: the main tone hits the target, strands keep their order and stay light', () => {
    // shadow, main tone (x3), highlight
    const d = pixels([40, 25, 15, 255], [80, 50, 30, 255], [80, 50, 30, 255], [80, 50, 30, 255], [160, 120, 90, 255]);
    recolorPixels(d, 5, '#e8dcc0');
    expect(diff(rgbAt(d, 1), hexToRgb('#e8dcc0'))).toBeLessThanOrEqual(2);
    const [shadow, mid, high] = [0, 1, 4].map((p) => L(rgbAt(d, p)));
    expect(shadow).toBeLessThan(mid!);
    expect(mid).toBeLessThan(high!);
    expect(shadow).toBeGreaterThan(60); // light hair keeps visible but light shadows
    expect(high).toBeLessThanOrEqual(100);
  });

  it('anchors on the colored iris, not the black atlas background around it', () => {
    // 6 black background texels, 2 brown iris texels, 1 dark pupil
    const bg: Px = [0, 0, 0, 255];
    const d = pixels(bg, bg, bg, bg, bg, bg, [150, 90, 40, 255], [150, 90, 40, 255], [40, 20, 10, 255]);
    recolorPixels(d, 9, '#8a5cd6');
    expect(diff(rgbAt(d, 6), hexToRgb('#8a5cd6'))).toBeLessThanOrEqual(2);
    expect(L(rgbAt(d, 0))).toBeLessThan(8); // background stays (near) black
    expect(L(rgbAt(d, 8))).toBeLessThan(L(rgbAt(d, 6)) - 20); // pupil stays dark
  });

  it('skin crossed by dark lines: skin follows the target, lines stay dark and gray', () => {
    const skin: Px = [250, 225, 210, 255];
    const d = pixels(skin, skin, skin, [255, 200, 200, 255], [20, 20, 20, 255]);
    recolorPixels(d, 5, '#c58c6a'); // tanned
    expect(diff(rgbAt(d, 0), hexToRgb('#c58c6a'))).toBeLessThanOrEqual(2);
    expect(hue(rgbAt(d, 3))).not.toBeCloseTo(hue(rgbAt(d, 0)), 1); // blush keeps its own hue shift
    expect(L(rgbAt(d, 4))).toBeLessThan(15);
  });

  it('turns a light gray texture into a dark color without crushing detail', () => {
    const d = pixels([200, 200, 200, 255], [200, 200, 200, 255], [240, 240, 240, 255]);
    recolorPixels(d, 3, '#202840');
    expect(diff(rgbAt(d, 0), hexToRgb('#202840'))).toBeLessThanOrEqual(2);
    expect(L(rgbAt(d, 0))).toBeLessThan(L(rgbAt(d, 2)));
  });

  it('fades to the tip color toward the bottom rows (hair tips)', () => {
    const g: Px = [120, 120, 120, 255];
    // 1 column, 5 rows
    const d = pixels(g, g, g, g, g);
    recolorPixels(d, 1, '#dfe3ea', { tip: '#8fd3ff', tipStart: 0.5 });
    expect(diff(rgbAt(d, 0), hexToRgb('#dfe3ea'))).toBeLessThanOrEqual(2);
    expect(diff(rgbAt(d, 2), hexToRgb('#dfe3ea'))).toBeLessThanOrEqual(2);
    expect(diff(rgbAt(d, 4), hexToRgb('#8fd3ff'))).toBeLessThanOrEqual(3);
    const mid = rgbAt(d, 3);
    expect(mid[0]).toBeLessThan(0xdf);
    expect(mid[0]).toBeGreaterThan(0x8f);
  });

  it('leaves alpha untouched, skips fully transparent texels, and ignores cut-outs for the anchor', () => {
    const d = pixels([10, 20, 30, 0], [100, 100, 100, 255], [250, 250, 250, 40]);
    recolorPixels(d, 3, '#ff0000');
    expect([...d.slice(0, 4)]).toEqual([10, 20, 30, 0]);
    expect(d[7]).toBe(255);
    expect(d[11]).toBe(40);
    expect(diff(rgbAt(d, 1), [255, 0, 0])).toBeLessThanOrEqual(1);
  });

  it('reports textures with no opaque texels', () => {
    expect(recolorPixels(pixels([10, 20, 30, 0], [1, 2, 3, 100]), 2, '#ffffff')).toBe(false);
  });
});

describe('neutralShade', () => {
  it('keeps the author lit/shade brightness ratio as a gray', () => {
    // 桜田 史利矢 HairBack (VRM 0.x, gamma values converted to linear the way three-vrm does)
    const lin = (v: number[]) => v.map((x) => x ** 2.2) as [number, number, number];
    const g = neutralShade(lin([0.492, 0.236, 0.694]), lin([0.239, 0.262, 0.584]));
    expect(g).toBeGreaterThan(0.5);
    expect(g).toBeLessThan(0.8);
  });

  it('is 1 for white-on-white and clamps brighter shades', () => {
    expect(neutralShade([1, 1, 1], [1, 1, 1])).toBe(1);
    expect(neutralShade([0.2, 0.2, 0.2], [0.9, 0.9, 0.9])).toBe(1);
    expect(neutralShade([0, 0, 0], [0.5, 0.5, 0.5])).toBe(1);
  });
});

describe('color conversions', () => {
  it('sRGB round-trips', () => {
    for (const v of [0, 0.02, 0.2, 0.5, 0.9, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
  });
  it('Lab round-trips 8-bit colors and matches reference values', () => {
    for (const c of ['#000000', '#ffffff', '#8a5cd6', '#e8dcc0', '#1f2a4a', '#ff0000']) {
      const rgb = hexToRgb(c);
      expect(diff(labToRgb(...rgbToLab(...rgb)), rgb)).toBeLessThanOrEqual(1);
    }
    const [l, a, b] = rgbToLab(255, 0, 0);
    expect(l).toBeCloseTo(53.24, 1);
    expect(a).toBeCloseTo(80.09, 0);
    expect(b).toBeCloseTo(67.2, 0);
  });
});

describe('keyUnusedPixels', () => {
  it('keys unused and transparent texels magenta and makes everything opaque', () => {
    const d = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0, 1, 2, 3, 255]);
    const mask = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0]);
    keyUnusedPixels(d, mask);
    expect([...d]).toEqual([10, 20, 30, 255, 40, 50, 60, 255, 255, 0, 255, 255, 255, 0, 255, 255]);
  });
  it('without a mask only transparent texels are keyed', () => {
    const d = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 0]);
    keyUnusedPixels(d, null);
    expect([...d]).toEqual([1, 2, 3, 255, 255, 0, 255, 255]);
  });
});

describe('retintGlow', () => {
  it('keeps the glow strength and takes the new hue; gray without a known color', async () => {
    const { Color } = await import('three');
    const { retintGlow } = await import('../../src/avatar/VrmAvatar.ts');
    const lum = (c: InstanceType<typeof Color>) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    // 桜田 史利矢 front hair: orange glow (VRM 0.x gamma value decoded like three-vrm does)
    const orange = new Color(0.74 ** 2.2, 0.22 ** 2.2, 0);
    const blue = retintGlow(orange, '#8fd3ff')!;
    expect(lum(blue)).toBeCloseTo(lum(orange), 4);
    expect(blue.b).toBeGreaterThan(blue.r);
    const gray = retintGlow(orange)!;
    expect(gray.r).toBeCloseTo(gray.b, 6);
    expect(lum(gray)).toBeCloseTo(lum(orange), 4);
    expect(retintGlow(new Color(0, 0, 0), '#ffffff')).toBeNull();
  });
});

describe('keyAlphaPixels (gray line art on the magenta key)', () => {
  it('magenta becomes transparent, gray stays opaque, and half-covered edges lose the key color', () => {
    const d = new Uint8ClampedArray([255, 0, 255, 255, 40, 40, 40, 255, 255, 255, 255, 255, 148, 20, 148, 255]);
    keyAlphaPixels(d);
    expect([...d.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...d.slice(4, 8)]).toEqual([40, 40, 40, 255]);
    expect([...d.slice(8, 12)]).toEqual([255, 255, 255, 255]);
    // (40,40,40) half over magenta: about 50% alpha, color back to a neutral dark gray
    const [r, g, b, a] = d.slice(12, 16);
    expect(a).toBeGreaterThan(120);
    expect(a).toBeLessThan(140);
    expect(Math.abs(r! - g!)).toBeLessThan(12);
    expect(Math.abs(b! - g!)).toBeLessThan(12);
  });
});

describe('overlayWeights (add-only face edits)', () => {
  const W = 32;
  /** A smooth skin atlas with a dark horizontal "mouth line" at row 24. */
  const skin = () => {
    const d = new Uint8ClampedArray(W * W * 4);
    for (let p = 0; p < W * W; p++) {
      const y = Math.floor(p / W);
      const line = y === 24 ? 120 : 0;
      d.set([250 - line, 225 - line, 210 - line, 255], p * 4);
    }
    return d;
  };

  it('keeps a blush blob and nothing else', () => {
    const orig = skin();
    const next = skin();
    for (let y = 6; y < 12; y++) for (let x = 6; x < 12; x++) next.set([245, 150, 160, 255], (y * W + x) * 4);
    const { weights, coverage } = overlayWeights(orig, next, W, null);
    expect(coverage).toBeLessThan(OVERLAY_MAX_COVERAGE);
    expect(weights[9 * W + 9]).toBeGreaterThan(0.5);
    expect(weights[20 * W + 25]).toBe(0);
  });

  it('ignores changes on existing outlines (a redraw shifted by a pixel)', () => {
    const orig = skin();
    const next = skin();
    for (let x = 0; x < W; x++) {
      next.set([250, 225, 210, 255], (24 * W + x) * 4);
      next.set([130, 105, 90, 255], (25 * W + x) * 4);
    }
    const { weights } = overlayWeights(orig, next, W, null);
    expect(weights[24 * W + 16]).toBeLessThan(0.2);
  });

  it('reports a redrawn face as broad coverage', () => {
    const orig = skin();
    const next = skin().map((v, i) => (i % 4 === 3 ? v : Math.max(0, v - 60)));
    expect(overlayWeights(orig, next, W, null).coverage).toBeGreaterThan(OVERLAY_MAX_COVERAGE);
  });
});

describe('facePart', () => {
  it('recognizes VRoid face materials and leaves others alone', async () => {
    const { facePart } = await import('../../src/avatar/AvatarRig.ts');
    expect(facePart('EyeIris_00_EYE', 'EYE')).toBe('iris');
    expect(facePart('M00_000_00_EyeHighlight_00_EYE', 'EYE')).toBe('highlight');
    expect(facePart('EyeWhite_00_EYE', 'EYE')).toBe('eyeWhite');
    expect(facePart('FaceBrow_00_FACE', 'FACE')).toBe('brow');
    expect(facePart('M00_000_00_FaceEyelash_00_FACE', 'FACE')).toBe('lash');
    expect(facePart('FaceEyeline_00_FACE', 'FACE')).toBe('line');
    expect(facePart('FaceMouth_00_FACE', 'FACE')).toBe('mouth');
    expect(facePart('Face_00_SKIN', 'SKIN')).toBe('face');
    expect(facePart('Body_00_SKIN', 'SKIN')).toBeUndefined();
    expect(facePart('M00_000_00_EyeExtra_01_EYE', 'EYE')).toBeUndefined();
    expect(facePart('robo_face', 'FACE')).toBeUndefined();
    expect(facePart('Hair_00_HAIR', 'HAIR')).toBeUndefined();
  });
});

describe('framing atlases for the image model', () => {
  it('bounds the used islands with padding, and skips framing when they fill the atlas', async () => {
    const { usedBounds } = await import('../../src/avatar/TextureOps.ts');
    const W = 400;
    const mask = new Uint8ClampedArray(W * W * 4);
    for (let y = 100; y < 120; y++) for (let x = 50; x < 150; x++) mask[(y * W + x) * 4 + 3] = 255; // a brow-sized island
    expect(usedBounds(mask, W, W)).toEqual({ x: 38, y: 88, w: 124, h: 44 });
    mask.fill(255);
    expect(usedBounds(mask, W, W)).toBeNull();
    expect(usedBounds(new Uint8ClampedArray(W * W * 4), W, W)).toBeNull();
  });

  it('pads a region to the nearest aspect the image model accepts', async () => {
    const { frameFor } = await import('../../src/avatar/TextureOps.ts');
    const f = frameFor(124, 44); // ~2.8:1 -> 16:9, taller frame, region centred vertically
    expect(f.fw).toBe(124);
    expect(f.fw / f.fh).toBeCloseTo(16 / 9, 1);
    expect(f.oy).toBe(Math.floor((f.fh - 44) / 2));
    expect(frameFor(512, 512)).toEqual({ fw: 512, fh: 512, ox: 0, oy: 0 });
  });

  it('rejects line art that turned into blocks or vanished', async () => {
    const { shapeRejection, alphaCoverage } = await import('../../src/avatar/TextureOps.ts');
    expect(shapeRejection(0.2, 0.25)).toBeNull(); // thicker brows are fine
    expect(shapeRejection(0.2, 0.9)).toMatch(/広がった/);
    expect(shapeRejection(0.2, 0.02)).toMatch(/消えた/);
    const d = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0]);
    const m = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(alphaCoverage(d, null)).toBe(0.5);
    expect(alphaCoverage(d, m)).toBe(0.5);
  });
});
