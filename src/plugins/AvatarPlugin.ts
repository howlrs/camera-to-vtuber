import type { App, Plugin } from '../core/App.ts';
import { VrmAvatar } from '../avatar/VrmAvatar.ts';
import type { BackgroundMode, Framing } from '../render/Stage.ts';
import { el, toast } from '../ui/Panel.ts';
import { canvasToBytes, loadImage } from '../avatar/TextureOps.ts';

/**
 * Sample avatars fetched by `npm run setup`: two VRM 1.0 samples from the VRM Consortium
 * specification repo and a male short-haired VRoid sample (VRM 0.x). All allow avatar use by
 * anyone, commercial use, modification and redistribution (see public/avatars/LICENSES.md).
 */
export const SAMPLE_AVATARS = [
  {
    id: 'twist',
    label: 'VRM1 Constraint Twist Sample（pixiv / VRoid構造）',
    url: '/avatars/VRM1_Constraint_Twist_Sample.vrm',
    traits: '女性。腰まで届くストレートのロングヘア（前髪あり、結んでいない）。細身。半袖の T シャツ、ショートパンツ、スニーカー。服はほぼ無地で、柄を描き込みやすい',
  },
  {
    id: 'seed',
    label: 'Seed-san（VirtualCast）',
    url: '/avatars/Seed-san.vrm',
    traits: '中性的な少年風。黒髪のショートで後ろに小さなポニーテール。白い半袖のチュニックと長ズボン、黒いアームカバー、背中にロボットアーム付きのバックパック（外せない）。SF・メカ風の衣装',
  },
  {
    id: 'fumiriya',
    label: '桜田 史利矢（VRoid サンプル・男性・短髪 / VRM 0.x）',
    url: '/avatars/Sakurada_Fumiriya.vrm',
    traits: '男性。耳にかかる程度の短髪。標準体型。白い半袖シャツ、ネクタイ、ニットのベスト、長ズボン、革靴（制服風）',
  },
  {
    id: 'hairMale',
    label: 'HairSample_Male（VRoid サンプル・男性・長袖パーカー / VRM 0.x）',
    url: '/avatars/HairSample_Male.vrm',
    traits: '男性。目にかかる長めの前髪の黒髪ショート（襟足は短い）。標準体型。フード付きの長袖パーカー（手首まで）、細身の長ズボン、靴。ネクタイなし',
  },
  {
    id: 'hairFemale',
    label: 'HairSample_Female（VRoid サンプル・ツインテール・長袖ワンピース / VRM 0.x）',
    url: '/avatars/HairSample_Female.vrm',
    traits: '女性。黒髪のツインテール（肩下まで）、前髪あり、頭に猫耳の形の髪（外せない）。細身。長袖でふんわりした袖の膝丈ワンピース、白い靴',
  },
  {
    id: 'darkness',
    label: 'AvatarSample_D_Darkness（VRoid サンプル・ロングヘア・ロングコート / VRM 0.x）',
    url: '/avatars/AvatarSample_D_Darkness.vrm',
    traits: '女性。腰まで届くストレートのロングヘア（前髪あり）、尖ったエルフ耳（外せない）。細身。足首まで届く長袖のロングコート（ゴシック調、裾が広がる）、タイツ、厚底の靴',
  },
] as const;

export type SampleId = (typeof SAMPLE_AVATARS)[number]['id'];

/** Avatar selection (samples or user .vrm), camera framing, background and license credit. */
export class AvatarPlugin implements Plugin {
  readonly id = 'avatar';
  private app!: App;
  private credit = document.getElementById('credit')!;
  private info!: HTMLElement;
  private picker!: HTMLSelectElement;
  /** Sample shown now, or null for a user's .vrm. */
  current: SampleId | null = null;

  async setup(app: App): Promise<void> {
    this.app = app;
    const s = app.panel.section('3Dモデル', 'VRM サンプルを取り込み');
    this.picker = s.select<SampleId>(
      'モデル',
      SAMPLE_AVATARS.map((a) => ({ value: a.id, label: a.label })),
      SAMPLE_AVATARS[0].id,
      (id) => void this.loadSample(id),
    );
    const file = el('input', { type: 'file', accept: '.vrm', class: 'visually-hidden', id: 'vrm-file' });
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (f) void this.load(URL.createObjectURL(f), true);
    });
    s.row(el('label', { class: 'btn plain', for: 'vrm-file', text: '手持ちの .vrm を読み込む' }), file);
    this.info = s.text('', 'meta');
    s.row(s.button('今の見た目を .vrm で保存', () => this.save()));
    s.text('色とテクスチャの変更を、元のモデルの表情・揺れ物・利用条件ごと保存します。頭の小物は保存されません。');

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

    await this.loadSample(SAMPLE_AVATARS[0].id);
  }

  async loadSample(id: SampleId): Promise<boolean> {
    const sample = SAMPLE_AVATARS.find((a) => a.id === id)!;
    this.picker.value = id;
    const ok = await this.load(sample.url);
    if (ok) this.current = id;
    return ok;
  }

  /** Download the current look as a .vrm (a patched copy of the loaded file). */
  async save(): Promise<void> {
    const avatar = this.app.avatar;
    if (!avatar) throw new Error('モデルが読み込まれていません');
    const name = this.app.style?.persona.name || avatar.meta.name;
    const blob = await avatar.exportVrm({ name, thumbnail: await this.thumbnail() });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${name.replace(/[\\/:*?"<>|]+/g, '_')}.vrm` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    toast(`「${name}.vrm」を保存しました（${(blob.size / 1024 / 1024).toFixed(1)} MB）`);
  }

  /** Square PNG of the stage without accessories (they are not part of the exported file). */
  private async thumbnail(): Promise<Uint8Array> {
    const stage = this.app.stage;
    this.app.accessories.setVisible(false);
    stage.render();
    const img = await loadImage(stage.snapshot('image/png'));
    this.app.accessories.setVisible(true);
    const side = Math.min(img.width, img.height);
    const out = Math.min(1024, side);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = out;
    canvas.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out);
    return canvasToBytes(canvas);
  }

  async load(url: string, revoke = false): Promise<boolean> {
    const status = (t: string) => this.app.bus.emit('status', { key: 'avatar', text: t });
    try {
      status('モデル読込中…');
      const avatar = await VrmAvatar.load(url, (r) => status(`モデル読込中… ${Math.round(r * 100)}%`));
      this.app.setAvatar(avatar);
      const m = avatar.meta;
      this.info.textContent = `${m.name} / ${m.authors.join(', ')} / ${m.permissions}`;
      this.credit.textContent = m.credit ?? '';
      this.credit.hidden = !m.credit;
      this.current = null; // loadSample() sets it after a sample loads
      status('');
      return true;
    } catch (err) {
      toast(`モデルを読み込めませんでした: ${(err as Error).message}`, 'error');
      status('');
      return false;
    } finally {
      if (revoke) URL.revokeObjectURL(url);
    }
  }
}
