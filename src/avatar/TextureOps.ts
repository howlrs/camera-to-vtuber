/**
 * Local texture operations for the designer / transcription: recoloring an atlas without an image
 * model, and the small images sent to Gemini. The pixel math is DOM-free so it can be unit tested.
 */
import type { ImagePayload } from '../../shared/protocol.ts';

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, v));
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Below this alpha a texel is a cut-out (hair strand gaps) and does not count toward the average. */
const OPAQUE = 128;

// ------------------------------------------------------------------ CIELAB (D65)

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i / 255);

const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const labFinv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r]!;
  const G = LIN[g]!;
  const B = LIN[b]!;
  const fx = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const fy = labF(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const fz = labF((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Lab to 8-bit sRGB, clipping out-of-gamut colors per channel. */
export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const x = 0.95047 * labFinv(fy + a / 500);
  const y = labFinv(fy);
  const z = 1.08883 * labFinv(fy - b / 200);
  const lin = [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
  return lin.map((c) => Math.round(linearToSrgb(Math.min(1, Math.max(0, c))) * 255)) as [number, number, number];
}

/** Weighted quantile from a histogram over [lo, hi). */
function quantile(hist: Float64Array, lo: number, hi: number, q: number): number {
  let total = 0;
  for (const w of hist) total += w;
  if (!total) return (lo + hi) / 2;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]!;
    if (acc >= q * total) return lo + ((i + 0.5) / hist.length) * (hi - lo);
  }
  return hi;
}

const wrapAngle = (d: number) => Math.atan2(Math.sin(d), Math.cos(d));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / Math.max(1e-6, e1 - e0)));
  return t * t * (3 - 2 * t);
};

export interface RecolorOptions {
  /** Color toward the bottom edge of the atlas (hair tips: VRoid hair atlases run root -> tip downward). */
  tip?: string;
  /** Where the gradient to `tip` starts, 0 = top edge, 1 = bottom edge. */
  tipStart?: number;
}

const CHROMA_ANCHOR = 4; // below this Lab chroma the anchor counts as gray

/**
 * Recolor RGBA pixels (row-major, `width` texels per row) in place so the texture's main color
 * becomes `hex`, keeping its shading and details.
 *
 * The main color is the chroma-weighted median of the opaque texels, so a small colored iris on a
 * black atlas, or skin crossed by dark lines, still anchors on the colored part. Each texel then
 * keeps its offset from that anchor in CIELAB: lightness differences are kept (scaled down only
 * where they would clip at black or white), chroma is kept as a ratio (gray highlights and lines
 * stay gray) and small hue shifts such as blush are kept. With `tip`, the target fades from `hex`
 * at the top to `tip` at the bottom. Alpha is untouched. Returns false without opaque texels.
 */
