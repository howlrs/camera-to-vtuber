import type {
  BackgroundRequest,
  ConceptRequest,
  DesignRequest,
  AvatarStyle,
  ImageResponse,
  ModelsResponse,
  ReactRequest,
  ReactResponse,
  SpatialRequest,
  SpatialResponse,
  TextureRequest,
  TtsRequest,
  TtsResponse,
} from '../../shared/protocol.ts';

/** Typed wrappers for the server's Gemini endpoints (the API key never reaches the browser). */
export class ApiClient {
  constructor(private readonly base = '') {}

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    return json as T;
  }

  async models(): Promise<ModelsResponse> {
    const res = await fetch(`${this.base}/api/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  design(req: DesignRequest, signal?: AbortSignal) {
    return this.post<AvatarStyle>('/api/design', req, signal);
  }
  texture(req: TextureRequest, signal?: AbortSignal) {
    return this.post<ImageResponse>('/api/texture', req, signal);
  }
  background(req: BackgroundRequest, signal?: AbortSignal) {
    return this.post<ImageResponse>('/api/background', req, signal);
  }
  concept(req: ConceptRequest, signal?: AbortSignal) {
    return this.post<ImageResponse>('/api/concept', req, signal);
  }
  react(req: ReactRequest, signal?: AbortSignal) {
    return this.post<ReactResponse>('/api/react', req, signal);
  }
  spatial(req: SpatialRequest, signal?: AbortSignal) {
    return this.post<SpatialResponse>('/api/spatial', req, signal);
  }
  tts(req: TtsRequest, signal?: AbortSignal) {
    return this.post<TtsResponse>('/api/tts', req, signal);
  }

  liveUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws/live`;
  }
}
