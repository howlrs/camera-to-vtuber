import { GoogleGenAI } from '@google/genai';

let instance: GoogleGenAI | null = null;

export function apiKeyConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

/** Lazily created SDK client. The key never leaves this process. */
export function getAI(): GoogleGenAI {
  if (instance) return instance;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new HttpError(503, 'GEMINI_API_KEY is not configured on the server');
  instance = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' }) // preview/new models are only served on v1beta;
  return instance;
}

/** Error carrying an HTTP status; the router turns it into `{error}` JSON. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