export function recolorPixels(data: Uint8ClampedArray, width: number, hex: string, opts: RecolorOptions = {}): boolean {
  const count = data.length / 4;
  const height = Math.max(1, Math.round(count / Math.max(1, width)));
  const lab = new Int16Array(count * 3); // Lab x 100
  const lHist = new Float64Array(1000); // L, alpha-weighted (spread)
  const lW = new Float64Array(1000); // L, chroma-weighted (anchor)
  const aW = new Float64Array(1024); // a in [-128, 128), chroma-weighted
  const bW = new Float64Array(1024);
  let opaque = 0;
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (data[i + 3] === 0) continue;
    const [L, a, b] = rgbToLab(data[i]!, data[i + 1]!, data[i + 2]!);
    lab[p * 3] = Math.round(L * 100);
    lab[p * 3 + 1] = Math.round(a * 100);
    lab[p * 3 + 2] = Math.round(b * 100);
    const alpha = data[i + 3]!;
    if (alpha < OPAQUE) continue;
    opaque++;
    const w = alpha * (Math.hypot(a, b) + 2);
    const li = Math.min(999, Math.max(0, Math.floor(L * 10)));
    lHist[li] += alpha;
    lW[li] += w;
    aW[Math.min(1023, Math.max(0, Math.floor((a + 128) * 4)))] += w;
    bW[Math.min(1023, Math.max(0, Math.floor((b + 128) * 4)))] += w;
  }
  if (!opaque) return false;

  const La = quantile(lW, 0, 100, 0.5);
  const aa = quantile(aW, -128, 128, 0.5);
  const ba = quantile(bW, -128, 128, 0.5);
  const Ca = Math.hypot(aa, ba);
  const ha = Math.atan2(ba, aa);
  const grayAnchor = Ca < CHROMA_ANCHOR;
  // How far the texture reaches above and below the anchor (98% of texels).
  const up = Math.max(1, quantile(lHist, 0, 100, 0.98) - La);
  const down = Math.max(1, La - quantile(lHist, 0, 100, 0.02));

  const base = rgbToLab(...hexToRgb(hex));
  const tip = opts.tip ? rgbToLab(...hexToRgb(opts.tip)) : null;
  const tipStart = opts.tipStart ?? 0.5;

  for (let y = 0; y < height; y++) {
    const f = tip ? smoothstep(tipStart, 1, height > 1 ? y / (height - 1) : 0) : 0;
    const Lt = tip ? base[0] + (tip[0] - base[0]) * f : base[0];
    const at = tip ? base[1] + (tip[1] - base[1]) * f : base[1];
    const bt = tip ? base[2] + (tip[2] - base[2]) * f : base[2];
    const Ct = Math.hypot(at, bt);
    const ht = Math.atan2(bt, at);
    const sUp = Math.min(1, Math.max(0, 99 - Lt) / up);
    const sDown = Math.min(1, Math.max(0, Lt - 1) / down);
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      if (p >= count || data[i + 3] === 0) continue;
      const L = lab[p * 3]! / 100;
      const a = lab[p * 3 + 1]! / 100;
      const b = lab[p * 3 + 2]! / 100;
      const dL = L - La;
      const Lo = Lt + dL * (dL > 0 ? sUp : sDown);
      const C = Math.hypot(a, b);
      // A gray atlas has no chroma to follow: highlights fade toward white instead.
      const Co = grayAnchor ? Ct * Math.min(1, Math.max(0, (100 - Lo) / Math.max(1, 100 - Lt))) : Ct * Math.min(2, C / Ca);
      // Keep hue shifts of colored texels relative to the anchor (blush, warm shadows), bounded.
      const dh = !grayAnchor && C >= CHROMA_ANCHOR ? Math.max(-0.8, Math.min(0.8, wrapAngle(Math.atan2(b, a) - ha))) : 0;
      const rgb = labToRgb(Lo, Co * Math.cos(ht + dh), Co * Math.sin(ht + dh));
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
    }
  }
  return true;
}

/**
 * Shade multiplier once a texture carries the final colors itself: a neutral gray that keeps the
 * author's lit-to-shade brightness ratio but drops the hue they tuned for the old color.
 * Colors are linear RGB.
 */
export function neutralShade(color: [number, number, number], shade: [number, number, number]): number {
  const lit = luminance(...color);
  if (lit < 1e-4) return 1;
  return Math.min(1, Math.max(0, luminance(...shade) / lit));
}

// ------------------------------------------------------------------ DOM helpers

export type TextureSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

export function sourceSize(src: TextureSource): { width: number; height: number } {
  const s = src as { naturalWidth?: number; width: number; height: number; naturalHeight?: number };
  return { width: s.naturalWidth || s.width, height: s.naturalHeight || s.height };
}

export function toCanvas(src: TextureSource, maxSide = Infinity): HTMLCanvasElement {
  const { width, height } = sourceSize(src);
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** A recolored copy of a texture, or null when it has no opaque texels. */
export function recolorTexture(src: TextureSource, hex: string, opts: RecolorOptions = {}): HTMLCanvasElement | null {
  const canvas = toCanvas(src);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  if (!recolorPixels(img.data, canvas.width, hex, opts)) return null;
  g.putImageData(img, 0, 0);
  return canvas;
}

/** Key color for texels no mesh samples (see the image prompts on the server). */
export const UNUSED_KEY = [255, 0, 255] as const;

/**
 * Pixel step of keyUnused(): texels outside the mask (or fully transparent) become opaque
 * magenta, every other texel becomes opaque with its own color, so the image model sees islands
 * on a flat key instead of transparency it might fill with a checkerboard.
 */
export function keyUnusedPixels(data: Uint8ClampedArray, mask: Uint8ClampedArray | null): void {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0 || (mask && mask[i + 3]! < 128)) {
      data[i] = UNUSED_KEY[0];
      data[i + 1] = UNUSED_KEY[1];
      data[i + 2] = UNUSED_KEY[2];
    }
    data[i + 3] = 255;
  }
}

