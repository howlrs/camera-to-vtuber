import type { App, Plugin } from '../core/App.ts';
import { grabFrame } from '../capture/FrameSource.ts';
import { el } from '../ui/Panel.ts';
import { modelFor } from './ModelsPlugin.ts';

/**
 * Low-latency polling director (Flash-Lite with minimal thinking): every few seconds a frame is
 * classified into emotion / gesture / caption. Cheaper than Live and needs no microphone.
 */
export class ReactorPlugin implements Plugin {
  readonly id = 'reactor';
  private app!: App;
  private enabled = false;
  private intervalSec = 2;
  private timer = 0;
  private inFlight = false;
  private captions = false;
  private transcript = '';
  private out!: HTMLElement;

  setup(app: App): void {
    this.app = app;
    const s = app.panel.section('表情リアクター', 'Flash-Lite で数秒ごとに推定', false);
    s.toggle('自動推定を有効にする', this.enabled, (v) => {
      this.enabled = v;
      if (v) this.schedule(0);
      else clearTimeout(this.timer);
    });
    s.toggle('字幕の提案も表示する', this.captions, (v) => (this.captions = v));
    s.range('間隔（秒）', 1, 10, 0.5, this.intervalSec, (v) => (this.intervalSec = v));
    this.out = el('p', { class: 'hint mono', text: '—' });
    s.body.append(this.out);
    app.bus.on('ai:transcript', (t) => {
      if (t.role === 'user') this.transcript = (this.transcript + t.text).slice(-200);
    });
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.enabled) return;
    const src = this.app.source;
    if (src?.active && !this.inFlight && modelFor(this.app, 'reactor')) {
      const frame = grabFrame(src, 512, 0.7);
      if (frame) {
        this.inFlight = true;
        try {
          const r = await this.app.api.react({ frame, transcript: this.transcript || undefined });
          this.transcript = '';
          this.app.bus.emit('ai:expression', {
            emotion: r.emotion,
            intensity: r.intensity,
            durationSec: this.intervalSec * 1.6,
            source: 'reactor',
          });
          if (r.gesture !== 'none') this.app.bus.emit('ai:gesture', { gesture: r.gesture, source: 'reactor' });
          if (this.captions && r.caption) this.app.bus.emit('ai:caption', { text: r.caption, source: 'reactor' });
          this.out.textContent = `${r.emotion} ${r.intensity.toFixed(2)} / ${r.gesture} / ${r.latencyMs} ms (${r.model})`;
        } catch (err) {
          this.out.textContent = `エラー: ${(err as Error).message}`;
        } finally {
          this.inFlight = false;
        }
      }
    }
    this.schedule(this.intervalSec * 1000);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
