import { describe, expect, it } from 'vitest';
import { repaintMode, type MaterialInfo } from '../../shared/protocol.ts';
import { designParts, isEmptyStyle, parseDesignRequest, sanitizeStyle } from '../../server/gemini/designer.ts';
import { atlasAspectRatio, irisNote, overlayTexturePrompt, referenceTexturePrompt, shapeTexturePrompt } from '../../server/gemini/imagery.ts';
import { buildTranscribePrompt, parseTranscribeRequest, sanitizeTranscription } from '../../server/gemini/transcribe.ts';

const img = { data: 'AAAA', mimeType: 'image/jpeg' };
const mats: MaterialInfo[] = [
  { name: 'Hair', category: 'HAIR', baseColor: '#ffffff', hasTexture: true },
  { name: 'Iris', category: 'EYE', baseColor: '#ffffff', hasTexture: true },
  { name: 'Tops', category: 'CLOTH', baseColor: '#ffffff', hasTexture: true },
  { name: 'Glass', category: 'OTHER', baseColor: '#000000', hasTexture: false },
];

describe('sanitizeStyle recolors', () => {
  it('keeps recolors on textured materials only, drops duplicates and those also repainted', () => {
    const s = sanitizeStyle(
      {
        recolors: [
          { material: 'Hair', color: '#E8DCC0' },
          { material: 'Hair', color: '#000000' },
          { material: 'Glass', color: '#ffffff' },
          { material: 'Tops', color: '#112233' },
          { material: 'Iris', color: 'gold' },
        ],
        textureEdits: [{ material: 'Tops', prompt: 'navy sailor collar' }],
      },
      mats,
    );
    expect(s.recolors).toEqual([{ material: 'Hair', color: '#e8dcc0' }]);
    expect(s.textureEdits).toEqual([{ material: 'Tops', prompt: 'navy sailor collar' }]);
  });

  it('keeps hair-tip gradients and clamps where they start', () => {
    const s = sanitizeStyle(
      {
        recolors: [
          { material: 'Hair', color: '#dfe3ea', tipColor: '#8FD3FF', tipStart: 3 },
          { material: 'Iris', color: '#8a5cd6', tipColor: '#8a5cd6' },
        ],
      },
      mats,
    );
    expect(s.recolors).toEqual([
      { material: 'Hair', color: '#dfe3ea', tipColor: '#8fd3ff', tipStart: 0.95 },
      { material: 'Iris', color: '#8a5cd6' },
    ]);
  });

  it('never sends hair, skin, eye or face atlases to the image model', () => {
    const all: MaterialInfo[] = (['HAIR', 'SKIN', 'EYE', 'FACE', 'CLOTH', 'OTHER'] as const).map((category) => ({
      name: category,
      category,
      baseColor: '#ffffff',
      hasTexture: true,
    }));
    const raw = { textureEdits: all.map((m) => ({ material: m.name, prompt: 'x' })) };
    for (const mode of ['design', 'transcribe'] as const) {
      expect(sanitizeStyle(raw, all, mode).textureEdits.map((e) => e.material)).toEqual(['CLOTH', 'OTHER']);
    }
  });

  it('allows more repaints when transcribing than for a free design', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `M${i}`, category: 'CLOTH' as const, baseColor: '#ffffff', hasTexture: true }));
    const raw = { textureEdits: many.map((m) => ({ material: m.name, prompt: 'x' })) };
    expect(sanitizeStyle(raw, many).textureEdits).toHaveLength(3);
    expect(sanitizeStyle(raw, many, 'transcribe').textureEdits).toHaveLength(8);
  });
});

