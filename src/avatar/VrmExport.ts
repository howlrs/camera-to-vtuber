/**
 * Writes a restyled avatar back to a .vrm by patching the original GLB: material colors, the base
 * color textures that were repainted, the meta name and the thumbnail. Everything else (meshes,
 * skeleton, expressions, spring bones, constraints, license meta) is copied byte for byte, so the
 * result loads anywhere the original did. DOM-free so it can be unit tested in Node.
 *
 * VRM 1.0 keeps MToon colors in glTF (linear) and VRMC_materials_mtoon. VRM 0.x keeps them in
 * extensions.VRM.materialProperties as gamma-encoded values (three-vrm reads them with
 * pow(v, 2.2)), so they are written back with pow(v, 1 / 2.2).
 */

type Json = Record<string, any>;
export type Rgb = [number, number, number];

export interface MaterialPatch {
  /** glTF material index. */
  index: number;
  /** Linear RGB, as three.js holds them. */
  color?: Rgb;
  shade?: Rgb;
  rim?: Rgb;
  emissive?: Rgb;
  /** New base color texture (PNG). Patches with the same key share one image. */
  image?: { key: string; png: Uint8Array };
  /** Make the material invisible: alpha-tested with zero alpha (the meshes stay in the file). */
  hidden?: boolean;
}

export interface VrmPatch {
  materials: MaterialPatch[];
  /** New avatar name (VRM 1.0 meta.name / VRM 0.x meta.title). */
  name?: string;
  /** New thumbnail (PNG). */
  thumbnail?: Uint8Array;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export function parseGlb(buffer: ArrayBuffer): { json: Json; bin: Uint8Array } {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) throw new Error('GLB (.vrm) ではありません');
  if (view.getUint32(4, true) !== 2) throw new Error('glTF 2.0 の GLB だけに対応しています');
  let json: Json | null = null;
  let bin = new Uint8Array(0);
  for (let off = 12; off + 8 <= buffer.byteLength; ) {
    const length = view.getUint32(off, true);
    const type = view.getUint32(off + 4, true);
    const data = new Uint8Array(buffer, off + 8, length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === CHUNK_BIN) bin = data;
    off += 8 + length;
  }
  if (!json) throw new Error('GLB に JSON チャンクがありません');
  return { json, bin };
}