/** The atlas as sent to the image model: used islands on a magenta key, fully opaque. */
export function keyUnused(atlas: HTMLCanvasElement, mask: HTMLCanvasElement | null): HTMLCanvasElement {
  const out = toCanvas(atlas);
  const g = out.getContext('2d', { willReadFrequently: true })!;
  const img = g.getImageData(0, 0, out.width, out.height);
  const m = mask ? mask.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, out.width, out.height).data : null;
  keyUnusedPixels(img.data, m);
  g.putImageData(img, 0, 0);
  return out;
}

/**
 * Merge an image-model repaint into the original atlas: repainted texels only where the meshes
 * sample (mask), the original elsewhere, and the original alpha everywhere (hair cut-outs).
 */
export function composeRepaint(original: HTMLCanvasElement, repaint: CanvasImageSource, mask: HTMLCanvasElement | null): HTMLCanvasElement {
  const { width, height } = original;
  const layer = document.createElement('canvas');
  layer.width = width;
  layer.height = height;
  const lg = layer.getContext('2d')!;
  lg.drawImage(repaint, 0, 0, width, height); // resampled to the atlas size so UVs keep lining up
  if (mask) {
    lg.globalCompositeOperation = 'destination-in';
    lg.drawImage(mask, 0, 0);
  }
  const out = toCanvas(original);
  const g = out.getContext('2d')!;
  g.drawImage(layer, 0, 0);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(original, 0, 0);
  return out;
}

/**
 * Line art drawn in grayscale on the magenta key back to RGBA: the magenta excess min(R, B) - G
 * is the uncovered share of each texel, and the key color is removed from the edges (despill).
 */
export function keyAlphaPixels(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const a = Math.min(1, Math.max(0, 1 - (Math.min(r, b) - g) / 255));
    if (a < 0.02) {
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
      continue;
    }
    data[i] = Math.min(255, Math.max(0, Math.round((r - (1 - a) * UNUSED_KEY[0]) / a)));
    data[i + 1] = Math.min(255, Math.max(0, Math.round((g - (1 - a) * UNUSED_KEY[1]) / a)));
    data[i + 2] = Math.min(255, Math.max(0, Math.round((b - (1 - a) * UNUSED_KEY[2]) / a)));
    data[i + 3] = Math.round(a * 255);
  }
}

/** Above this share of the used texels changed, an "add only" face edit redrew the face instead. */
export const OVERLAY_MAX_COVERAGE = 0.25;

/**
 * Per-texel weight of an "add only" edit: 1 where the new texture differs clearly from the old,
 * 0 where it matches, and 0 on the old texture's edges (eye, nose and mouth outlines), where a
 * slightly shifted redraw would otherwise leave ghost lines. Returns the weights (feathered) and
 * the share of used texels that changed.
 */
export function overlayWeights(
  orig: Uint8ClampedArray,
  next: Uint8ClampedArray,
  width: number,
  used: Uint8ClampedArray | null,
): { weights: Float32Array; coverage: number } {
  const count = orig.length / 4;
  const height = count / width;
  const luma = new Float32Array(count);
  for (let p = 0; p < count; p++) luma[p] = 0.299 * orig[p * 4]! + 0.587 * orig[p * 4 + 1]! + 0.114 * orig[p * 4 + 2]!;
  let w = new Float32Array(count);
  let total = 0;
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      if ((used && used[i + 3]! < 128) || orig[i + 3] === 0) continue;
      total++;
      const d = Math.hypot(next[i]! - orig[i]!, next[i + 1]! - orig[i + 1]!, next[i + 2]! - orig[i + 2]!);
      // Local contrast: the largest step to a 4-neighbour (also high on 1-px lines themselves).
      const l = luma[p]!;
      const edge = Math.max(
        Math.abs(l - luma[x + 1 < width ? p + 1 : p]!),
        Math.abs(l - luma[x > 0 ? p - 1 : p]!),
        Math.abs(l - luma[y + 1 < height ? p + width : p]!),
        Math.abs(l - luma[y > 0 ? p - width : p]!),
      );
      const v = smoothstep(18, 40, d) * (1 - smoothstep(6, 16, edge));
      w[p] = v;
      if (v > 0.5) changed++;
    }
  }
  // Feather: two passes of a 5x5 box blur, each split into a horizontal and a vertical 5-tap pass.
  for (let pass = 0; pass < 4; pass++) {
    const horizontal = pass % 2 === 0;
    const out = new Float32Array(count);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let acc = 0;
        let n = 0;
        for (let o = -2; o <= 2; o++) {
          const xx = horizontal ? x + o : x;
          const yy = horizontal ? y : y + o;
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
          acc += w[yy * width + xx]!;
          n++;
        }
        out[y * width + x] = acc / n;
      }
    }
    w = out;
  }
  return { weights: w, coverage: total ? changed / total : 0 };
}

