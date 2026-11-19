import { EMOTIONS, GESTURES, type ReactRequest, type ReactResponse } from '../../shared/protocol.ts';
import { HttpError } from './client.ts';
import { clamp, generate, imagePart, parseImage, parseJsonText, pickEnum, str } from './common.ts';
import { jsonPost } from '../http.ts';

/** Lowest thinking first; the first rung the model accepts is cached (see generate()). */
export const MINIMAL_THINKING = [{ thinkingLevel: 'MINIMAL' }, { thinkingBudget: 0 }, { thinkingLevel: 'LOW' }] as never[];

const schema = {
  type: 'object',
  properties: {
    emotion: { type: 'string', enum: [...EMOTIONS] },
    intensity: { type: 'number' },
    gesture: { type: 'string', enum: [...GESTURES] },
    caption: { type: 'string' },
  },
  required: ['emotion', 'intensity', 'gesture', 'caption'],
};

export function sanitizeReaction(raw: unknown): Omit<ReactResponse, 'model' | 'latencyMs'> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    emotion: pickEnum(r.emotion, EMOTIONS, 'neutral'),
    intensity: clamp(r.intensity, 0, 1, 0),
    gesture: pickEnum(r.gesture, GESTURES, 'none'),
    caption: Array.from(str(r.caption, 400)).slice(0, 40).join(''),
  };
}

export function parseReactRequest(body: Record<string, unknown>): ReactRequest {
  return { frame: parseImage(body.frame, 'frame')!, transcript: str(body.transcript, 1000) || undefined };
}

export const reactHandler = jsonPost(async (body) => {
  const req = parseReactRequest(body);
  const prompt = `カメラ映像の人物の感情とジェスチャーを判定し、VTuberアバターに反映するためのJSONを返してください。
emotion: ${EMOTIONS.join('/')} から1つ。intensity: 0〜1。
gesture: ${GESTURES.join('/')} から1つ(うなずき=nod, 首を振る=shake, 手を振る=wave, 考え込む=thinking, 該当なし=none)。
caption: 配信テロップとして使える${40}文字以内の短い一言。不要なら空文字。${req.transcript ? `\n直近の発話: ${req.transcript}` : ''}`;
  const t0 = performance.now();
  const { response, model } = await generate(
    'reactor',
    [{ text: prompt }, imagePart(req.frame)],
    { responseMimeType: 'application/json', responseJsonSchema: schema, temperature: 0.2, maxOutputTokens: 200 },
    MINIMAL_THINKING,
  );
  const latencyMs = Math.round(performance.now() - t0);
  const raw = parseJsonText(response.text);
  if (!raw) throw new HttpError(502, 'Reactor returned no parseable JSON');
  return { ...sanitizeReaction(raw), model, latencyMs } satisfies ReactResponse;
});
