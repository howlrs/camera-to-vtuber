import type { WebSocket } from 'ws';
import {
  EMOTIONS, GESTURES, VOICES,
  type LiveClientMessage, type LiveServerMessage, type LiveStartOptions, type LiveToolCall,
} from '../../shared/protocol.ts';
import { Modality, Type, type LiveConnectConfig, type LiveServerMessage as SdkLiveMessage, type Session } from '@google/genai';
import { getAI, HttpError } from './client.ts';
import { clamp, pickEnum, str } from './common.ts';
import { requireModel } from './registry.ts';

export function buildSystemInstruction(o: LiveStartOptions): string {
  const base = `あなたはVTuberの「相棒兼ディレクター」です。配信者(ユーザー)の声とカメラ映像をリアルタイムで見聞きしています。
日本語を中心に、ユーザーの言語に合わせて自然に短く話してください(1回の発話は1〜2文)。
ツールで演出を行います:
- set_expression: アバターの表情(${EMOTIONS.join('/')})と強さ(0〜1)
- play_gesture: ジェスチャー(${GESTURES.filter((g) => g !== 'none').join('/')})
- set_scene: 配信背景の雰囲気が変わるべき時だけ、背景の説明を渡す(頻繁に呼ばない)
- show_caption: 画面に出す短いテロップ(40文字以内)
会話の流れや映像の変化に合わせて、必要な時だけ控えめにツールを使ってください。`;
  const mode = o.speak
    ? ''
    : '\n\n重要: 音声で話してはいけません。応答は沈黙したまま、ツール呼び出しだけで演出してください。';
  const lang = o.language ? `\n言語: ${o.language}` : '';
  const persona = o.persona ? `\n\n# キャラクター設定\n${o.persona.slice(0, 2000)}` : '';
  return base + mode + lang + persona;
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: Type.OBJECT, properties, required }) as never;

export const liveTools = [
  {
    functionDeclarations: [
      {
        name: 'set_expression',
        description: 'Set the avatar facial expression.',
        parameters: obj(
          {
            emotion: { type: Type.STRING, enum: [...EMOTIONS] },
            intensity: { type: Type.NUMBER, description: '0..1' },
            durationSec: { type: Type.NUMBER, description: 'optional hold time in seconds' },
          },
          ['emotion', 'intensity'],
        ),
      },
      {
        name: 'play_gesture',
        description: 'Play a short body/head gesture.',
        parameters: obj({ gesture: { type: Type.STRING, enum: GESTURES.filter((g) => g !== 'none') } }, ['gesture']),
      },
      {
        name: 'set_scene',
        description: 'Change the stage background (describe the scene; no people or text).',
        parameters: obj({ prompt: { type: Type.STRING } }, ['prompt']),
      },
      {
        name: 'show_caption',
        description: 'Show a short on-screen caption (max 40 chars).',
        parameters: obj({ text: { type: Type.STRING } }, ['text']),
      },
    ],
  },
];

/** Validate a raw function call from the model into a LiveToolCall (null when invalid). */
export function validateToolCall(name: string | undefined, args: Record<string, unknown> | undefined): LiveToolCall | null {
  const a = args ?? {};
  switch (name) {
    case 'set_expression': {
      const emotion = pickEnum(a.emotion, EMOTIONS, '' as never);
      if (!emotion) return null;
      const call: LiveToolCall = { name, args: { emotion, intensity: clamp(a.intensity, 0, 1, 0.7) } };
      if (typeof a.durationSec === 'number') call.args.durationSec = clamp(a.durationSec, 0.2, 30, 3);
      return call;
    }
    case 'play_gesture': {
      const gesture = pickEnum(a.gesture, GESTURES, '' as never);
      return gesture ? { name, args: { gesture } } : null;
    }
    case 'set_scene': {
      const prompt = str(a.prompt, 500).trim();
      return prompt ? { name, args: { prompt } } : null;
    }
    case 'show_caption': {
      const text = Array.from(str(a.text, 400)).slice(0, 40).join('').trim();
      return text ? { name, args: { text } } : null;
    }
    default:
      return null;
  }
}

export function buildLiveConfig(o: LiveStartOptions, level: 0 | 1 | 2 = 0): LiveConnectConfig {
  const voice = pickEnum(o.voice, VOICES, 'Kore');
  const cfg: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    systemInstruction: buildSystemInstruction(o),
    tools: liveTools,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  // Optional extras are dropped on retry if the model rejects the setup message.
  if (level < 1) cfg.contextWindowCompression = { slidingWindow: {} };
  if (level < 2) cfg.sessionResumption = {};
  return cfg;
}

export interface LiveBridge {
  session: Session;
  model: string;
}

/**
 * Connect to the Live API, retrying with progressively simpler setup configs.
 * Rejects with the last error. `emit` receives already-translated client messages.
 */
