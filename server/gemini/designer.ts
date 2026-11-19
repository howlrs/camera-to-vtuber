import {
  ACCESSORIES, EMOTIONS, FACE_PARTS, MAX_REFERENCES, VOICES, repaintMode,
  type AccessorySpec, type AtlasPreview, type AvatarStyle, type DesignMode, type DesignRequest, type ImagePayload,
  type MaterialInfo, type MaterialStyle, type TextureEdit, type TextureRecolor,
} from '../../shared/protocol.ts';
import type { Part } from '@google/genai';
import { HttpError } from './client.ts';
import { clamp, generate, hexColor, imagePart, parseImage, parseJsonText, pickEnum, str } from './common.ts';
import { jsonPost } from '../http.ts';

const BIAS_KEYS = EMOTIONS.filter((e) => e !== 'neutral') as Exclude<(typeof EMOTIONS)[number], 'neutral'>[];

const colorSchema = { type: 'string', description: '#rrggbb' };

export function designSchema(materialNames: string[]) {
  return {
    type: 'object',
    properties: {
      persona: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tagline: { type: 'string' },
          personality: { type: 'string' },
          voice: { type: 'string', enum: [...VOICES] },
          speakingStyle: { type: 'string' },
        },
        required: ['name', 'tagline', 'personality', 'voice', 'speakingStyle'],
      },
      materials: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: materialNames },
            color: colorSchema,
            shadeColor: colorSchema,
            rimColor: colorSchema,
            emissive: colorSchema,
          },
          required: ['name', 'color'],
        },
      },
      recolors: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            material: { type: 'string', enum: materialNames },
            color: colorSchema,
            tipColor: colorSchema,
            tipStart: { type: 'number', description: '0 = top of the atlas, 1 = bottom' },
            leftEyeColor: { type: 'string', description: "irises only: the character's own left eye when it differs, #rrggbb" },
          },
          required: ['material', 'color'],
        },
      },
      textureEdits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { material: { type: 'string', enum: materialNames }, prompt: { type: 'string' } },
          required: ['material', 'prompt'],
        },
      },
      hide: {
        type: 'array',
        description: 'materials of the base that the character does not have (overlaid parts such as a necktie)',
        items: { type: 'string', enum: materialNames },
      },
      bodyPaint: {
        type: 'object',
        properties: { sleeves: colorSchema, legs: colorSchema },
      },
      accessories: {
        type: 'array',
        items: {
          type: 'object',
          properties: { type: { type: 'string', enum: [...ACCESSORIES] }, color: colorSchema },
          required: ['type', 'color'],
        },
      },
      expressionBias: {
        type: 'object',
        properties: Object.fromEntries(BIAS_KEYS.map((k) => [k, { type: 'number' }])),
        required: [...BIAS_KEYS],
      },
      stage: {
        type: 'object',
        properties: { backgroundPrompt: { type: 'string' }, lightColor: colorSchema, ambientColor: colorSchema },
        required: ['backgroundPrompt', 'lightColor', 'ambientColor'],
      },
    },
    required: ['persona', 'materials', 'recolors', 'textureEdits', 'accessories', 'expressionBias', 'stage'],
  };
}

/** Image-model edits per request: a free restyle needs few; a transcription repaints the outfit. */
export const MAX_TEXTURE_EDITS: Record<DesignMode, number> = { design: 3, transcribe: 8 };
const MAX_RECOLORS = 12;
const MAX_ATLASES = 24;

