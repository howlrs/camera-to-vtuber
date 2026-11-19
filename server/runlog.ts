import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './gemini/client.ts';
import { readJson, sendJson, type RouteHandler } from './http.ts';

/**
 * Development run logs under logs/ (no images): one JSON line per Gemini call (gemini.jsonl) and
 * per transcription / design run reported by the client (transcribe.jsonl). Like the tracking
 * diagnostics, they are off in production unless VTUBER_DIAG=1.
 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)), 'logs');
export const logsEnabled = process.env.NODE_ENV !== 'production' || process.env.VTUBER_DIAG === '1';
let dirReady: Promise<unknown> | null = null;

export async function appendLog(name: 'gemini' | 'transcribe', record: object): Promise<void> {
  if (!logsEnabled) return;
  dirReady ??= mkdir(root, { recursive: true });
  await dirReady;
  await appendFile(resolve(root, `${name}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
}

/** POST /api/log — a RunLog from the client (spec and step outcomes of one run). */
export const runLogHandler: RouteHandler = async (req, res) => {
  if (!logsEnabled) throw new HttpError(404, 'Run logs disabled');
  const body = (await readJson(req, 256 * 1024)) as Record<string, unknown>;
  if (body.kind !== 'transcribe' && body.kind !== 'design') throw new HttpError(400, 'kind must be transcribe or design');
  await appendLog('transcribe', body);
  const steps = Array.isArray(body.steps) ? body.steps.map((s: any) => `${s?.id}:${s?.state}`).join(' ') : '';
  console.log(`[run] ${body.kind} ${body.ok ? 'ok' : 'failed'} ${body.seconds}s base=${body.base} ${steps}`);
  sendJson(res, 200, { ok: true });
};