describe('parseDesignRequest (transcribe)', () => {
  const base = { prompt: 'p', materials: mats, baseModel: 'Twist' };

  it('requires references and caps them at 4', () => {
    expect(() => parseDesignRequest({ ...base, mode: 'transcribe' })).toThrow(/references/);
    expect(() => parseDesignRequest({ ...base, mode: 'transcribe', references: [img, img, img, img, img] })).toThrow(/at most 4/);
    expect(() => parseDesignRequest({ ...base, mode: 'transcribe', references: [{ data: 'x', mimeType: 'image/gif' }] })).toThrow();
  });

  it('keeps only atlases that name known materials, and defaults to design mode', () => {
    const req = parseDesignRequest({
      ...base,
      mode: 'transcribe',
      references: [img],
      atlases: [
        { materials: ['Hair', 'Ghost'], image: img },
        { materials: ['Ghost'], image: img },
      ],
    });
    expect(req.mode).toBe('transcribe');
    expect(req.atlases).toEqual([{ materials: ['Hair'], image: img }]);
    expect(parseDesignRequest(base).mode).toBe('design');
  });

  it('labels every reference and atlas so the model can tell them apart', () => {
    const req = parseDesignRequest({ ...base, mode: 'transcribe', references: [img, img], atlases: [{ materials: ['Tops'], image: img }] });
    const parts = designParts(req);
    const texts = parts.map((p) => p.text ?? (p.inlineData ? '<img>' : '?'));
    expect(texts.slice(1)).toEqual(['参照画像 1:', '<img>', '参照画像 2:', '<img>', 'テクスチャ: Tops', '<img>']);
    expect(parts[0]!.text).toContain('素体 VRM「Twist」');
    expect(parts[0]!.text).toContain('Tops (category CLOTH');
  });
});

describe('transcribe (base model choice)', () => {
  const candidates = [
    { id: 'twist', traits: 'long hair' },
    { id: 'fumiriya', traits: 'short hair' },
  ];

  it('validates references and candidates', () => {
    expect(() => parseTranscribeRequest({ references: [], candidates })).toThrow(/references/);
    expect(() => parseTranscribeRequest({ references: [img], candidates: [] })).toThrow(/candidates/);
    expect(() => parseTranscribeRequest({ references: [img], candidates: [candidates[0], candidates[0]] })).toThrow(/unique/);
    const req = parseTranscribeRequest({ references: [img], candidates, notes: '  名前はミナ  ' });
    expect(req.notes).toBe('名前はミナ');
    expect(buildTranscribePrompt(req)).toContain('- fumiriya: short hair');
    expect(buildTranscribePrompt(req)).toContain('名前はミナ');
  });

  it('falls back to the first candidate for an unknown choice and requires a brief', () => {
    const req = parseTranscribeRequest({ references: [img], candidates });
    expect(sanitizeTranscription({ baseModel: 'seed', brief: 'silver hair' }, req).baseModel).toBe('twist');
    expect(sanitizeTranscription({ baseModel: 'fumiriya', brief: 'b', reason: 'short' }, req)).toEqual({
      baseModel: 'fumiriya',
      brief: 'b',
      reason: 'short',
      summary: '',
    });
    expect(() => sanitizeTranscription({ baseModel: 'twist' }, req)).toThrow(/description/);
  });
});

describe('reference-matched texture repaint', () => {
  it('picks the closest supported aspect ratio for the atlas', () => {
    expect(atlasAspectRatio(1)).toBe('1:1');
    expect(atlasAspectRatio(2048 / 1024)).toBe('16:9');
    expect(atlasAspectRatio(0.5)).toBe('9:16');
    expect(atlasAspectRatio(1.3)).toBe('4:3');
  });

  it('keeps the UV-layout rules and forbids pasting the drawing', () => {
    const p = referenceTexturePrompt('Tops_01_CLOTH', 'navy with white lines', 2);
    expect(p).toContain('Images 2-3 show the character');
    expect(p).toContain('Keep the EXACT UV layout');
    expect(p).toContain('Never paste the reference drawing');
    expect(p).toContain('Solid magenta (#ff00ff) marks unused space');
    expect(p).toContain("keep the islands' shape");
    expect(referenceTexturePrompt('Hair', 'x', 1)).toContain('Image 2 shows');
  });
});