/** Validate/clamp raw model output into a safe AvatarStyle restricted to the supplied materials. */
export function sanitizeStyle(raw: unknown, materials: MaterialInfo[], mode: DesignMode = 'design'): AvatarStyle {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const byName = new Map(materials.map((m) => [m.name, m]));

  const p = (r.persona ?? {}) as Record<string, unknown>;
  const persona = {
    name: str(p.name, 40) || 'Aoi',
    tagline: str(p.tagline, 120),
    personality: str(p.personality, 600),
    voice: pickEnum(p.voice, VOICES, 'Kore'),
    speakingStyle: str(p.speakingStyle, 300),
  };

  const seen = new Set<string>();
  const mats: MaterialStyle[] = [];
  for (const m of Array.isArray(r.materials) ? r.materials : []) {
    const name = typeof m?.name === 'string' ? m.name : '';
    const info = byName.get(name);
    const color = hexColor(m?.color);
    if (!info || !color || seen.has(name)) continue;
    seen.add(name);
    const out: MaterialStyle = { name, color };
    for (const k of ['shadeColor', 'rimColor', 'emissive'] as const) {
      const c = hexColor(m[k]);
      if (c) out[k] = c;
    }
    mats.push(out);
  }

  const edits: TextureEdit[] = [];
  const editedMats = new Set<string>();
  for (const e of Array.isArray(r.textureEdits) ? r.textureEdits : []) {
    const material = typeof e?.material === 'string' ? e.material : '';
    const prompt = str(e?.prompt, 800).trim();
    const info = byName.get(material);
    if (!info || !repaintMode(info) || !prompt || editedMats.has(material)) continue;
    editedMats.add(material);
    edits.push({ material, prompt });
    if (edits.length >= MAX_TEXTURE_EDITS[mode]) break;
  }

  // A repaint already sets the colors, so a recolor of the same material is dropped, except for
  // redrawn line art (brows, lashes): it comes back gray and the recolor colors it.
  const recolors: TextureRecolor[] = [];
  for (const rc of Array.isArray(r.recolors) ? r.recolors : []) {
    const material = typeof rc?.material === 'string' ? rc.material : '';
    const color = hexColor(rc?.color);
    const info = byName.get(material);
    if (!info?.hasTexture || !color) continue;
    if (editedMats.has(material) && repaintMode(info) !== 'shape') continue;
    if (recolors.some((x) => x.material === material)) continue;
    const out: TextureRecolor = { material, color };
    const tipColor = hexColor(rc?.tipColor);
    if (tipColor && tipColor !== color) Object.assign(out, { tipColor, tipStart: clamp(rc?.tipStart, 0, 0.95, 0.5) });
    const separateEyes = info.part === 'iris' && (info.leftEye === 'left' || info.leftEye === 'right');
    const leftEyeColor = separateEyes ? hexColor(rc?.leftEyeColor) : undefined;
    if (leftEyeColor && leftEyeColor !== color) out.leftEyeColor = leftEyeColor;
    recolors.push(out);
    if (recolors.length >= MAX_RECOLORS) break;
  }

  // Only overlaid outfit parts may disappear; skin, hair and face parts would leave holes.
  const hide: string[] = [];
  for (const h of Array.isArray(r.hide) ? r.hide : []) {
    const info = typeof h === 'string' ? byName.get(h) : undefined;
    if (!info || (info.category !== 'CLOTH' && info.category !== 'OTHER') || info.part || hide.includes(info.name)) continue;
    hide.push(info.name);
    if (hide.length >= 6) break;
  }
  const hidden = new Set(hide);
  const keptEdits = edits.filter((e) => !hidden.has(e.material));
  const keptRecolors = recolors.filter((rc) => !hidden.has(rc.material));
  const bp = (r.bodyPaint ?? {}) as Record<string, unknown>;
  const bodyPaint = { sleeves: hexColor(bp.sleeves), legs: hexColor(bp.legs) };

  const accessories: AccessorySpec[] = [];
  for (const a of Array.isArray(r.accessories) ? r.accessories : []) {
    const type = pickEnum(a?.type, ACCESSORIES, '' as never);
    if (!type || accessories.some((x) => x.type === type)) continue;
    accessories.push({ type, color: hexColor(a?.color) ?? '#ffffff' });
    if (accessories.length >= 4) break;
  }

  const eb = (r.expressionBias ?? {}) as Record<string, unknown>;
  const expressionBias = Object.fromEntries(BIAS_KEYS.map((k) => [k, clamp(eb[k], 0, 0.3, 0)])) as AvatarStyle['expressionBias'];

  const s = (r.stage ?? {}) as Record<string, unknown>;
  const stage = {
    backgroundPrompt: str(s.backgroundPrompt, 500) || 'a soft pastel streaming room',
    lightColor: hexColor(s.lightColor) ?? '#ffffff',
    ambientColor: hexColor(s.ambientColor) ?? '#888899',
  };

  const style: AvatarStyle = { persona, materials: mats, recolors: keptRecolors, textureEdits: keptEdits, accessories, expressionBias, stage };
  if (hide.length) style.hide = hide;
  if (bodyPaint.sleeves || bodyPaint.legs) {
    style.bodyPaint = {};
    if (bodyPaint.sleeves) style.bodyPaint.sleeves = bodyPaint.sleeves;
    if (bodyPaint.legs) style.bodyPaint.legs = bodyPaint.legs;
  }
  return style;
}