function pixels(canvas: HTMLCanvasElement): ImageData {
  return canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
}

function resampled(src: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.getContext('2d')!.drawImage(src, 0, 0, width, height);
  return c;
}

/**
 * Merge redrawn line art: inside the used islands the keyed strokes replace the old ones (alpha
 * included, so the shape changes); outside, the original stays.
 */
export function composeShape(original: HTMLCanvasElement, repaint: CanvasImageSource, mask: HTMLCanvasElement | null): HTMLCanvasElement {
  const { width, height } = original;
  const layer = resampled(repaint, width, height);
  const img = pixels(layer);
  keyAlphaPixels(img.data);
  const lg = layer.getContext('2d')!;
  lg.putImageData(img, 0, 0);
  const used = mask ? pixels(mask).data : null;
  const reason = shapeRejection(alphaCoverage(pixels(original).data, used), alphaCoverage(img.data, used));
  if (reason) throw new Error(reason);
  const out = toCanvas(original);
  const g = out.getContext('2d')!;
  if (mask) {
    lg.globalCompositeOperation = 'destination-in';
    lg.drawImage(mask, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(mask, 0, 0);
  } else {
    g.clearRect(0, 0, width, height);
  }
  g.globalCompositeOperation = 'source-over';
  g.drawImage(layer, 0, 0);
  return out;
}

/**
 * Merge an "add only" edit (blush, freckles, face paint): only texels that clearly changed are
 * blended in. Throws when the edit changed too much of the atlas (the model redrew the face).
 */
export function composeOverlay(original: HTMLCanvasElement, repaint: CanvasImageSource, mask: HTMLCanvasElement | null): HTMLCanvasElement {
  const { width, height } = original;
  const orig = pixels(original);
  const next = pixels(resampled(repaint, width, height));
  const used = mask ? pixels(mask).data : null;
  const { weights, coverage } = overlayWeights(orig.data, next.data, width, used);
  if (coverage > OVERLAY_MAX_COVERAGE) {
    throw new Error(`顔の ${Math.round(coverage * 100)}% が描き直されたため採用しませんでした`);
  }
  const out = toCanvas(original);
  const g = out.getContext('2d', { willReadFrequently: true })!;
  const img = g.getImageData(0, 0, width, height);
  const d = img.data;
  for (let p = 0; p < weights.length; p++) {
    const k = weights[p]!;
    if (k <= 0) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) d[i + c] = Math.round(d[i + c]! + (next.data[i + c]! - d[i + c]!) * k);
  }
  g.putImageData(img, 0, 0);
  return out;
}

// ------------------------------------------------------------------ framing atlases for the image model

/** Aspect ratios the image models accept (see atlasAspectRatio on the server). */
export const MODEL_ASPECTS = [1, 4 / 3, 3 / 4, 16 / 9, 9 / 16, 2 / 3, 3 / 2];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bounding box of the used texels (mask alpha >= 128), padded. Null when nothing is used or the
 * box already covers most of the atlas (then the whole atlas is sent).
 */
export function usedBounds(mask: Uint8ClampedArray, width: number, height: number, maxShare = 0.5): Rect | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[(y * width + x) * 4 + 3]! < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const pad = Math.max(8, Math.round(0.03 * Math.max(width, height)));
  const x = Math.max(0, x0 - pad);
  const y = Math.max(0, y0 - pad);
  const w = Math.min(width, x1 + 1 + pad) - x;
  const h = Math.min(height, y1 + 1 + pad) - y;
  return w * h > maxShare * width * height ? null : { x, y, w, h };
}

/** The smallest frame with a model-supported aspect that holds w x h, and where w x h sits in it. */
export function frameFor(w: number, h: number): { fw: number; fh: number; ox: number; oy: number } {
  const a = w / h;
  const best = MODEL_ASPECTS.reduce((b, r) => (Math.abs(Math.log(r / a)) < Math.abs(Math.log(b / a)) ? r : b));
  const fw = best >= a ? Math.round(h * best) : w;
  const fh = best >= a ? h : Math.round(w / best);
  return { fw: Math.max(fw, w), fh: Math.max(fh, h), ox: Math.floor((Math.max(fw, w) - w) / 2), oy: Math.floor((Math.max(fh, h) - h) / 2) };
}

