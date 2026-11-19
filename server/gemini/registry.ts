import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ModelAssignment, ModelRole, ModelsResponse } from '../../shared/protocol.ts';
import { apiKeyConfigured, getAI, HttpError } from './client.ts';
import { sendJson } from '../http.ts';

export interface RoleConfig {
  purpose: string;
  candidates: string[];
}
export interface ModelsConfig {
  roles: Record<string, RoleConfig>;
}

/**
 * Pure resolution: env override (VTUBER_MODEL_<ROLE>, case-insensitive role) wins, otherwise the
 * first candidate present in `available`. `available === null` means models.list was unavailable
 * (no key / network error): the first candidate is used unverified so the app can still try.
 */
export function resolveAssignments(
  config: ModelsConfig,
  available: ReadonlySet<string> | null,
  env: Record<string, string | undefined> = {},
): ModelAssignment[] {
  return Object.entries(config.roles).map(([role, rc]) => {
    const override = env[`VTUBER_MODEL_${role.toUpperCase()}`]?.trim().replace(/^models\//, '');
    if (override) {
      return { role: role as ModelRole, model: override, candidates: rc.candidates, purpose: rc.purpose, source: 'env' as const };
    }
    const model = available === null ? (rc.candidates[0] ?? null) : (rc.candidates.find((c) => available.has(c)) ?? null);
    return { role: role as ModelRole, model, candidates: rc.candidates, purpose: rc.purpose, source: 'config' as const };
  });
}

let assignments: ModelAssignment[] = [];
let listError: string | null = null;

export function loadConfig(): ModelsConfig {
  const url = new URL('../../config/models.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as ModelsConfig;
}

export async function listAvailableModels(): Promise<Set<string>> {
  const out = new Set<string>();
  const pager = await getAI().models.list({ config: { pageSize: 1000 } });
  for await (const m of pager) if (m.name) out.add(m.name.replace(/^models\//, ''));
  return out;
}

/** Call once at startup. Never throws. */
export async function initRegistry(): Promise<void> {
  const config = loadConfig();
  let available: Set<string> | null = null;
  if (apiKeyConfigured()) {
    try {
      available = await listAvailableModels();
    } catch (e) {
      listError = e instanceof Error ? e.message : String(e);
      console.warn(`[registry] models.list failed, using first candidates unverified: ${listError.slice(0, 200)}`);
    }
  }
  assignments = resolveAssignments(config, available, process.env);
}

export function getAssignments(): ModelAssignment[] {
  return assignments;
}

export function getModel(role: ModelRole): string | null {
  return assignments.find((a) => a.role === role)?.model ?? null;
}

export function requireModel(role: ModelRole): string {
  if (!apiKeyConfigured()) throw new HttpError(503, 'GEMINI_API_KEY is not configured on the server');
  const m = getModel(role);
  if (!m) throw new HttpError(503, `No available model for role "${role}"`);
  return m;
}

export function modelsHandler(_req: IncomingMessage, res: ServerResponse): void {
  const body: ModelsResponse = { assignments, apiKeyConfigured: apiKeyConfigured() };
  sendJson(res, 200, body);
}