function parseImages(v: unknown, field: string, max: number): ImagePayload[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `${field} must be an array`);
  if (v.length > max) throw new HttpError(400, `${field} accepts at most ${max} images`);
  return v.map((img, i) => parseImage(img, `${field}[${i}]`)!);
}

export function parseDesignRequest(body: Record<string, unknown>): DesignRequest {
  const prompt = str(body.prompt, 4000).trim();
  if (!prompt) throw new HttpError(400, 'prompt is required');
  if (!Array.isArray(body.materials) || body.materials.length === 0 || body.materials.length > 200) {
    throw new HttpError(400, 'materials must be a non-empty array');
  }
  const materials: MaterialInfo[] = body.materials.map((m: any) => {
    const info: MaterialInfo = {
      name: str(m?.name, 200),
      category: pickEnum(m?.category, ['SKIN', 'HAIR', 'CLOTH', 'EYE', 'FACE', 'OTHER'] as const, 'OTHER'),
      baseColor: hexColor(m?.baseColor) ?? '#ffffff',
      hasTexture: m?.hasTexture === true,
    };
    const part = pickEnum(m?.part, FACE_PARTS, '' as never);
    if (part) info.part = part;
    if (m?.drawnShape === true) info.drawnShape = true;
    if (part === 'iris' && (m?.leftEye === 'left' || m?.leftEye === 'right' || m?.leftEye === 'shared')) info.leftEye = m.leftEye;
    return info;
  }).filter((m) => m.name);
  if (!materials.length) throw new HttpError(400, 'materials must contain named entries');
  const mode = pickEnum(body.mode, ['design', 'transcribe'] as const, 'design');
  const references = parseImages(body.references, 'references', MAX_REFERENCES);
  if (mode === 'transcribe' && !references.length) throw new HttpError(400, 'references are required to transcribe');
  const known = new Set(materials.map((m) => m.name));
  const atlases: AtlasPreview[] = [];
  if (Array.isArray(body.atlases)) {
    for (const a of body.atlases.slice(0, MAX_ATLASES) as Record<string, unknown>[]) {
      const names = (Array.isArray(a?.materials) ? a.materials : []).map((n) => str(n, 200)).filter((n) => known.has(n));
      if (names.length) atlases.push({ materials: names.slice(0, 8), image: parseImage(a.image, 'atlases[].image')! });
    }
  }
  return {
    prompt,
    snapshot: parseImage(body.snapshot, 'snapshot', false),
    materials,
    baseModel: str(body.baseModel, 200),
    baseTraits: str(body.baseTraits, 600).trim() || undefined,
    mode,
    references,
    atlases,
  };
}

const PART_LABEL: Record<NonNullable<MaterialInfo['part']>, string> = {
  iris: '瞳の虹彩', highlight: '瞳のハイライト', eyeWhite: '白目', brow: '眉', lash: 'まつげ', line: 'アイライン', mouth: '口の中', face: '顔の肌',
};
const MODE_LABEL = { paint: '画像生成で描き換え可', shape: '画像生成で形も描き直し可', overlay: '画像生成で描き足し可' } as const;

