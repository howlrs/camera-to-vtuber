import type { Box2D, Point2D, SpatialObject, SpatialResponse } from '../../shared/protocol.ts';
import { HttpError } from './client.ts';
import { generate, imagePart, parseImage, parseJsonText, pickEnum, str } from './common.ts';
import { jsonPost } from '../http.ts';
import { MINIMAL_THINKING } from './reactor.ts';

const FRAMINGS = ['face', 'upperBody', 'fullBody', 'none'] as const;
const KEYPOINT_LABELS = ['nose', 'left_shoulder', 'right_shoulder', 'left_wrist', 'right_wrist'] as const;

const pointSchema = { type: 'array', items: { type: 'integer' } };
const schema = {
  type: 'object',
  properties: {
    framing: { type: 'string', enum: [...FRAMINGS] },
    objects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          point: pointSchema,
          box: pointSchema,
          heldBy: { type: 'string', enum: ['left', 'right', 'none'] },
        },
        required: ['label', 'point', 'heldBy'],
      },
    },
    keypoints: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string', enum: [...KEYPOINT_LABELS] }, point: pointSchema },
        required: ['label', 'point'],
      },
    },
  },
  required: ['framing', 'objects', 'keypoints'],
};

function toPoint(v: unknown): Point2D | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const [y, x] = v as unknown[];
  if (typeof y !== 'number' || typeof x !== 'number' || !Number.isFinite(y) || !Number.isFinite(x)) return null;
  return [Math.round(Math.min(1000, Math.max(0, y))), Math.round(Math.min(1000, Math.max(0, x)))];
}

function toBox(v: unknown): Box2D | undefined {
  if (!Array.isArray(v) || v.length < 4 || !v.slice(0, 4).every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const c = (n: number) => Math.round(Math.min(1000, Math.max(0, n)));
  const [a, b, c2, d] = v as number[];
  const ymin = Math.min(c(a!), c(c2!)), ymax = Math.max(c(a!), c(c2!));
  const xmin = Math.min(c(b!), c(d!)), xmax = Math.max(c(b!), c(d!));
  return ymax > ymin && xmax > xmin ? [ymin, xmin, ymax, xmax] : undefined;
}

export function sanitizeSpatial(raw: unknown): Omit<SpatialResponse, 'model' | 'latencyMs'> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const objects: SpatialObject[] = [];
  for (const o of Array.isArray(r.objects) ? r.objects : []) {
    const box = toBox(o?.box);
    const point = toPoint(o?.point) ?? (box ? ([Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)] as Point2D) : null);
    const label = str(o?.label, 60).trim();
    if (!point || !label) continue;
    const obj: SpatialObject = { label, point, heldBy: pickEnum(o?.heldBy, ['left', 'right', 'none'] as const, 'none') };
    if (box) obj.box = box;
    objects.push(obj);
    if (objects.length >= 10) break;
  }
  const keypoints: { label: string; point: Point2D }[] = [];
  for (const k of Array.isArray(r.keypoints) ? r.keypoints : []) {
    const point = toPoint(k?.point);
    const label = str(k?.label, 40);
    if (point && label && keypoints.length < 12) keypoints.push({ label, point });
  }
  return { framing: pickEnum(r.framing, FRAMINGS, 'none'), objects, keypoints };
}

export const spatialPrompt = `カメラ画像(左右反転していない生の映像)を解析し、JSONで返してください。座標はすべて [y, x]、0〜1000の正規化(画像左上が[0,0])。
- framing: 人物の写り方。face(顔のみ)/upperBody(上半身)/fullBody(全身)/none(人物なし)。
- objects: 人物が手に持っている物体、または顔の近くにある小物(最大5個)。label は英語の短い名詞。point は物体の中心、box は [ymin,xmin,ymax,xmax]。
  heldBy は持っている人物自身の解剖学的な手: 画像では反転していないため、人物の右手は画像の左側に、左手は画像の右側に写る。持っていなければ none。
- keypoints: nose, left_shoulder, right_shoulder, left_wrist, right_wrist のうち見えているもの。left/right は人物自身の左右(画像左側に写る肩は right_shoulder)。`;

export const spatialHandler = jsonPost(async (body) => {
  const frame = parseImage(body.frame, 'frame')!;
  const t0 = performance.now();
  const { response, model } = await generate(
    'spatial',
    [{ text: spatialPrompt }, imagePart(frame)],
    { responseMimeType: 'application/json', responseJsonSchema: schema, temperature: 0 },
    MINIMAL_THINKING,
  );
  const latencyMs = Math.round(performance.now() - t0);
  const raw = parseJsonText(response.text);
  if (!raw) throw new HttpError(502, 'Spatial model returned no parseable JSON');
  return { ...sanitizeSpatial(raw), model, latencyMs } satisfies SpatialResponse;
});
