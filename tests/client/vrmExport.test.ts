import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGlb, parseGlb, patchVrm } from '../../src/avatar/VrmExport.ts';

type Json = Record<string, any>;

/** Lay out views back to back, honoring each view's requested offset modulo 4. */
function glb(json: Json, views: { data: Uint8Array; mod?: number }[]): ArrayBuffer {
  let size = 0;
  const offsets = views.map((v) => {
    const at = ((size + 3) & ~3) + (v.mod ?? 0);
    size = at + v.data.length;
    return at;
  });
  const bin = new Uint8Array((size + 3) & ~3);
  views.forEach((v, i) => bin.set(v.data, offsets[i]));
  json.bufferViews = views.map((v, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: v.data.length }));
  json.buffers = [{ byteLength: bin.length }];
  return buildGlb(json, bin);
}

const bytes = (...v: number[]) => new Uint8Array(v);
const png = (tag: number) => bytes(0x89, 0x50, 0x4e, 0x47, tag, tag, tag);

function viewData(out: ArrayBuffer, view: number): Uint8Array {
  const { json, bin } = parseGlb(out);
  const bv = json.bufferViews[view];
  return bin.slice(bv.byteOffset, bv.byteOffset + bv.byteLength);
}

function imageData(out: ArrayBuffer, image: number): Uint8Array {
  return viewData(out, parseGlb(out).json.images[image].bufferView);
}

function vrm1(): ArrayBuffer {
  const json: Json = {
    asset: { version: '2.0' },
    extensionsUsed: ['VRMC_vrm', 'VRMC_materials_mtoon'],
    extensions: { VRMC_vrm: { specVersion: '1.0', meta: { name: 'Base', authors: ['author'], licenseUrl: 'https://example.invalid/l', thumbnailImage: 3 } } },
    accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5123, count: 3, type: 'SCALAR' }],
    images: [
      { name: 'hair', mimeType: 'image/png', bufferView: 1 },
      { name: 'wear', mimeType: 'image/png', bufferView: 2 },
      { name: 'nml', mimeType: 'image/png', bufferView: 3 },
      { name: 'thumb', mimeType: 'image/png', bufferView: 4 },
    ],
    samplers: [{ magFilter: 9729 }],
    textures: [0, 1, 2, 3].map((source) => ({ source, sampler: 0 })),
    materials: [
      {
        name: 'Hair',
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 0.5] },
        extensions: { VRMC_materials_mtoon: { specVersion: '1.0', shadeMultiplyTexture: { index: 0 }, shadeColorFactor: [1, 1, 1] } },
      },
      {
        name: 'Wear',
        pbrMetallicRoughness: { baseColorTexture: { index: 1 } },
        normalTexture: { index: 2 },
        extensions: { VRMC_materials_mtoon: { specVersion: '1.0', shadeMultiplyTexture: { index: 1 }, shadeColorFactor: [0.5, 0.5, 0.5] } },
      },
      { name: 'Metal', pbrMetallicRoughness: { baseColorTexture: { index: 1 } } },
    ],
  };
  // The index data sits at offset ≡ 2 (mod 4), as some exporters pack 2-byte data.
  return glb(json, [
    { data: bytes(1, 0, 2, 0, 3, 0), mod: 2 },
    { data: png(1) },
    { data: png(2) },
    { data: png(3) },
    { data: png(4) },
  ]);
}

