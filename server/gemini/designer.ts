import {
  ACCESSORIES, EMOTIONS, VOICES,
  type AccessorySpec, type AvatarStyle, type DesignRequest, type MaterialInfo, type MaterialStyle, type TextureEdit,
} from '../../shared/protocol.ts';
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
      textureEdits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { material: { type: 'string', enum: materialNames }, prompt: { type: 'string' } },
          required: ['material', 'prompt'],
        },
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
    required: ['persona', 'materials', 'textureEdits', 'accessories', 'expressionBias', 'stage'],
  };
}

const MAX_TEXTURE_EDITS = 3;

/** Validate/clamp raw model output into a safe AvatarStyle restricted to the supplied materials. */
export function sanitizeStyle(raw: unknown, materials: MaterialInfo[]): AvatarStyle {
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
    if (!byName.get(material)?.hasTexture || !prompt || editedMats.has(material)) continue;
    editedMats.add(material);
    edits.push({ material, prompt });
    if (edits.length >= MAX_TEXTURE_EDITS) break;
  }

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

  return { persona, materials: mats, textureEdits: edits, accessories, expressionBias, stage };
}

export function parseDesignRequest(body: Record<string, unknown>): DesignRequest {
  const prompt = str(body.prompt, 4000).trim();
  if (!prompt) throw new HttpError(400, 'prompt is required');
  if (!Array.isArray(body.materials) || body.materials.length === 0 || body.materials.length > 200) {
    throw new HttpError(400, 'materials must be a non-empty array');
  }
  const materials: MaterialInfo[] = body.materials.map((m: any) => ({
    name: str(m?.name, 200),
    category: pickEnum(m?.category, ['SKIN', 'HAIR', 'CLOTH', 'EYE', 'FACE', 'OTHER'] as const, 'OTHER'),
    baseColor: hexColor(m?.baseColor) ?? '#ffffff',
    hasTexture: m?.hasTexture === true,
  })).filter((m) => m.name);
  if (!materials.length) throw new HttpError(400, 'materials must contain named entries');
  return { prompt, snapshot: parseImage(body.snapshot, 'snapshot', false), materials, baseModel: str(body.baseModel, 200) };
}

export function buildDesignPrompt(req: DesignRequest): string {
  const list = req.materials
    .map((m) => `- ${m.name} (category ${m.category}, base ${m.baseColor}, ${m.hasTexture ? 'has texture' : 'flat color, no texture'})`)
    .join('\n');
  return `あなたはVTuberのキャラクターデザイナー兼プロデューサーです。
ユーザーの要望から、読み込み済みのサンプルVRMアバター「${req.baseModel || 'sample'}」を着せ替える仕様をJSONで作ってください。
モデルの形状は変えられません。マテリアルの色、テクスチャ編集、アクセサリ、配信の雰囲気だけを変えます。

# 使えるマテリアル（name はこの一覧からのみ選ぶ）
${list}

# ルール
- materials: 変更したいマテリアルだけ列挙。color はテクスチャに乗算される色(#rrggbb)。元の色を残すなら #ffffff。肌や目は大きく変えすぎない。
- textureEdits: hasTexture のマテリアルだけ、最大${MAX_TEXTURE_EDITS}件。prompt は画像モデルへの短い指示(例: 「紺色のセーラー服風、白いライン」)。UV配置は別途保持されるので、配置には触れない。
- accessories: ${ACCESSORIES.join(', ')} から0〜3個。
- expressionBias: 性格に合わせた感情の下駄(各0〜0.3)。
- persona.voice は ${VOICES.slice(0, 10).join(', ')} など指定の名前から選ぶ。speakingStyle は話し方の短い指示。
- stage.backgroundPrompt は人物や文字を含まない背景の説明。
- 色はすべて #rrggbb。
${req.snapshot ? '\n添付画像は雰囲気・配色の参考(本人の顔を再現する必要はない)。' : ''}
# ユーザーの要望
${req.prompt}`;
}

export const designHandler = jsonPost(async (body) => {
  const req = parseDesignRequest(body);
  const parts = [{ text: buildDesignPrompt(req) }, ...(req.snapshot ? [imagePart(req.snapshot)] : [])];
  const { response } = await generate('designer', parts, {
    responseMimeType: 'application/json',
    responseJsonSchema: designSchema(req.materials.map((m) => m.name)),
    temperature: 0.9,
  });
  const raw = parseJsonText(response.text);
  if (!raw) throw new HttpError(502, 'Designer returned no parseable JSON');
  return sanitizeStyle(raw, req.materials);
});
