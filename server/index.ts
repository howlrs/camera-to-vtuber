/**
 * VTuber server: one Node process serving the app (Vite middleware in dev, dist/ in production),
 * the Gemini-backed HTTP API and the Live WebSocket relay. GEMINI_API_KEY stays on this side.
 *
 * Extension point: add a new feature/role by writing a module under server/gemini/ that exports a
 * `RouteHandler` (see `jsonPost` in server/http.ts), then register it in `API_ROUTES` below. New
 * model roles only need an entry in config/models.json (and `ModelRole` in shared/protocol.ts).
 * WebSocket endpoints go in `WS_ROUTES` (path -> connection handler).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { HttpError } from './gemini/client.ts';
import { mapGeminiError } from './gemini/common.ts';
import { designHandler } from './gemini/designer.ts';
import { backgroundHandler, conceptHandler, textureHandler } from './gemini/imagery.ts';
import { handleLiveSocket } from './gemini/live.ts';
import { reactHandler } from './gemini/reactor.ts';
import { initRegistry, modelsHandler } from './gemini/registry.ts';
import { spatialHandler } from './gemini/spatial.ts';
import { transcribeHandler } from './gemini/transcribe.ts';
import { ttsHandler } from './gemini/tts.ts';
import { diagHandler } from './diag.ts';
import { runLogHandler } from './runlog.ts';
import { sendJson, type RouteHandler } from './http.ts';

const API_ROUTES: Record<string, { method: 'GET' | 'POST'; handler: RouteHandler }> = {
  '/api/models': { method: 'GET', handler: modelsHandler },
  '/api/design': { method: 'POST', handler: designHandler },
  '/api/transcribe': { method: 'POST', handler: transcribeHandler },
  '/api/texture': { method: 'POST', handler: textureHandler },
  '/api/background': { method: 'POST', handler: backgroundHandler },
  '/api/concept': { method: 'POST', handler: conceptHandler },
  '/api/react': { method: 'POST', handler: reactHandler },
  '/api/spatial': { method: 'POST', handler: spatialHandler },
  '/api/tts': { method: 'POST', handler: ttsHandler },
  '/api/diag': { method: 'POST', handler: diagHandler },
  '/api/log': { method: 'POST', handler: runLogHandler },
};

const WS_ROUTES: Record<string, (ws: WebSocket) => void> = {
  '/ws/live': handleLiveSocket,
};

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const isProd = process.env.NODE_ENV === 'production';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8790);

/** Host names this server answers to. Blocks DNS-rebinding (attacker domain resolving to 127.0.0.1). */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', host, ...(process.env.ALLOWED_HOSTS ?? '').split(',').filter(Boolean)]);

/** Reject cross-site browser requests (CSRF / WebSocket hijacking / DNS rebinding against a localhost API). */
function sameOrigin(req: IncomingMessage): boolean {
  const hostHeader = req.headers.host ?? '';
  const hostname = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
  if (!ALLOWED_HOSTS.has(hostname)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.wasm': 'application/wasm', '.vrm': 'model/gltf-binary', '.glb': 'model/gltf-binary', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json',
};

function serveFile(res: ServerResponse, file: string): void {
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': statSync(file).size });
  createReadStream(file).pipe(res);
}

function createStaticHandler(dir: string) {
  return (req: IncomingMessage, res: ServerResponse, next: (e?: unknown) => void): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      return next();
    }
    const file = normalize(join(dir, pathname));
    if (!file.startsWith(dir)) return next();
    if (existsSync(file) && statSync(file).isFile()) return serveFile(res, file);
    const index = join(dir, 'index.html');
    if (!extname(pathname) && existsSync(index)) return serveFile(res, index);
    next();
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const route = API_ROUTES[pathname];
  try {
    if (!route) throw new HttpError(404, `Unknown API route ${pathname}`);
    if (req.method !== route.method) throw new HttpError(405, `Use ${route.method} for ${pathname}`);
    if (!sameOrigin(req)) throw new HttpError(403, 'Cross-origin request rejected');
    await route.handler(req, res);
  } catch (e) {
    const err = e instanceof HttpError ? e : mapGeminiError(e);
    if (err.status >= 500) console.error(`[api] ${pathname}: ${err.message}`);
    if (!res.headersSent) sendJson(res, err.status, { error: err.message });
    else res.end();
  }
}

async function main(): Promise<void> {
  await initRegistry();

  const server: Server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  type Middleware = (req: IncomingMessage, res: ServerResponse, next: (e?: unknown) => void) => void;
  let viteMiddleware: Middleware | null = null;
  let closeVite: (() => Promise<void>) | null = null;
  if (!isProd) {
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({ root, appType: 'spa', server: { middlewareMode: true, hmr: { server } } });
    viteMiddleware = vite.middlewares as unknown as Middleware;
    closeVite = () => vite.close();
  }
  const staticHandler = isProd ? createStaticHandler(join(root, 'dist')) : null;

  server.on('request', (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (pathname.startsWith('/api/')) {
      void handleApi(req, res, pathname);
      return;
    }
    const fallback = (e?: unknown) => {
      if (res.headersSent) return res.end();
      if (e) {
        console.error('[server]', e instanceof Error ? e.message : e);
        return sendJson(res, 500, { error: e instanceof Error ? e.message : 'Internal error' });
      }
      sendJson(res, 404, { error: 'Not found' });
    };
    if (viteMiddleware) viteMiddleware(req, res, fallback);
    else staticHandler!(req, res, fallback);
  });

  // Only claim /ws/* paths we own; everything else (Vite HMR) is handled by Vite's own listener.
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const handler = WS_ROUTES[pathname];
    if (!handler) return;
    if (!sameOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handler(ws));
  });

  server.listen(port, host, () => {
    console.log(`[server] http://${host}:${port} (${isProd ? 'production' : 'dev, Vite middleware'})`);
  });

  const shutdown = () => {
    wss.clients.forEach((c) => c.close());
    void closeVite?.().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[server] fatal', e);
  process.exit(1);
});