describe('patchVrm (VRM 1.0)', () => {
  it('replaces an atlas in place when only the patched material reads it, and writes linear colors', () => {
    const out = patchVrm(vrm1(), { materials: [{ index: 0, color: [0.2, 0.4, 0.6], shade: [0.7, 0.7, 0.7], image: { key: 'a', png: png(9) } }] });
    const { json } = parseGlb(out);
    expect(json.images).toHaveLength(4);
    expect([...imageData(out, 0)]).toEqual([...png(9)]);
    expect(json.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([0.2, 0.4, 0.6, 0.5]); // alpha kept
    expect(json.materials[0].extensions.VRMC_materials_mtoon.shadeColorFactor).toEqual([0.7, 0.7, 0.7]);
    expect([...imageData(out, 1)]).toEqual([...png(2)]); // other atlases untouched
  });

  it('copies a shared atlas instead of changing a material that was not restyled', () => {
    const out = patchVrm(vrm1(), { materials: [{ index: 1, image: { key: 'w', png: png(7) } }] });
    const { json } = parseGlb(out);
    expect(json.images).toHaveLength(5);
    expect(json.textures).toHaveLength(5);
    const wear = json.materials[1];
    const copy = wear.pbrMetallicRoughness.baseColorTexture.index;
    expect(copy).toBe(4);
    expect(wear.extensions.VRMC_materials_mtoon.shadeMultiplyTexture.index).toBe(4);
    expect(json.textures[4]).toEqual({ source: 4, sampler: 0 });
    expect([...imageData(out, 4)]).toEqual([...png(7)]);
    expect(wear.normalTexture.index).toBe(2); // other slots keep their textures
    expect(json.materials[2].pbrMetallicRoughness.baseColorTexture.index).toBe(1);
    expect([...imageData(out, 1)]).toEqual([...png(2)]);
  });

  it('replaces a shared atlas in place when every reader got the same new atlas', () => {
    const image = { key: 'same', png: png(8) };
    const out = patchVrm(vrm1(), { materials: [{ index: 1, image }, { index: 2, image }] });
    const { json } = parseGlb(out);
    expect(json.images).toHaveLength(4);
    expect([...imageData(out, 1)]).toEqual([...png(8)]);
  });

  it('gives materials patched with different atlases their own copies', () => {
    const out = patchVrm(vrm1(), {
      materials: [
        { index: 1, image: { key: 'x', png: png(5) } },
        { index: 2, image: { key: 'y', png: png(6) } },
      ],
    });
    const { json } = parseGlb(out);
    expect(json.images).toHaveLength(6);
    const t1 = json.materials[1].pbrMetallicRoughness.baseColorTexture.index;
    const t2 = json.materials[2].pbrMetallicRoughness.baseColorTexture.index;
    expect(t1).not.toBe(t2);
    expect([...imageData(out, json.textures[t1].source)]).toEqual([...png(5)]);
    expect([...imageData(out, json.textures[t2].source)]).toEqual([...png(6)]);
  });

  it('renames the avatar and replaces the thumbnail, keeping license meta', () => {
    const out = patchVrm(vrm1(), { materials: [], name: 'ミナ', thumbnail: png(42) });
    const { json } = parseGlb(out);
    const meta = json.extensions.VRMC_vrm.meta;
    expect(meta.name).toBe('ミナ');
    expect(meta.authors).toEqual(['author']);
    expect(meta.licenseUrl).toBe('https://example.invalid/l');
    expect(meta.thumbnailImage).toBe(3);
    expect([...imageData(out, 3)]).toEqual([...png(42)]);
  });

  it('keeps geometry bytes, their alignment, and a valid GLB layout', () => {
    const out = patchVrm(vrm1(), { materials: [{ index: 0, image: { key: 'a', png: new Uint8Array(1001).fill(3) } }], thumbnail: png(1) });
    const { json, bin } = parseGlb(out);
    expect(out.byteLength % 4).toBe(0);
    expect(new DataView(out).getUint32(8, true)).toBe(out.byteLength);
    expect(json.buffers[0].byteLength).toBe(bin.length);
    expect(json.bufferViews[0].byteOffset % 4).toBe(2);
    expect([...viewData(out, 0)]).toEqual([1, 0, 2, 0, 3, 0]);
    for (const bv of json.bufferViews) expect(bv.byteOffset + bv.byteLength).toBeLessThanOrEqual(bin.length);
  });

  it('rejects files that are not VRM', () => {
    const plain = glb({ asset: { version: '2.0' } }, [{ data: bytes(1, 2, 3, 4) }]);
    expect(() => patchVrm(plain, { materials: [] })).toThrow(/VRM/);
    expect(() => patchVrm(new ArrayBuffer(32), { materials: [] })).toThrow(/GLB/);
  });
});

function vrm0(): ArrayBuffer {
  const json: Json = {
    asset: { version: '2.0' },
    extensionsUsed: ['VRM'],
    extensions: {
      VRM: {
        meta: { title: 'Base0', author: 'author', texture: 2 },
        materialProperties: [
          {
            name: 'Hair',
            shader: 'VRM/MToon',
            vectorProperties: { _Color: [0.5, 0.2, 0.7, 0.8], _ShadeColor: [0.3, 0.3, 0.6, 1] },
            textureProperties: { _MainTex: 0, _ShadeTexture: 0, _BumpMap: 1 },
          },
        ],
      },
    },
    images: [
      { name: 'hair', mimeType: 'image/png', bufferView: 0 },
      { name: 'nml', mimeType: 'image/png', bufferView: 1 },
      { name: 'thumb', mimeType: 'image/png', bufferView: 2 },
    ],
    textures: [0, 1, 2].map((source) => ({ source })),
    materials: [{ name: 'Hair', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [0.5, 0.2, 0.7, 0.8] } }],
  };
  return glb(json, [{ data: png(1) }, { data: png(2) }, { data: png(3) }]);
}

