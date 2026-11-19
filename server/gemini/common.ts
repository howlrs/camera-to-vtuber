import type { ImagePayload } from '../../shared/protocol.ts';
import { HttpError } from './client.ts';
import { requireModel } from './registry.ts';
import { getAI } from './client.ts';
import type { ThinkingConfig, GenerateContentConfig, GenerateContentResponse, Part } from '@google/genai';
import type { ModelRole } from '../../shared/protocol.ts';

export function str(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function parseImage(v: unknown, field = 'image', required = true): ImagePayload | undefined {
  if (v == null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.data !== 'string' || !o.data || typeof o.mimeType !== 'string' || !/^image\/(jpeg|png|webp)$/.test(o.mimeType)) {
    throw new HttpError(400, `${field} must be {data: base64, mimeType: image/jpeg|png|webp}`);
  }
  return { data: o.data, mimeType: o.mimeType };
}

export function imagePart(img: ImagePayload): Part {
  return { inlineData: { data: img.data, mimeType: img.mimeType } };
}

/** Extract and parse JSON from model text (tolerates code fences). Returns null on failure. */
export function parseJsonText(text: string | undefined): unknown {
  if (!text) return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/[\[{][\s\S]*[\]}]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function clamp(n: unknown, min: number, max: number, fallback = min): number {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, x));
}

export function pickEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function hexColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = v.trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `#${m[1]!.toLowerCase()}` : undefined;
}

const thinkingRung = new Map<string, number>();

/** Config keys that may be rejected by a given model; dropped one by one on 400 errors. */
const OPTIONAL_KEYS = ['thinkingConfig', 'imageConfig', 'responseJsonSchema', 'responseSchema', 'mediaResolution'] as const;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isInvalidArgument(e: unknown): boolean {
  const m = errorText(e);
  return /"code":\s*400|INVALID_ARGUMENT|\b400\b/.test(m);
}

/**
 * generateContent that degrades gracefully: when the model rejects an optional config
 * field (thinking, imageConfig, schema) the call is retried without it.
 */
export async function generate(
  role: ModelRole,
  contents: Part[],
  config: GenerateContentConfig,
  /** Thinking settings to try in order (lowest first); the one a model accepts is remembered. */
  thinkingLadder?: ThinkingConfig[],
): Promise<{ response: GenerateContentResponse; model: string }> {
  const model = requireModel(role);
  const ai = getAI();
  const cfg: Record<string, unknown> = { ...config };
  const dropped = new Set<string>();
  let rung = thinkingLadder ? (thinkingRung.get(model) ?? 0) : 0;
  if (thinkingLadder) {
    if (rung < thinkingLadder.length) cfg.thinkingConfig = thinkingLadder[rung];
    else delete cfg.thinkingConfig;
  }
  for (;;) {
    try {
      const response = await ai.models.generateContent({ model, contents: [{ role: 'user', parts: contents }], config: cfg as GenerateContentConfig });
      if (thinkingLadder) thinkingRung.set(model, rung);
      return { response, model };
    } catch (e) {
      if (thinkingLadder && isInvalidArgument(e) && 'thinkingConfig' in cfg && rung < thinkingLadder.length) {
        rung++;
        if (rung < thinkingLadder.length) cfg.thinkingConfig = thinkingLadder[rung];
        else delete cfg.thinkingConfig;
        continue;
      }
      const next = isInvalidArgument(e) ? OPTIONAL_KEYS.find((k) => k in cfg && !dropped.has(k)) : undefined;
      if (!next) throw mapGeminiError(e);
      dropped.add(next);
      delete cfg[next];
    }
  }
}

export function mapGeminiError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const msg = errorText(e);
  const status = /"code":\s*(\d{3})/.exec(msg)?.[1] ?? /\bstatus[": ]+(\d{3})/.exec(msg)?.[1];
  const s = status ? Number(status) : 502;
  return new HttpError(s === 429 ? 429 : s >= 400 && s < 500 ? 502 : 502, msg.slice(0, 600));
}

export function firstImage(res: GenerateContentResponse): ImagePayload | null {
  for (const p of res.candidates?.[0]?.content?.parts ?? []) {
    if (p.inlineData?.data && p.inlineData.mimeType?.startsWith('image/')) {
      return { data: p.inlineData.data, mimeType: p.inlineData.mimeType };
    }
  }
  return null;
}