/** A copy of one region of a canvas. */
export function region(src: HTMLCanvasElement, r: Rect): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = r.w;
  c.height = r.h;
  c.getContext('2d')!.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return c;
}

/**
 * What the image model receives for an atlas: only the used region (small islands such as an iris
 * or a brow otherwise sit on an empty canvas, which invites the model to draw a picture there),
 * centred in a magenta frame of a supported aspect, scaled up to `minSide` on its long side.
 * `back(image)` turns the model's answer into a canvas the size of the region.
 */
export function frameAtlas(
  keyed: HTMLCanvasElement,
  minSide = 1024,
): { image: HTMLCanvasElement; aspect: number; back: (img: CanvasImageSource) => HTMLCanvasElement } {
  const { width: w, height: h } = keyed;
  const { fw, fh, ox, oy } = frameFor(w, h);
  const s = Math.max(1, minSide / Math.max(fw, fh));
  const image = document.createElement('canvas');
  image.width = Math.round(fw * s);
  image.height = Math.round(fh * s);
  const g = image.getContext('2d')!;
  g.fillStyle = `rgb(${UNUSED_KEY.join(',')})`;
  g.fillRect(0, 0, image.width, image.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(keyed, ox * s, oy * s, w * s, h * s);
  const back = (img: CanvasImageSource) => {
    const full = resampled(img, image.width, image.height);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d')!.drawImage(full, ox * s, oy * s, w * s, h * s, 0, 0, w, h);
    return out;
  };
  return { image, aspect: fw / fh, back };
}

/** `atlas` with `part` drawn over the rectangle `r` (replacing it, alpha included). */
export function pasteRegion(atlas: HTMLCanvasElement, part: HTMLCanvasElement, r: Rect): HTMLCanvasElement {
  const out = toCanvas(atlas);
  const g = out.getContext('2d')!;
  g.clearRect(r.x, r.y, r.w, r.h);
  g.drawImage(part, r.x, r.y);
  return out;
}

/** Per texel: `b` inside the mask (alpha >= 128), `a` elsewhere. Both the same size. */
export function mergeByMask(a: HTMLCanvasElement, b: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const out = toCanvas(a);
  const g = out.getContext('2d', { willReadFrequently: true })!;
  const img = g.getImageData(0, 0, out.width, out.height);
  const pb = pixels(b).data;
  const m = pixels(mask).data;
  for (let i = 0; i < img.data.length; i += 4) {
    if (m[i + 3]! < 128) continue;
    img.data[i] = pb[i]!;
    img.data[i + 1] = pb[i + 1]!;
    img.data[i + 2] = pb[i + 2]!;
    img.data[i + 3] = pb[i + 3]!;
  }
  g.putImageData(img, 0, 0);
  return out;
}

/** Mean alpha (0..1) over the used texels, for comparing line art before and after a redraw. */
export function alphaCoverage(data: Uint8ClampedArray, mask: Uint8ClampedArray | null): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (mask && mask[i + 3]! < 128) continue;
    sum += data[i + 3]!;
    n++;
  }
  return n ? sum / n / 255 : 0;
}

/**
 * A redraw of line art is kept only if its ink stays in proportion to the original strokes: more
 * than ~2.5x (or +15 points) means it filled the islands with blocks, under a fifth means it erased
 * them. Returns the reason to reject, or null.
 */
export function shapeRejection(before: number, after: number): string | null {
  if (after > Math.max(before * 2.5, before + 0.15)) return `線が元の ${(after / Math.max(before, 1e-3)).toFixed(1)} 倍に広がったため採用しませんでした`;
  if (after < before * 0.2) return '線がほとんど消えたため採用しませんでした';
  return null;
}

export function canvasPayload(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): ImagePayload {
  const [head, data] = canvas.toDataURL(type, quality).split(',', 2);
  return { data: data!, mimeType: head!.match(/data:([^;]+)/)?.[1] ?? type };
}

/**
 * A user's reference image, downscaled for Gemini. Transparent backgrounds become white so the
 * character stays visible after JPEG encoding.
 */
export async function referencePayload(file: Blob, maxSide = 1536): Promise<{ payload: ImagePayload; url: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const payload = canvasPayload(canvas, 'image/jpeg', 0.92);
  return { payload, url: `data:${payload.mimeType};base64,${payload.data}` };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めません'));
    img.src = src;
  });
}

export function canvasToBytes(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('画像を書き出せません'));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, type),
  );
}