export function buildGlb(json: Json, bin: Uint8Array): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = align4(jsonBytes.length);
  const binLen = align4(bin.length);
  const total = 12 + 8 + jsonLen + (bin.length ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLen, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen); // JSON chunk is padded with spaces
  if (bin.length) {
    const at = 20 + jsonLen;
    view.setUint32(at, binLen, true);
    view.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out.buffer;
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** Texture indices a material reads, in glTF/MToon slots and VRM 0.x textureProperties. */
function materialTextureRefs(json: Json, index: number): Set<number> {
  const refs = new Set<number>();
  const walk = (o: unknown, key: string): void => {
    if (!o || typeof o !== 'object') return;
    if (/texture$/i.test(key) && typeof (o as Json).index === 'number') refs.add((o as Json).index);
    for (const [k, v] of Object.entries(o)) walk(v, k);
  };
  walk(json.materials?.[index], '');
  const props = json.extensions?.VRM?.materialProperties?.[index]?.textureProperties;
  for (const v of Object.values(props ?? {})) if (typeof v === 'number') refs.add(v);
  return refs;
}

function textureImage(json: Json, tex: number | undefined): number | undefined {
  if (tex == null) return undefined;
  const t = json.textures?.[tex];
  return t?.source ?? t?.extensions?.EXT_texture_webp?.source ?? t?.extensions?.KHR_texture_basisu?.source;
}

/** Who reads each image: material indices, or -1 for the meta thumbnail. */
function imageUsers(json: Json): Map<number, Set<number>> {
  const users = new Map<number, Set<number>>();
  const add = (img: number | undefined, user: number) => {
    if (img == null) return;
    if (!users.has(img)) users.set(img, new Set());
    users.get(img)!.add(user);
  };
  (json.materials ?? []).forEach((_: unknown, i: number) => {
    for (const tex of materialTextureRefs(json, i)) add(textureImage(json, tex), i);
  });
  add(json.extensions?.VRMC_vrm?.meta?.thumbnailImage, -1);
  add(textureImage(json, json.extensions?.VRM?.meta?.texture), -1);
  return users;
}

function baseTexture(json: Json, index: number): number | undefined {
  const v0 = json.extensions?.VRM?.materialProperties?.[index]?.textureProperties?._MainTex;
  return typeof v0 === 'number' ? v0 : json.materials?.[index]?.pbrMetallicRoughness?.baseColorTexture?.index;
}

/** Point a material's lit and shade slots that read `from` at texture `to`. */
function repointBase(json: Json, index: number, from: number, to: number): void {
  const m = json.materials[index];
  const base = m.pbrMetallicRoughness?.baseColorTexture;
  if (base?.index === from) base.index = to;
  const shade = m.extensions?.VRMC_materials_mtoon?.shadeMultiplyTexture;
  if (shade?.index === from) shade.index = to;
  const props = json.extensions?.VRM?.materialProperties?.[index]?.textureProperties;
  if (props) for (const k of ['_MainTex', '_ShadeTexture']) if (props[k] === from) props[k] = to;
}

const gammaEncode = (c: Rgb): Rgb => c.map((v) => Math.max(0, v) ** (1 / 2.2)) as Rgb;

/** Alpha-test the material with zero alpha so nothing of it is drawn, in any VRM reader. */
function hideMaterial(json: Json, index: number): void {
  const m = json.materials[index];
  const pbr = (m.pbrMetallicRoughness ??= {});
  const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
  pbr.baseColorFactor = [factor[0], factor[1], factor[2], 0];
  m.alphaMode = 'MASK';
  m.alphaCutoff = 0.5;
  const props = json.extensions?.VRM?.materialProperties?.[index];
  if (props) {
    // UniVRM / three-vrm read VRM 0.x MToon from these: cutout mode, _Color alpha 0.
    const vec = (props.vectorProperties ??= {});
    const color = vec._Color ?? [1, 1, 1, 1];
    vec._Color = [color[0], color[1], color[2], 0];
    const keywords = (props.keywordMap ??= {});
    keywords._ALPHATEST_ON = true;
    delete keywords._ALPHABLEND_ON;
    const floats = (props.floatProperties ??= {});
    floats._BlendMode = 1;
    floats._Cutoff = 0.5;
    props.renderQueue = 2450;
    (props.tagMap ??= {}).RenderType = 'TransparentCutout';
  }
}

function patchColors(json: Json, p: MaterialPatch): void {
  const m = json.materials[p.index];
  const props = json.extensions?.VRM?.materialProperties?.[p.index];
  if (props) {
    const vec = (props.vectorProperties ??= {});
    const set = (key: string, c: Rgb | undefined) => {
      if (c) vec[key] = [...gammaEncode(c), vec[key]?.[3] ?? 1];
    };
    set('_Color', p.color);
    set('_ShadeColor', p.shade);
    set('_RimColor', p.rim);
    set('_EmissionColor', p.emissive);
    // UniVRM mirrors _Color into the glTF factor; keep them consistent for other readers.
    if (p.color) {
      const pbr = (m.pbrMetallicRoughness ??= {});
      pbr.baseColorFactor = [...vec._Color];
    }
    return;
  }
  if (p.color) {
    const pbr = (m.pbrMetallicRoughness ??= {});
    pbr.baseColorFactor = [...p.color, pbr.baseColorFactor?.[3] ?? 1];
  }
  const mtoon = m.extensions?.VRMC_materials_mtoon;
  if (mtoon && p.shade) mtoon.shadeColorFactor = [...p.shade];
  if (mtoon && p.rim) mtoon.parametricRimColorFactor = [...p.rim];
  if (p.emissive) m.emissiveFactor = [...p.emissive];
}

export function patchVrm(buffer: ArrayBuffer, patch: VrmPatch): ArrayBuffer {
  const { json, bin } = parseGlb(buffer);
  if (!json.extensions?.VRMC_vrm && !json.extensions?.VRM) throw new Error('VRM の拡張がありません');
  if ((json.buffers ?? []).length > 1 || (json.bufferViews ?? []).some((bv: Json) => (bv.buffer ?? 0) !== 0)) {
    throw new Error('外部バッファを使う glTF には対応していません');
  }
  json.images ??= [];
  json.textures ??= [];
  json.bufferViews ??= [];
  const views: Uint8Array[] = json.bufferViews.map((bv: Json) => bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
  const origin: number[] = json.bufferViews.map((bv: Json) => (bv.byteOffset ?? 0) % 4);

  const setImageData = (img: number, png: Uint8Array) => {
    const image = json.images[img];
    if (image.bufferView == null) {
      image.bufferView = json.bufferViews.push({ buffer: 0, byteLength: 0 }) - 1;
      views.push(png);
      origin.push(0);
      delete image.uri;
    } else {
      views[image.bufferView] = png;
    }
    image.mimeType = 'image/png';
  };
  const addImage = (png: Uint8Array, name: string): number => {
    const bufferView = json.bufferViews.push({ buffer: 0, byteLength: 0 }) - 1;
    views.push(png);
    origin.push(0);
    return json.images.push({ name, mimeType: 'image/png', bufferView }) - 1;
  };

  // ---- textures: replace an image in place when only the patched materials read it, with one
  // shared result; otherwise (shared with untouched materials, or patched differently) add copies.
  const users = imageUsers(json);
  const groups = new Map<number, MaterialPatch[]>();
  for (const p of patch.materials) {
    if (!p.image || !json.materials?.[p.index]) continue;
    const tex = baseTexture(json, p.index);
    const img = textureImage(json, tex);
    if (tex == null || img == null) continue;
    if (!groups.has(img)) groups.set(img, []);
    groups.get(img)!.push(p);
  }
  for (const [img, ps] of groups) {
    const keys = new Set(ps.map((p) => p.image!.key));
    const patched = new Set(ps.map((p) => p.index));
    const exclusive = [...(users.get(img) ?? [])].every((u) => patched.has(u));
    const plain = ps.every((p) => json.textures[baseTexture(json, p.index)!]?.source === img);
    if (keys.size === 1 && exclusive && plain) {
      setImageData(img, ps[0]!.image!.png);
      continue;
    }
    const copies = new Map<string, number>(); // `${oldTexture}:${key}` -> new texture
    const images = new Map<string, number>(); // key -> new image
    for (const p of ps) {
      const oldTex = baseTexture(json, p.index)!;
      const id = `${oldTex}:${p.image!.key}`;
      if (!copies.has(id)) {
        if (!images.has(p.image!.key)) images.set(p.image!.key, addImage(p.image!.png, `${json.images[img]?.name ?? 'texture'}_edited`));
        const copy: Json = structuredClone(json.textures[oldTex]);
        copy.source = images.get(p.image!.key);
        if (copy.extensions) {
          for (const k of ['EXT_texture_webp', 'KHR_texture_basisu', 'EXT_texture_avif']) delete copy.extensions[k];
        }
        copies.set(id, json.textures.push(copy) - 1);
      }
      repointBase(json, p.index, oldTex, copies.get(id)!);
    }
  }

  for (const p of patch.materials) {
    if (!json.materials?.[p.index]) continue;
    patchColors(json, p);
    if (p.hidden) hideMaterial(json, p.index);
  }

  // ---- meta
  const v1 = json.extensions?.VRMC_vrm?.meta;
  const v0 = json.extensions?.VRM?.meta;
  if (patch.name) {
    if (v1) v1.name = patch.name;
    if (v0) v0.title = patch.name;
  }
  if (patch.thumbnail) {
    const img = v1 ? v1.thumbnailImage : textureImage(json, v0?.texture);
    const onlyThumb = img != null && [...(users.get(img) ?? [])].every((u) => u === -1) && (v1 || json.textures[v0.texture]?.source === img);
    if (onlyThumb) setImageData(img, patch.thumbnail);
    else {
      const added = addImage(patch.thumbnail, 'Thumbnail');
      if (v1) v1.thumbnailImage = added;
      else if (v0) v0.texture = json.textures.push({ source: added }) - 1;
    }
  }

  // ---- rebuild BIN. Views keep their original offset modulo 4 so accessor alignment holds.
  let size = 0;
  const offsets = views.map((v, i) => {
    const at = align4(size) + origin[i]!;
    size = at + v.length;
    return at;
  });
  const out = new Uint8Array(align4(size));
  views.forEach((v, i) => {
    out.set(v, offsets[i]);
    json.bufferViews[i].byteOffset = offsets[i];
    json.bufferViews[i].byteLength = v.length;
  });
  json.buffers ??= [{}];
  json.buffers[0].byteLength = out.length;
  return buildGlb(json, out);
}