describe('face parts', () => {
  const face: MaterialInfo[] = [
    { name: 'EyeIris', category: 'EYE', part: 'iris', baseColor: '#ffffff', hasTexture: true },
    { name: 'EyeWhite', category: 'EYE', part: 'eyeWhite', baseColor: '#ffffff', hasTexture: true },
    { name: 'BrowDrawn', category: 'FACE', part: 'brow', drawnShape: true, baseColor: '#5e4645', hasTexture: true },
    { name: 'BrowMesh', category: 'FACE', part: 'brow', baseColor: '#5e4645', hasTexture: true },
    { name: 'FaceSkin', category: 'SKIN', part: 'face', baseColor: '#ffffff', hasTexture: true },
    { name: 'BodySkin', category: 'SKIN', baseColor: '#ffffff', hasTexture: true },
    { name: 'Hair', category: 'HAIR', baseColor: '#ffffff', hasTexture: true },
    { name: 'Tops', category: 'CLOTH', baseColor: '#ffffff', hasTexture: true },
  ];

  it('repaints irises, drawn line art and face additions, never mesh-shaped brows, eye whites, body skin or hair', () => {
    expect(face.map((m) => [m.name, repaintMode(m)])).toEqual([
      ['EyeIris', 'paint'],
      ['EyeWhite', null],
      ['BrowDrawn', 'shape'],
      ['BrowMesh', null],
      ['FaceSkin', 'overlay'],
      ['BodySkin', null],
      ['Hair', null],
      ['Tops', 'paint'],
    ]);
    const s = sanitizeStyle({ textureEdits: face.map((m) => ({ material: m.name, prompt: 'x' })) }, face, 'transcribe');
    expect(s.textureEdits.map((e) => e.material)).toEqual(['EyeIris', 'BrowDrawn', 'FaceSkin', 'Tops']);
  });

  it('keeps the recolor of redrawn line art (it comes back gray) but not of other repaints', () => {
    const s = sanitizeStyle(
      {
        textureEdits: [
          { material: 'BrowDrawn', prompt: 'thick straight brows' },
          { material: 'EyeIris', prompt: 'star pupils' },
        ],
        recolors: [
          { material: 'BrowDrawn', color: '#2a1f1c' },
          { material: 'EyeIris', color: '#3366ff' },
        ],
      },
      face,
      'transcribe',
    );
    expect(s.recolors).toEqual([{ material: 'BrowDrawn', color: '#2a1f1c' }]);
  });

  it('passes part and drawn-shape flags through the request and shows them to the model', () => {
    const req = parseDesignRequest({ prompt: 'p', baseModel: 'b', materials: [...face, { name: 'Bad', category: 'EYE', part: 'nose', baseColor: '#000000', hasTexture: true }] });
    expect(req.materials.find((m) => m.name === 'BrowDrawn')).toMatchObject({ part: 'brow', drawnShape: true });
    expect(req.materials.find((m) => m.name === 'Bad')!.part).toBeUndefined();
    const text = designParts({ ...req, mode: 'transcribe', references: [img] })[0]!.text!;
    expect(text).toContain('BrowDrawn (category FACE, 眉・形はテクスチャ');
    expect(text).toContain('BrowMesh (category FACE, 眉・形はメッシュ');
    expect(text).toContain('画像生成で形も描き直し可');
    expect(text).toContain('FaceSkin (category SKIN, 顔の肌');
    expect(text).toContain('画像生成で描き足し可');
  });

  it('uses part-specific image prompts', () => {
    expect(irisNote('right')).toContain("right side of the atlas is the character's own LEFT eye");
    expect(irisNote()).not.toContain('LEFT eye');
    const shape = shapeTexturePrompt('FaceBrow', 'brow', 'thick', 1);
    expect(shape).toContain('EYEBROWS');
    expect(shape).toContain('GRAYSCALE');
    expect(shape).toContain('exactly solid magenta');
    const overlay = overlayTexturePrompt('Face_00_SKIN', 'pink blush on both cheeks', 2);
    expect(overlay).toContain('Add only this');
    expect(overlay).toContain('Images 2-3 show');
  });
});

