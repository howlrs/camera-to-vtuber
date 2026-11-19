import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './gemini/client.ts';
import { readJson, sendJson, type RouteHandler } from './http.ts';

/**
 * POST /api/diag — development diagnostics. The client posts numeric tracking summaries
 * (no images); each is appended as one JSON line to logs/diag.jsonl (or VTUBER_DIAG_FILE).
 * Disabled in production unless VTUBER_DIAG=1.
 */
const file = process.env.VTUBER_DIAG_FILE ?? resolve(fileURLToPath(new URL('..', import.meta.url)), 'logs/diag.jsonl');
const enabled = process.env.NODE_ENV !== 'production' || process.env.VTUBER_DIAG === '1';
let dirReady: Promise<unknown> | null = null;

export const diagHandler: RouteHandler = async (req, res) => {
  if (!enabled) throw new HttpError(404, 'Diagnostics disabled');
  const body = await readJson(req, 256 * 1024);
  dirReady ??= mkdir(dirname(file), { recursive: true });
  await dirReady;
  await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...(body as object) }) + '\n');
  sendJson(res, 200, { ok: true });
};