describe('hidden materials', () => {
  it('VRM 1.0: alpha-tested with zero alpha, color kept', () => {
    const out = patchVrm(vrm1(), { materials: [{ index: 2, hidden: true }] });
    const m = parseGlb(out).json.materials[2];
    expect(m.alphaMode).toBe('MASK');
    expect(m.alphaCutoff).toBe(0.5);
    expect(m.pbrMetallicRoughness.baseColorFactor).toEqual([1, 1, 1, 0]);
  });

  it('VRM 0.x: cutout MToon with _Color alpha 0 (what UniVRM and three-vrm read)', () => {
    const out = patchVrm(vrm0(), { materials: [{ index: 0, hidden: true }] });
    const { json } = parseGlb(out);
    const props = json.extensions.VRM.materialProperties[0];
    expect(props.vectorProperties._Color).toEqual([0.5, 0.2, 0.7, 0]);
    expect(props.keywordMap._ALPHATEST_ON).toBe(true);
    expect(props.floatProperties).toMatchObject({ _BlendMode: 1, _Cutoff: 0.5 });
    expect(props.renderQueue).toBe(2450);
    expect(props.tagMap.RenderType).toBe('TransparentCutout');
    expect(json.materials[0].alphaMode).toBe('MASK');
  });
});

describe('patchVrm (VRM 0.x)', () => {
  it('writes gamma-encoded MToon colors that three-vrm decodes back (pow 2.2)', () => {
    const out = patchVrm(vrm0(), { materials: [{ index: 0, color: [0.25, 0.5, 1], shade: [0.6, 0.6, 0.6] }] });
    const props = parseGlb(out).json.extensions.VRM.materialProperties[0];
    const decoded = props.vectorProperties._Color.slice(0, 3).map((v: number) => v ** 2.2);
    expect(decoded[0]).toBeCloseTo(0.25, 6);
    expect(decoded[1]).toBeCloseTo(0.5, 6);
    expect(decoded[2]).toBeCloseTo(1, 6);
    expect(props.vectorProperties._Color[3]).toBe(0.8); // alpha is linear and kept
    expect(props.vectorProperties._ShadeColor[0] ** 2.2).toBeCloseTo(0.6, 6);
    expect(parseGlb(out).json.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual(props.vectorProperties._Color);
  });

  it('replaces _MainTex in place and the meta texture thumbnail, and renames via title', () => {
    const out = patchVrm(vrm0(), { materials: [{ index: 0, image: { key: 'h', png: png(9) } }], name: '新しい名前', thumbnail: png(8) });
    const { json } = parseGlb(out);
    expect(json.images).toHaveLength(3);
    expect([...imageData(out, 0)]).toEqual([...png(9)]);
    expect([...imageData(out, 1)]).toEqual([...png(2)]);
    expect([...imageData(out, 2)]).toEqual([...png(8)]);
    expect(json.extensions.VRM.meta.title).toBe('新しい名前');
    expect(json.extensions.VRM.meta.author).toBe('author');
  });
});

// ---- the bundled samples (fetched by `npm run setup`)

const SAMPLES = {
  twist: 'public/avatars/VRM1_Constraint_Twist_Sample.vrm',
  seed: 'public/avatars/Seed-san.vrm',
  fumiriya: 'public/avatars/Sakurada_Fumiriya.vrm',
};

function load(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function materialIndex(json: Json, name: string): number {
  return json.materials.findIndex((m: Json) => m.name === name);
}

/** Every buffer view except the given images must keep its exact bytes. */
function expectUnchangedExcept(before: ArrayBuffer, after: ArrayBuffer, images: number[]): void {
  const a = parseGlb(before);
  const b = parseGlb(after);
  const skip = new Set(images.map((i) => a.json.images[i].bufferView));
  a.json.bufferViews.forEach((bv: Json, i: number) => {
    if (skip.has(i)) return;
    const x = a.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const nb = b.json.bufferViews[i];
    const y = b.bin.subarray(nb.byteOffset, nb.byteOffset + nb.byteLength);
    expect(Buffer.compare(x, y), `bufferView ${i}`).toBe(0);
  });
  expect(b.json.accessors).toEqual(a.json.accessors);
  expect(b.json.nodes).toEqual(a.json.nodes);
  expect(b.json.meshes).toEqual(a.json.meshes);
}

describe.skipIf(!existsSync(SAMPLES.twist))('patchVrm on the bundled samples', () => {
  it('Twist (VRM 1.0): repaints the hair atlas in place, everything else byte-identical', () => {
    const src = load(SAMPLES.twist);
    const json = parseGlb(src).json;
    const hair = materialIndex(json, 'Hair_00_HAIR');
    const img = json.textures[json.materials[hair].pbrMetallicRoughness.baseColorTexture.index].source;
    const out = patchVrm(src, { materials: [{ index: hair, color: [1, 1, 1], image: { key: 'h', png: png(9) } }], name: 'T' });
    expect([...imageData(out, img)]).toEqual([...png(9)]);
    expectUnchangedExcept(src, out, [img]);
    const after = parseGlb(out).json;
    expect(after.extensions.VRMC_springBone).toEqual(json.extensions.VRMC_springBone);
    expect(after.extensions.VRMC_vrm.expressions).toEqual(json.extensions.VRMC_vrm.expressions);
    expect(after.extensions.VRMC_vrm.meta.name).toBe('T');
  });

  it.skipIf(!existsSync(SAMPLES.seed))('Seed-san (shared atlases): copies the atlas for the one restyled material', () => {
    const src = load(SAMPLES.seed);
    const json = parseGlb(src).json;
    const huku = materialIndex(json, 'huku_bake');
    const metal = materialIndex(json, 'wear_metal');
    const out = patchVrm(src, { materials: [{ index: huku, image: { key: 'w', png: png(5) } }] });
    const after = parseGlb(out).json;
    expect(after.images).toHaveLength(json.images.length + 1);
    expect(after.materials[metal]).toEqual(json.materials[metal]);
    expect(after.materials[huku].pbrMetallicRoughness.baseColorTexture.index).toBe(json.textures.length);
    expectUnchangedExcept(src, out, []);
  });

  it.skipIf(!existsSync(SAMPLES.fumiriya))('桜田 史利矢 (VRM 0.x): hides the necktie, everything else byte-identical', () => {
    const src = load(SAMPLES.fumiriya);
    const json = parseGlb(src).json;
    const tie = materialIndex(json, 'M00_001_01_Accessory_01_CLOTH');
    const out = patchVrm(src, { materials: [{ index: tie, hidden: true }] });
    const after = parseGlb(out).json;
    expect(after.extensions.VRM.materialProperties[tie].vectorProperties._Color[3]).toBe(0);
    expect(after.extensions.VRM.materialProperties.filter((_: unknown, i: number) => i !== tie)).toEqual(
      json.extensions.VRM.materialProperties.filter((_: unknown, i: number) => i !== tie),
    );
    expectUnchangedExcept(src, out, []);
  });

  it.skipIf(!existsSync(SAMPLES.fumiriya))('桜田 史利矢 (VRM 0.x): repaints and recolors the hair in materialProperties', () => {
    const src = load(SAMPLES.fumiriya);
    const json = parseGlb(src).json;
    const hair = materialIndex(json, 'F00_000_Hair_00_HAIR_01');
    const img = json.textures[json.extensions.VRM.materialProperties[hair].textureProperties._MainTex].source;
    const out = patchVrm(src, { materials: [{ index: hair, color: [1, 1, 1], shade: [0.6, 0.6, 0.6], image: { key: 'h', png: png(3) } }] });
    const after = parseGlb(out).json;
    expect(after.extensions.VRM.materialProperties[hair].vectorProperties._Color).toEqual([1, 1, 1, 1]);
    expect(after.extensions.VRM.secondaryAnimation).toEqual(json.extensions.VRM.secondaryAnimation);
    expect(after.extensions.VRM.blendShapeMaster).toEqual(json.extensions.VRM.blendShapeMaster);
    expect([...imageData(out, img)]).toEqual([...png(3)]);
    expectUnchangedExcept(src, out, [img]);
  });
});