describe('heterochromia', () => {
  const eyes: MaterialInfo[] = [
    { name: 'EyeIris', category: 'EYE', part: 'iris', leftEye: 'right', baseColor: '#ffffff', hasTexture: true },
    { name: 'Hair', category: 'HAIR', baseColor: '#ffffff', hasTexture: true },
  ];

  it('keeps a left-eye color on irises only', () => {
    const s = sanitizeStyle(
      {
        recolors: [
          { material: 'EyeIris', color: '#e8b23a', leftEyeColor: '#2AA79B' },
          { material: 'Hair', color: '#f6b8cf', leftEyeColor: '#000000' },
        ],
      },
      eyes,
      'transcribe',
    );
    expect(s.recolors).toEqual([
      { material: 'EyeIris', color: '#e8b23a', leftEyeColor: '#2aa79b' },
      { material: 'Hair', color: '#f6b8cf' },
    ]);
  });

  it('tells the designer which iris island is which eye', () => {
    const req = parseDesignRequest({ prompt: 'p', baseModel: 'b', materials: eyes, mode: 'transcribe', references: [img] });
    expect(req.materials[0]!.leftEye).toBe('right');
    expect(designParts(req)[0]!.text).toContain('縮小画像の右の島がキャラクター自身の左目、左の島が右目');
  });
});

describe('isEmptyStyle', () => {
  it('flags a spec that would change nothing', () => {
    const empty = sanitizeStyle({ persona: { name: 'x' } }, mats, 'transcribe');
    expect(isEmptyStyle(empty)).toBe(true);
    expect(isEmptyStyle({ ...empty, recolors: [{ material: 'Hair', color: '#000000' }] })).toBe(false);
  });
});

describe('irises shared by both eyes', () => {
  it('drops a left-eye color when both eyes sample one island, and says so to the designer', () => {
    const shared: MaterialInfo[] = [{ name: 'EyeIris', category: 'EYE', part: 'iris', leftEye: 'shared', baseColor: '#ffffff', hasTexture: true }];
    const s = sanitizeStyle({ recolors: [{ material: 'EyeIris', color: '#e8b23a', leftEyeColor: '#2aa79b' }] }, shared, 'transcribe');
    expect(s.recolors).toEqual([{ material: 'EyeIris', color: '#e8b23a' }]);
    const req = parseDesignRequest({ prompt: 'p', baseModel: 'b', materials: shared, mode: 'transcribe', references: [img] });
    expect(designParts(req)[0]!.text).toContain('左右の目が同じ島を共有');
  });
});

describe('hiding base parts and painting bare limbs', () => {
  const outfit: MaterialInfo[] = [
    { name: 'Tie', category: 'CLOTH', baseColor: '#ff6600', hasTexture: true },
    { name: 'Tops', category: 'CLOTH', baseColor: '#ffffff', hasTexture: true },
    { name: 'Body', category: 'SKIN', baseColor: '#ffffff', hasTexture: true },
    { name: 'FaceBrow', category: 'FACE', part: 'brow', baseColor: '#000000', hasTexture: true },
    { name: 'Hair', category: 'HAIR', baseColor: '#ffffff', hasTexture: true },
  ];

  it('hides overlaid outfit parts only, and drops other changes to them', () => {
    const s = sanitizeStyle(
      {
        hide: ['Tie', 'Body', 'FaceBrow', 'Hair', 'Ghost', 'Tie'],
        recolors: [{ material: 'Tie', color: '#000000' }],
        textureEdits: [{ material: 'Tie', prompt: 'x' }],
      },
      outfit,
      'transcribe',
    );
    expect(s.hide).toEqual(['Tie']);
    expect(s.recolors).toEqual([]);
    expect(s.textureEdits).toEqual([]);
    expect(isEmptyStyle(s)).toBe(false);
  });

  it('keeps valid sleeve / leg colors only', () => {
    expect(sanitizeStyle({ bodyPaint: { sleeves: '#1C1D22', legs: 'black' } }, outfit).bodyPaint).toEqual({ sleeves: '#1c1d22' });
    expect(sanitizeStyle({ bodyPaint: {} }, outfit).bodyPaint).toBeUndefined();
  });

  it('tells the designer what the base looks like', () => {
    const req = parseDesignRequest({ prompt: 'p', baseModel: 'b', materials: outfit, mode: 'transcribe', references: [img], baseTraits: '白い半袖シャツ、ネクタイ' });
    const text = designParts(req)[0]!.text!;
    expect(text).toContain('# 素体の見た目\n白い半袖シャツ、ネクタイ');
    expect(text).toContain('hide:');
    expect(text).toContain('bodyPaint:');
  });
});