function materialList(req: DesignRequest): string {
  return req.materials
    .map((m) => {
      const mode = repaintMode(m);
      const shape = m.part === 'brow' || m.part === 'lash' || m.part === 'line' ? (m.drawnShape ? '・形はテクスチャ' : '・形はメッシュ') : '';
      const eyes =
        m.part !== 'iris' || !m.leftEye
          ? ''
          : m.leftEye === 'shared'
            ? '・左右の目が同じ島を共有(左右で別の色や模様にはできない)'
            : `・縮小画像の${m.leftEye === 'left' ? '左' : '右'}の島がキャラクター自身の左目、${m.leftEye === 'left' ? '右' : '左'}の島が右目`;
      const part = m.part ? `, ${PART_LABEL[m.part]}${shape}${eyes}` : '';
      return `- ${m.name} (category ${m.category}${part}, base ${m.baseColor}, ${m.hasTexture ? 'has texture' : 'flat color, no texture'}, ${mode ? MODE_LABEL[mode] : '画像生成不可'})`;
    })
    .join('\n');
}

export function buildDesignPrompt(req: DesignRequest): string {
  if (req.mode === 'transcribe') return buildTranscribePrompt(req);
  return `あなたはVTuberのキャラクターデザイナー兼プロデューサーです。
ユーザーの要望から、読み込み済みのサンプルVRMアバター「${req.baseModel || 'sample'}」を着せ替える仕様をJSONで作ってください。
モデルの形状は変えられません。マテリアルの色、テクスチャ編集、アクセサリ、配信の雰囲気だけを変えます。

# 使えるマテリアル（name はこの一覧からのみ選ぶ）
${materialList(req)}

# ルール
- materials: 変更したいマテリアルだけ列挙。color はテクスチャに乗算される色(#rrggbb)。元の色を残すなら #ffffff。肌や目は大きく変えすぎない。
- recolors: hasTexture のマテリアルの色を塗り替えるとき(髪・瞳・肌の色など)。テクスチャの陰影はそのままで、主な色が color になる。画像生成を使わないので速く確実。髪の毛先の色を変えるなら tipColor(テクスチャの上端が根元、下端が毛先の縦グラデーション)と tipStart(0=上端〜1=下端)。
- textureEdits: 一覧で「画像生成で〜可」のマテリアルだけ、最大${MAX_TEXTURE_EDITS.design}件。柄や配色の変更に使う。髪・体の肌は recolors で。prompt は画像モデルへの短い指示(例: 「紺色のセーラー服風、白いライン」)。UV配置は別途保持されるので、配置には触れない。recolors と同じマテリアルは選ばない。
- accessories: ${ACCESSORIES.join(', ')} から0〜3個。
- expressionBias: 性格に合わせた感情の下駄(各0〜0.3)。
- persona.voice は ${VOICES.slice(0, 10).join(', ')} など指定の名前から選ぶ。speakingStyle は話し方の短い指示。
- stage.backgroundPrompt は人物や文字を含まない背景の説明。
- 色はすべて #rrggbb。
${req.snapshot ? '\n添付画像は雰囲気・配色の参考(本人の顔を再現する必要はない)。' : ''}
# ユーザーの要望
${req.prompt}`;
}

