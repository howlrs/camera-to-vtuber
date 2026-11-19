import type { App, Plugin } from '../core/App.ts';
import { base64ToInt16, MicCapture } from '../audio/Audio.ts';
import { grabFrame } from '../capture/FrameSource.ts';
import { el, toast } from '../ui/Panel.ts';
import { modelFor } from './ModelsPlugin.ts';
import {
  VOICES,
  type LiveClientMessage,
  type LiveServerMessage,
  type VoiceName,
} from '../../shared/protocol.ts';

/**
 * Gemini Live (bidirectional streaming): mic audio (16 kHz PCM) + camera frames (~1 fps) go up;
 * the model directs the avatar through tool calls (expression, gesture, scene, caption) and can
 * answer as a voiced co-host whose audio drives the avatar's lip-sync.
 */
export class LiveDirectorPlugin implements Plugin {
  readonly id = 'live';
  private app!: App;
  private ws: WebSocket | null = null;
  private mic = new MicCapture();
  private frameTimer = 0;
  private speak = false;
  private voice: VoiceName = 'Kore';
  private fps = 1;
  private status!: HTMLElement;
  private btn!: HTMLButtonElement;
  private modelText = '';

  setup(app: App): void {
    this.app = app;
    const s = app.panel.section('Gemini Live 演出', 'マイク+カメラを常時ストリーミング');
    this.btn = s.button('Live 開始', () => (this.ws ? this.stop() : this.start()), 'primary');
    this.status = el('span', { class: 'hint', text: '停止中' });
    s.row(this.btn, this.status);
    s.toggle('AI が声で応答する（共演者モード）', this.speak, (v) => (this.speak = v));
    s.select('声', VOICES.map((v) => ({ value: v, label: v })), this.voice, (v) => (this.voice = v));
    s.range('映像送信 (fps)', 0.5, 2, 0.5, this.fps, (v) => {
      this.fps = v;
      if (this.ws) this.startFrames();
    });
    const input = el('input', { type: 'text', placeholder: 'テキストで話しかける…' });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        this.send({ type: 'text', text: input.value.trim() });
        input.value = '';
      }
    });
    s.row(input);
    s.text('話しかけ・表情・映像を見て、AI が表情やジェスチャー・背景・字幕をツール呼び出しで演出します。');
    app.bus.on('style', (style) => (this.voice = style.persona.voice));
  }

  private send(msg: LiveClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async start(): Promise<void> {
    if (!modelFor(this.app, 'live')) throw new Error('Live 対応モデルが利用できません');
    await this.app.voice.player.resume();
    const ws = new WebSocket(this.app.api.liveUrl());
    this.ws = ws;
    this.setStatus('接続中…');
    this.btn.textContent = 'Live 停止';
    ws.onopen = () => {
      const persona = this.app.style?.persona;
      this.send({
        type: 'start',
        options: {
          speak: this.speak,
          voice: this.voice,
          language: 'ja-JP',
          persona: persona ? `${persona.name}（${persona.tagline}）。性格: ${persona.personality}。話し方: ${persona.speakingStyle}` : undefined,
        },
      });
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data as string) as LiveServerMessage);
    ws.onclose = () => this.cleanup('切断されました');
    ws.onerror = () => toast('Live 接続でエラーが発生しました', 'error');
  }

  private async onReady(model: string): Promise<void> {
    this.setStatus(`接続中: ${model}`);
    try {
      this.mic.onChunk = (data) => this.send({ type: 'audio', data });
      await this.mic.start();
    } catch (err) {
      toast(`マイクを使えません（映像のみ送信）: ${(err as Error).message}`, 'warn');
    }
    this.startFrames();
  }

  private startFrames(): void {
    clearInterval(this.frameTimer);
    this.frameTimer = window.setInterval(() => {
      const src = this.app.source;
      if (!src?.active) return;
      const f = grabFrame(src, 768, 0.7);
      if (f) this.send({ type: 'frame', data: f.data, mimeType: f.mimeType });
    }, 1000 / this.fps);
  }

  private onMessage(msg: LiveServerMessage): void {
    const bus = this.app.bus;
    switch (msg.type) {
      case 'ready':
        void this.onReady(msg.model);
        break;
      case 'audio':
        if (this.speak) this.app.voice.player.enqueue(base64ToInt16(msg.data), msg.sampleRate);
        break;
      case 'transcript':
        bus.emit('ai:transcript', { role: msg.role, text: msg.text });
        if (msg.role === 'model' && this.speak) {
          this.modelText += msg.text;
          bus.emit('ai:caption', { text: this.modelText, source: 'live' });
        }
        break;
      case 'tool': {
        const c = msg.call;
        if (c.name === 'set_expression') {
          bus.emit('ai:expression', { emotion: c.args.emotion, intensity: c.args.intensity, durationSec: c.args.durationSec ?? 4, source: 'live' });
        } else if (c.name === 'play_gesture') {
          bus.emit('ai:gesture', { gesture: c.args.gesture, source: 'live' });
        } else if (c.name === 'set_scene') {
          bus.emit('ai:scene', { prompt: c.args.prompt, source: 'live' });
        } else if (c.name === 'show_caption') {
          bus.emit('ai:caption', { text: c.args.text, source: 'live' });
        }
        this.setStatus(`ツール: ${c.name}`);
        break;
      }
      case 'interrupted':
        this.app.voice.player.interrupt();
        this.modelText = '';
        break;
      case 'turnComplete':
        this.modelText = '';
        break;
      case 'error':
        toast(`Live: ${msg.message}`, 'error');
        break;
      case 'closed':
        this.cleanup(msg.reason || '終了しました');
        break;
    }
  }

  stop(): void {
    this.send({ type: 'stop' });
    this.ws?.close();
    this.cleanup('停止中');
  }

  private cleanup(reason: string): void {
    clearInterval(this.frameTimer);
    this.mic.stop();
    this.ws = null;
    this.btn.textContent = 'Live 開始';
    this.setStatus(reason);
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
  }

  dispose(): void {
    this.stop();
  }
}
