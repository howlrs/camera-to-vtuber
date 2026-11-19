import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './gemini/client.ts';

export const BODY_LIMIT = 25 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

export async function readJson(req: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) throw new HttpError(400, 'Empty request body');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/** Build a POST JSON route from a pure-ish `(body) => result` function. */
export function jsonPost(fn: (body: Record<string, unknown>) => Promise<unknown>): RouteHandler {
  return async (req, res) => {
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
    sendJson(res, 200, await fn(body as Record<string, unknown>));
  };
}