export async function connectLive(
  options: LiveStartOptions,
  emit: (m: LiveServerMessage) => void,
  onClose: (reason: string) => void,
): Promise<LiveBridge> {
  const model = requireModel('live');
  const ai = getAI();
  let lastErr: unknown;
  // Attempt 0: full config. 1: no compression. 2: no compression/resumption.
  for (const level of [0, 1, 2] as const) {
    try {
      const session = await openSession(model, buildLiveConfig(options, level), emit, onClose, () => bridge);
      const bridge: LiveBridge = { session, model };
      return bridge;
    } catch (e) {
      lastErr = e;
      void ai; // keep client initialised (throws 503 above when key missing)
    }
  }
  throw new HttpError(502, `Live connect failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`.slice(0, 400));
}

function openSession(
  model: string,
  config: LiveConnectConfig,
  emit: (m: LiveServerMessage) => void,
  onClose: (reason: string) => void,
  getBridge: () => LiveBridge,
): Promise<Session> {
  return new Promise<Session>((resolve, reject) => {
    let opened = false;
    let closed = false;
    const finishClose = (reason: string) => {
      if (closed) return;
      closed = true;
      if (!opened) reject(new Error(reason));
      else onClose(reason);
    };
    getAI()
      .live.connect({
        model,
        config,
        callbacks: {
          onopen: () => {
            opened = true;
          },
          onmessage: (m) => {
            if (!opened) opened = true;
            handleServerMessage(m, emit, () => getBridge().session);
          },
          onerror: (e) => {
            const message = (e as { message?: string }).message ?? 'Live API error';
            if (opened) emit({ type: 'error', message });
            else finishClose(message);
          },
          onclose: (e) => finishClose(`${(e as { code?: number }).code ?? ''} ${(e as { reason?: string }).reason ?? ''}`.trim() || 'closed'),
        },
      })
      .then((s) => {
        // `opened` flips true in onopen; the setup is accepted once connect() resolves.
        opened = true;
        resolve(s);
      })
      .catch((e) => reject(e));
  });
}

function handleServerMessage(m: SdkLiveMessage, emit: (m: LiveServerMessage) => void, session: () => Session): void {
  const sc = m.serverContent;
  if (sc) {
    for (const p of sc.modelTurn?.parts ?? []) {
      if (p.inlineData?.data) emit({ type: 'audio', data: p.inlineData.data, sampleRate: 24000 });
    }
    if (sc.inputTranscription?.text) emit({ type: 'transcript', role: 'user', text: sc.inputTranscription.text });
    if (sc.outputTranscription?.text) emit({ type: 'transcript', role: 'model', text: sc.outputTranscription.text });
    if (sc.interrupted) emit({ type: 'interrupted' });
    if (sc.turnComplete) emit({ type: 'turnComplete' });
  }
  const calls = m.toolCall?.functionCalls;
  if (calls?.length) {
    const responses = [];
    for (const fc of calls) {
      const call = validateToolCall(fc.name, fc.args);
      if (call) emit({ type: 'tool', call });
      responses.push({ id: fc.id, name: fc.name, response: call ? { ok: true } : { ok: false, error: 'invalid call' } });
    }
    try {
      session().sendToolResponse({ functionResponses: responses });
    } catch {
      /* session already closed */
    }
  }
}

/** Attach the relay logic to one browser WebSocket on /ws/live. */
export function handleLiveSocket(ws: WebSocket): void {
  let bridge: LiveBridge | null = null;
  let starting = false;
  let done = false;

  const send = (m: LiveServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const shutdown = (reason: string, notify = true) => {
    if (done) return;
    done = true;
    try {
      bridge?.session.close();
    } catch {
      /* ignore */
    }
    bridge = null;
    if (notify) send({ type: 'closed', reason });
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  };

  ws.on('close', () => shutdown('client closed', false));
  ws.on('error', () => shutdown('client error', false));
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg: LiveClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as LiveClientMessage;
    } catch {
      send({ type: 'error', message: 'invalid JSON' });
      return;
    }
    void dispatch(msg);
  });

  async function dispatch(msg: LiveClientMessage): Promise<void> {
    switch (msg.type) {
      case 'start': {
        if (bridge || starting) return send({ type: 'error', message: 'already started' });
        starting = true;
        try {
          const o = msg.options ?? { speak: true };
          const b = await connectLive({ ...o, speak: o.speak !== false }, send, (reason) => shutdown(reason));
          if (done) {
            b.session.close();
            return;
          }
          bridge = b;
          send({ type: 'ready', model: b.model });
        } catch (e) {
          send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
          shutdown('connect failed');
        } finally {
          starting = false;
        }
        return;
      }
      case 'audio':
        if (bridge && typeof msg.data === 'string') bridge.session.sendRealtimeInput({ audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' } });
        return;
      case 'frame':
        if (bridge && typeof msg.data === 'string') {
          bridge.session.sendRealtimeInput({ video: { data: msg.data, mimeType: msg.mimeType === 'image/png' ? 'image/png' : 'image/jpeg' } });
        }
        return;
      case 'text':
        if (bridge && typeof msg.text === 'string' && msg.text.trim()) bridge.session.sendRealtimeInput({ text: msg.text.slice(0, 4000) });
        return;
      case 'stop':
        shutdown('stopped by client');
        return;
    }
  }
}
