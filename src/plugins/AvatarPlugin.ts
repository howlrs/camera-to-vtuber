import type { App, Plugin } from '../core/App.ts';
import { VrmAvatar } from '../avatar/VrmAvatar.ts';
import type { BackgroundMode, Framing } from '../render/Stage.ts';
import { el, toast } from '../ui/Panel.ts';

/**
 * Sample avatars fetched by `npm run setup`: two VRM 1.0 samples from the VRM Consortium
 * specification repo and a male short-haired VRoid sample (VRM 0.x). All allow avatar use by
 * anyone, commercial use, modification and redistribution (see public/avatars/LICENSES.md).
 */
export const SAMPLE_AVATARS = [
  { id: 'twist', label: 'VRM1 Constraint Twist Sample（pixiv / VRoid構造）', url: '/avatars/VRM1_Constraint_Twist_Sample.vrm' },
  { id: 'seed', label: 'Seed-san（VirtualCast）', url: '/avatars/Seed-san.vrm' },
  { id: 'fumiriya', label: '桜田 史利矢（VRoid サンプル・男性・短髪 / VRM 0.x）', url: '/avatars/Sakurada_Fumiriya.vrm' },
] as const;

/** Avatar selection (samples or user .vrm), camera framing, background and license credit. */
export class AvatarPlugin implements Plugin {
  readonly id = 'avatar';
  private app!: App;
  private credit = document.getElementById('credit')!;
  private info!: HTMLElement;

  async setup(app: App): Promise<void> {
    this.app = app;
    const s = app.panel.section('3Dモデル', 'VRM サンプルを取り込み');
    s.select(
      'モデル',
      SAMPLE_AVATARS.map((a) => ({ value: a.id, label: a.label })),
      SAMPLE_AVATARS[0].id,
      (id) => void this.load(SAMPLE_AVATARS.find((a) => a.id === id)!.url),
    );
    const file = el('input', { type: 'file', accept: '.vrm', class: 'visually-hidden', id: 'vrm-file' });
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (f) void this.load(URL.createObjectURL(f), true);
    });
    s.row(el('label', { class: 'btn plain', for: 'vrm-file', text: '手持ちの .vrm を読み込む' }), file);
    this.info = s.text('', 'meta');

    s.select<Framing>(
      '構図',
      [
        { value: 'bust', label: 'バストアップ' },
        { value: 'upper', label: '上半身' },
        { value: 'full', label: '全身' },
      ],
      'upper',
      (v) => app.stage.frame(v),
    );
    const color = el('input', { type: 'color', value: '#1d2333' });
    color.addEventListener('input', () => app.stage.setBackgroundColor(color.value));
    s.select<BackgroundMode>(
      '背景',
      [
        { value: 'color', label: '単色' },
        { value: 'image', label: '生成画像' },
        { value: 'chroma', label: 'クロマキー（緑）' },
        { value: 'transparent', label: '透過（OBS向け）' },
      ],
      'color',
      (v) => app.stage.setBackgroundMode(v),
    );
    s.row(el('label', { class: 'field' }, el('span', { text: '背景色' }), color));
    s.text('H キーで操作パネルを隠し、配信用の画面だけにできます。');

    // Drag & drop a .vrm anywhere on the stage.
    const stageEl = document.getElementById('stage-wrap')!;
    stageEl.addEventListener('dragover', (e) => e.preventDefault());
    stageEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f?.name.toLowerCase().endsWith('.vrm')) void this.load(URL.createObjectURL(f), true);
    });

    await this.load(SAMPLE_AVATARS[0].url);
  }

  async load(url: string, revoke = false): Promise<void> {
    const status = (t: string) => this.app.bus.emit('status', { key: 'avatar', text: t });
    try {
      status('モデル読込中…');
      const avatar = await VrmAvatar.load(url, (r) => status(`モデル読込中… ${Math.round(r * 100)}%`));
      this.app.setAvatar(avatar);
      const m = avatar.meta;
      this.info.textContent = `${m.name} / ${m.authors.join(', ')} / ${m.permissions}`;
      this.credit.textContent = m.credit ?? '';
      this.credit.hidden = !m.credit;
      status('');
    } catch (err) {
      toast(`モデルを読み込めませんでした: ${(err as Error).message}`, 'error');
      status('');
    } finally {
      if (revoke) URL.revokeObjectURL(url);
    }
  }
}
