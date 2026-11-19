import { MAX_REFERENCES, type BaseCandidate, type ImagePayload, type TranscribeRequest, type TranscribeResponse } from '../../shared/protocol.ts';
import { HttpError } from './client.ts';
import { generate, imagePart, parseImage, parseJsonText, str } from './common.ts';
import { jsonPost } from '../http.ts';
import type { Part } from '@google/genai';

const MAX_CANDIDATES = 8;

export function parseTranscribeRequest(body: Record<string, unknown>): TranscribeRequest {
  const refs = body.references;
  if (!Array.isArray(refs) || refs.length === 0) throw new HttpError(400, 'references must be a non-empty array');
  if (refs.length > MAX_REFERENCES) throw new HttpError(400, `references accepts at most ${MAX_REFERENCES} images`);
  const references: ImagePayload[] = refs.map((r, i) => parseImage(r, `references[${i}]`)!);
  const candidates: BaseCandidate[] = (Array.isArray(body.candidates) ? body.candidates : [])
    .slice(0, MAX_CANDIDATES)
    .map((c: any) => ({ id: str(c?.id, 60).trim(), traits: str(c?.traits, 600).trim() }))
    .filter((c) => c.id);
  if (!candidates.length) throw new HttpError(400, 'candidates must contain at least one base model');
  if (new Set(candidates.map((c) => c.id)).size !== candidates.length) throw new HttpError(400, 'candidate ids must be unique');
  return { references, notes: str(body.notes, 2000).trim(), candidates };
}

export function transcribeSchema(ids: string[]) {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'キャラクターの一行説明' },
      brief: { type: 'string', description: 'モデル化に使う詳細な外見の仕様' },
      baseModel: { type: 'string', enum: ids },
      reason: { type: 'string' },
    },
    required: ['summary', 'brief', 'baseModel', 'reason'],
  };
}

export function buildTranscribePrompt(req: TranscribeRequest): string {
  const list = req.candidates.map((c) => `- ${c.id}: ${c.traits}`).join('\n');
  return `あなたは VRoid 系 3D モデルのモデラーです。添付の画像は、同じ 1 人のキャラクターの立ち絵・三面図・設定画・スクリーンショットなどです。
このキャラクターを、手持ちの素体 VRM を着せ替えて書き起こします。素体のメッシュ(髪型・服の形・体型)は変えられず、色・テクスチャ・小物だけを変えられます。

1. 画像を突き合わせて、モデル化に必要な外見を brief に書き出してください。
   - 髪: 色(#rrggbb、毛先や内側の色が違えばそれも)、長さ、前髪、まとめ方(ポニーテール・ツインテールなど)、メッシュやグラデーション
   - 目: 虹彩の色(#rrggbb)、瞳孔、ハイライトの色。眉とまつげの色
   - 肌の色(#rrggbb)
   - 服: パーツごと(上着・シャツ・襟・袖・スカートやズボン・靴下・靴)の色(#rrggbb)、柄、ライン、切り替え、ボタンなどの装飾
   - 小物: 耳、角、輪、リボン、髪飾り、眼鏡、ヘッドホン、帽子など(色も)
   - 雰囲気と性格の手がかり(表情、ポーズ)
   画像で見えない部分は推測と明記してください。文字やロゴは書き写さず「ロゴあり」とだけ書きます。
2. 次の候補から、形がいちばん近い素体を baseModel に選び、reason に理由を書いてください。
   髪の長さとシルエットを最優先し、次に体格(性別の印象)、服の形(袖・裾の長さ)を見ます。色の違いは後で直せるので考慮しません。
${list}
3. summary にキャラクターの一行説明を書いてください。
${req.notes ? `\n# ユーザーの補足\n${req.notes}` : ''}`;
}

export function sanitizeTranscription(raw: unknown, req: TranscribeRequest): Omit<TranscribeResponse, 'model'> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ids = req.candidates.map((c) => c.id);
  const baseModel = typeof r.baseModel === 'string' && ids.includes(r.baseModel) ? r.baseModel : ids[0]!;
  const brief = str(r.brief, 6000).trim();
  if (!brief) throw new HttpError(502, 'Transcriber returned no description of the character');
  return { baseModel, reason: str(r.reason, 600).trim(), summary: str(r.summary, 200).trim(), brief };
}

export const transcribeHandler = jsonPost(async (body): Promise<TranscribeResponse> => {
  const req = parseTranscribeRequest(body);
  const parts: Part[] = [{ text: buildTranscribePrompt(req) }];
  req.references.forEach((img, i) => parts.push({ text: `画像 ${i + 1}:` }, imagePart(img)));
  const { response, model } = await generate('transcriber', parts, {
    responseMimeType: 'application/json',
    responseJsonSchema: transcribeSchema(req.candidates.map((c) => c.id)),
    temperature: 0.3,
  });
  const raw = parseJsonText(response.text);
  if (!raw) throw new HttpError(502, 'Transcriber returned no parseable JSON');
  return { ...sanitizeTranscription(raw, req), model };
});
