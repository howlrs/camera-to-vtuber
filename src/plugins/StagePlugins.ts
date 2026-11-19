import type { App, Plugin } from '../core/App.ts';
import { base64ToInt16 } from '../audio/Audio.ts';
import { payloadToDataUrl } from '../capture/FrameSource.ts';
import { el, toast } from '../ui/Panel.ts';
import { modelFor } from './ModelsPlugin.ts';

/** Stage backgrounds from Nano Banana; also serves `set_scene` tool calls from Gemini Live. */
export class BackgroundPlugin implements Plugin {
  readonly id = 'background';
  private app!: App;
  private busy = false;

  setup(app: App): void {
    this.app = app;
    const s = app.panel.section('背景生成', 'Nano Banana', false);
    const prompt = s.textarea('背景の説明（例: 夕暮れの屋上、柔らかい逆光）', '', 2);
    s.row(s.button('背景を生成', () => this.generate(prompt.value), 'primary'));
    app.bus.on('ai:scene', (e) => void this.generate(e.prompt).catch((err) => toast(`背景生成に失敗: ${err.message}`, 'warn')));
  }

  async generate(prompt: string): Promise<void> {
    if (!prompt.trim()) throw new Error('説明を入力してください');
    if (!modelFor(this.app, 'imageFast')) throw new Error('背景生成モデルが利用できません');
    if (this.busy) return;
    this.busy = true;
    this.app.bus.emit('status', { key: 'bg', text: '背景を生成中…' });
    try {
      const res = await this.app.api.background({ prompt });
      await this.app.stage.setBackgroundImage(payloadToDataUrl(res.image));
    } finally {
      this.busy = false;
      this.app.bus.emit('status', { key: 'bg', text: '' });
    }
  }
}

/** Typed lines spoken in the persona's voice (Gemini TTS) with lip-sync. */
export class VoicePlugin implements Plugin {
  readonly id = 'voice';

  setup(app: App): void {
    const s = app.panel.section('アバターの声', 'Gemini TTS + 口パク', false);
    const text = s.textarea('アバターに話させるセリフ', 'こんにちは！今日も配信に来てくれてありがとう！', 2);
    s.row(
      s.button(
        '話す',
        async () => {
          if (!modelFor(app, 'tts')) throw new Error('音声合成モデルが利用できません');
          await app.voice.player.resume();
          const persona = app.style?.persona;
          const res = await app.api.tts({ text: text.value, voice: persona?.voice, style: persona?.speakingStyle });
          app.voice.player.enqueue(base64ToInt16(res.audio), res.sampleRate);
          app.bus.emit('ai:caption', { text: text.value, source: 'tts' });
        },
        'primary',
      ),
      s.button('止める', () => app.voice.player.interrupt()),
    );
  }
}

/** Caption bubble + HUD (fps, per-tracker latency, status messages). */
export class OverlayPlugin implements Plugin {
  readonly id = 'overlay';
  private caption = document.getElementById('caption')!;
  private hud = document.getElementById('hud')!;
  private statuses = new Map<string, string>();
  private hideTimer = 0;
  private hudTimer = 0;

  setup(app: App): void {
    app.bus.on('ai:caption', ({ text }) => {
      this.caption.textContent = text;
      this.caption.hidden = !text;
      clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => (this.caption.hidden = true), 3500 + text.length * 120);
    });
    app.bus.on('status', ({ key, text }) => {
      if (text) this.statuses.set(key, text);
      else this.statuses.delete(key);
      this.renderHud(app);
    });
    this.hudTimer = window.setInterval(() => this.renderHud(app), 500);

    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('broadcast');
    });
  }

  private renderHud(app: App): void {
    const { fps, timings, delegate } = app.stats;
    const t = Object.entries(timings)
      .map(([k, v]) => `${k} ${v.toFixed(1)}ms`)
      .join('  ');
    const lines = [`${fps.toFixed(0)} fps  ${delegate}${t ? '  ' + t : ''}`, ...this.statuses.values()];
    this.hud.replaceChildren(...lines.map((l) => el('div', { text: l })));
  }

  dispose(): void {
    clearInterval(this.hudTimer);
  }
}