/** Faithful reproduction of a reference character on the loaded model (shape is fixed). */
export function buildTranscribePrompt(req: DesignRequest): string {
  const atlasNote = req.atlases?.length
    ? '各テクスチャの縮小画像を「テクスチャ: 名前」の見出しの直後に添付しています。マゼンタの部分はモデルが使っていない余白です。どの島(パーツ)に何が描かれているかを見て判断してください。'
    : 'テクスチャ画像は添付していません。';
  return `あなたは VRoid 系 3D モデルのモデラーです。参照画像のキャラクターを、読み込み済みの素体 VRM「${req.baseModel || 'base'}」の上に書き起こす仕様を JSON で作ってください。
素体のメッシュ(髪型・服の形・体型)は変えられません。マテリアルの色、テクスチャの色の置き換え、テクスチャの描き換え、小物で、見た目をできるだけ参照画像に近づけます。

${req.baseTraits ? `# 素体の見た目\n${req.baseTraits}\n\n` : ''}# 使えるマテリアル（name はこの一覧からのみ選ぶ）
${materialList(req)}

${atlasNote}

# ルール
- 参照画像の「同じキャラクター」を再現する。画像にない要素を足さない。画像が複数あれば、正面・背面・顔のアップなどを突き合わせて色を決める。
- recolors: 髪、瞳の虹彩(オッドアイは leftEyeColor も)、眉、まつげ、目のライン、単色の服や靴は recolors で塗り替える。元のテクスチャの陰影・毛束・模様の濃淡はそのまま残り、テクスチャの主な色(色の付いた部分の中央)が color になる。color は参照画像の、光も影も当たっていない中間の明るさの色。白目は塗り替えない。瞳のハイライトは、参照画像のハイライトに色が付いているときだけ塗り替える。
  - 毛先の色が違う髪(グラデーション)は tipColor に毛先の色、tipStart に色が変わり始める位置(0=テクスチャの上端〜1=下端)を入れる。テクスチャの上端を根元、下端を毛先として縦にグラデーションをかけるので、縮小画像が縦に流れる毛束や縦のグラデーションのテクスチャにだけ使う(後ろ髪の頭頂部のような形のテクスチャには使わない)。
  - 肌(SKIN)は、参照画像の肌が素体と明らかに違う(日焼け・褐色・人外の色など)ときだけ塗り替える。普通の肌色なら触らない。
- textureEdits: 一覧で「画像生成で〜可」のマテリアルだけ、最大${MAX_TEXTURE_EDITS.transcribe}件。recolors と同じマテリアルは選ばない(textureEdits の色は prompt に書く)。ただし眉・まつげ・アイラインの形の描き直しだけは、線がグレーで描かれるので、色を同じマテリアルの recolors に入れる。種類ごとの使い方:
  - 服・靴・小物(画像生成で描き換え可): 柄・ライン・切り替え・2 色以上の配色が必要な部分だけ。prompt には、縮小画像で見える島ごとに、どこを何色(#rrggbb)・どんな柄にするかを具体的に書く(例: 「襟の島は白 #ffffff に紺のライン 2 本、胴の島は紺 #1f2a44」)。島の形は変えられないので、形の違う服(短パンとスカートなど)は、今の形のまま色と柄だけ寄せる。キャラクターの絵や顔をテクスチャに描かせない。
  - 瞳の虹彩(画像生成で描き換え可): 参照画像の瞳に模様・グラデーション・瞳孔の形(縦長・星形など)・色の付いたハイライト・リングがあるときだけ。画像モデルには参照画像を渡さないので、prompt だけで描けるように、上下のグラデーションの色(#rrggbb)、瞳孔の形と色、ハイライトの形と色を具体的に書く。左右で違うなら、一覧に書いた島の位置(「縮小画像の左の島(キャラクターの左目)」など)を使って、両方の島をそれぞれ書く。左右で色が違うだけ(オッドアイ)なら、textureEdits ではなく recolors の color に右目、leftEyeColor に左目の色を入れる(確実)。一覧で「左右の目が同じ島を共有」の素体ではオッドアイにできないので、目立つ方の色を color にする。単色で十分なら recolors にする。
  - 眉・まつげ・アイライン(画像生成で形も描き直し可): 参照画像と太さ・形がはっきり違うときだけ(太い眉、長く跳ねたまつげ、跳ね上げたアイラインなど)。画像モデルには参照画像を渡さないので、prompt に太さ・形を具体的に書き、色は recolors に入れる。線は今の位置と長さのまま描き直される(島を塗りつぶすほど太くはできない)。「形はメッシュ」のものは色だけなので recolors を使う。
  - 顔の肌の描き足しも、画像モデルには参照画像を渡さないので、場所・形・大きさ・色を具体的に書く。
  - 顔の肌(画像生成で描き足し可): 参照画像に頬の赤み・そばかす・ほくろ・傷・フェイスペイント・ペイントの模様があるときだけ、描き足すものと場所(例: 「両頬に淡いピンク #f4a0a8 の楕円の赤み」)を書く。肌の色を変える目的には使わない。
- 素体の服・小物は、参照画像の同じ部位と必ず突き合わせる。素体のネクタイ・リボン・ベストなどが参照画像にもあるなら、色と柄を recolors か textureEdits で必ず合わせる。
- hide: 素体にあって参照画像のキャラクターにない部品(ネクタイ・リボン・バッジ・ベルトの飾りなど、服の上に重ねて付いていて、消しても体や服に穴が開かないもの)。シャツ・ズボン・ベスト・靴など体を覆う服は消さない(肌や穴が見える)。迷うなら消さずに色を合わせる。
- bodyPaint: 素体は袖や裾の形を変えられないので、肌が出ている腕・脚に服の色を塗って補う。参照画像が長袖で素体の腕が出ている(半袖・袖なし)なら sleeves に袖の色、参照画像が長ズボン・タイツで素体の脚が出ている(短パン・スカート)なら legs に色。素体がもともと長袖・長ズボンなら入れない。
- materials: recolors / textureEdits の対象外のマテリアルだけ。color はテクスチャに乗算する色。元のままなら #ffffff。テクスチャを持たないマテリアルの色合わせに使う。
- accessories: ${ACCESSORIES.join(', ')} のうち、参照画像に実際にある物に近いものだけ(なければ空配列)。color は画像の色。
- persona: name はユーザーの補足に名前があればそれ、なければ外見から付ける。personality と voice(${VOICES.slice(0, 10).join(', ')} など指定の名前) と speakingStyle は外見と補足から推測する。
- expressionBias: 性格に合わせた感情の下駄(各0〜0.3)。
- stage.backgroundPrompt は、このキャラクターに合う、人物や文字を含まない配信背景の説明。
- 色はすべて #rrggbb。

# キャラクターの分析とユーザーの補足
${req.prompt}`;
}

/** Text, then each reference and atlas preceded by its own label so the model can tell them apart. */
export function designParts(req: DesignRequest): Part[] {
  const parts: Part[] = [{ text: buildDesignPrompt(req) }];
  if (req.snapshot) parts.push(imagePart(req.snapshot));
  (req.references ?? []).forEach((img, i) => parts.push({ text: `参照画像 ${i + 1}:` }, imagePart(img)));
  for (const a of req.atlases ?? []) parts.push({ text: `テクスチャ: ${a.materials.join(', ')}` }, imagePart(a.image));
  return parts;
}

/** A style that changes nothing on the model (no colors, recolors, repaints or accessories). */
export function isEmptyStyle(s: AvatarStyle): boolean {
  return !s.materials.length && !s.recolors.length && !s.textureEdits.length && !s.accessories.length && !s.hide?.length && !s.bodyPaint;
}

export const designHandler = jsonPost(async (body) => {
  const req = parseDesignRequest(body);
  const parts = designParts(req);
  // Transcription is judged on color fidelity, so it runs on the transcriber role (Neon). The
  // model occasionally answers a transcription with an empty spec; one retry fixes it in practice.
  const attempts = req.mode === 'transcribe' ? 2 : 1;
  for (let attempt = 1; ; attempt++) {
    const { response } = await generate(req.mode === 'transcribe' ? 'transcriber' : 'designer', parts, {
      responseMimeType: 'application/json',
      responseJsonSchema: designSchema(req.materials.map((m) => m.name)),
      // A transcription should match the references, not invent.
      temperature: req.mode === 'transcribe' ? 0.4 : 0.9,
    });
    const raw = parseJsonText(response.text);
    if (!raw) throw new HttpError(502, 'Designer returned no parseable JSON');
    const style = sanitizeStyle(raw, req.materials, req.mode);
    if (req.mode !== 'transcribe' || !isEmptyStyle(style)) return style;
    console.warn(`[design] empty transcription spec (attempt ${attempt}/${attempts})`);
    if (attempt >= attempts) throw new HttpError(502, '書き起こしの仕様が空で返りました。もう一度お試しください');
  }
});
