import type { App, Plugin } from '../core/App.ts';
import type { AvatarRig } from '../avatar/AvatarRig.ts';
import { DEFAULT_HAIR_SETTINGS, type HairSettings } from '../avatar/HairPhysics.ts';
import { localStore } from './CapturePlugin.ts';

const HAIR_KEY = 'vtuber.hair';

/** Hair sway controls (spring-bone hair), remembered per browser and applied to every model. */
export class HairPlugin implements Plugin {
  readonly id = 'hair';
  private settings: HairSettings = { ...DEFAULT_HAIR_SETTINGS };
  private info!: HTMLElement;

  setup(app: App): void {
    try {
      const saved = JSON.parse(localStore.get(HAIR_KEY) ?? '{}') as Partial<HairSettings>;
      for (const k of ['sway', 'wind'] as const) if (Number.isFinite(saved[k])) this.settings[k] = saved[k]!;
    } catch {
      /* ignore a corrupt value */
    }

    const s = app.panel.section('髪の揺れ', 'スプリングボーン');
    s.range('揺れの大きさ', 0, 2, 0.1, this.settings.sway, (v) => this.set(app, { sway: v }));
    s.range('風', 0, 0.5, 0.05, this.settings.wind, (v) => this.set(app, { wind: v }));
    s.text('揺れの大きさを 0 にすると、モデルに設定された揺れ方のままになります。');
    this.info = s.text('', 'meta');

    app.bus.on('avatar', (a) => this.apply(a));
    if (app.avatar) this.apply(app.avatar);
  }

  private set(app: App, patch: Partial<HairSettings>): void {
    Object.assign(this.settings, patch);
    localStore.set(HAIR_KEY, JSON.stringify(this.settings));
    app.avatar?.hair?.configure(patch);
  }

  private apply(avatar: AvatarRig): void {
    const hair = avatar.hair;
    hair?.configure(this.settings);
    this.info.textContent = !hair
      ? 'このモデルには揺れ物（スプリングボーン）がありません'
      : hair.jointCount
        ? `髪の揺れ物ボーン: ${hair.jointCount} 個`
        : 'このモデルの揺れ物に髪は見つかりませんでした';
  }
}
