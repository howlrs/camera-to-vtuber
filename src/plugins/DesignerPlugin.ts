import type { App, Plugin } from '../core/App.ts';
import { dataUrlToPayload, grabFrame, payloadToDataUrl } from '../capture/FrameSource.ts';
import { el, toast } from '../ui/Panel.ts';
import { modelFor } from './ModelsPlugin.ts';
import type { AvatarStyle } from '../../shared/protocol.ts';

/**
 * Avatar designer: Gemini Pro turns a brief (+ optional camera snapshot) into a structured
 * AvatarStyle that *follows the loaded sample's structure* (its own material names), then
 * Nano Banana restyles the sample's texture atlases in place, keeping their UV layout.
 */
export class DesignerPlugin implements Plugin {
  readonly id = 'designer';
  private app!: App;
  private prompt!: HTMLTextAreaElement;
  private useSnapshot = false;
  private restyleTextures = true;
  private makeBackground = true;
  private persona!: HTMLElement;
  private progress!: HTMLElement;
  private concept!: HTMLElement;

  setup(app: App): void {
    this.app = app;
    const s = app.panel.section('アバター設計', 'Pro が仕様化 → Nano Banana が改変');
    this.prompt = s.textarea(
      'どんな VTuber にしたいか（例: 夜空がテーマの落ち着いた歌い手。紺と金の衣装、銀髪、星のヘアアクセ）',
      '春がテーマの元気な配信者。桜色の髪、白とミントグリーンの衣装、猫耳',
      3,
    );
    s.toggle('カメラ映像を参考にする（服の色・雰囲気）', this.useSnapshot, (v) => (this.useSnapshot = v));
    s.toggle('テクスチャを画像生成で描き換える（時間がかかります）', this.restyleTextures, (v) => (this.restyleTextures = v));
    s.toggle('背景も生成する', this.makeBackground, (v) => (this.makeBackground = v));
    s.row(
      s.button('デザインを適用', () => this.design(), 'primary'),
      s.button('元に戻す', () => this.reset()),
      s.button('設定画を生成', () => this.makeConcept()),
    );
    this.progress = s.text('', 'hint');
    this.persona = el('div', { class: 'persona', hidden: true });
    this.concept = el('div', { class: 'concept' });
    s.body.append(this.persona, this.concept);
  }

  private step(text: string): void {
    this.progress.textContent = text;
  }

  async design(): Promise<void> {
    const avatar = this.app.avatar;
    if (!avatar) throw new Error('モデルが読み込まれていません');
    if (!modelFor(this.app, 'designer')) throw new Error('設計用モデルが利用できません');
    const snapshot = this.useSnapshot && this.app.source?.active ? grabFrame(this.app.source, 768) ?? undefined : undefined;

    this.step(`仕様を設計中…（${modelFor(this.app, 'designer')}）`);
    const t0 = performance.now();
    const style = await this.app.api.design({
      prompt: this.prompt.value,
      snapshot,
      materials: avatar.describeMaterials(),
      baseModel: avatar.meta.name,
    });
    this.apply(style);
    this.step(`仕様を適用しました（${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);

    const jobs: Promise<unknown>[] = [];
    if (this.makeBackground && style.stage.backgroundPrompt) {
      this.app.bus.emit('ai:scene', { prompt: style.stage.backgroundPrompt, source: 'designer' });
    }
    if (this.restyleTextures && style.textureEdits.length && modelFor(this.app, 'image')) {
      jobs.push(this.restyle(style));
    }
    await Promise.all(jobs);
  }

  apply(style: AvatarStyle): void {
    const avatar = this.app.avatar!;
    avatar.resetStyle();
    const edited = new Set(this.restyleTextures ? style.textureEdits.map((e) => e.material) : []);
    for (const m of style.materials) {
      // Materials whose texture will be repainted keep their original tint to avoid double-coloring.
      if (!edited.has(m.name)) avatar.applyMaterialStyle(m);
    }
    this.app.accessories.apply(avatar, style.accessories);
    this.app.mixer.bias = { ...style.expressionBias };
    this.app.stage.setLights(style.stage.lightColor, style.stage.ambientColor);
    this.app.style = style;
    this.app.bus.emit('style', style);

    const p = style.persona;
    this.persona.hidden = false;
    this.persona.replaceChildren(
      el('strong', { text: p.name }),
      el('span', { text: p.tagline }),
      el('p', { text: p.personality }),
      el('p', { class: 'hint', text: `声: ${p.voice} / 話し方: ${p.speakingStyle}` }),
      el('p', {
        class: 'hint',
        text: `小物: ${style.accessories.map((a) => a.type).join(', ') || 'なし'} / テクスチャ改変: ${style.textureEdits.map((e) => e.material).join(', ') || 'なし'}`,
      }),
    );
  }

  /** Restyle all requested texture atlases in parallel (each is an independent Nano Banana edit). */
  private async restyle(style: AvatarStyle): Promise<void> {
    const avatar = this.app.avatar!;
    const total = style.textureEdits.length;
    let done = 0;
    this.step(`テクスチャ ${total} 枚を並列で描き換え中…（${modelFor(this.app, 'image')}）`);
    await Promise.all(
      style.textureEdits.map(async (edit) => {
        const source = avatar.getMaterialTexture(edit.material);
        if (!source) return;
        const { width, height } = source as { width: number; height: number };
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')!.drawImage(source as CanvasImageSource, 0, 0);
        try {
          const res = await this.app.api.texture({
            image: dataUrlToPayload(canvas.toDataURL('image/png')),
            prompt: edit.prompt,
            materialName: edit.material,
          });
          const img = await loadImage(payloadToDataUrl(res.image));
          // Resample to the original atlas size so UVs keep lining up.
          const out = document.createElement('canvas');
          out.width = width;
          out.height = height;
          const g = out.getContext('2d')!;
          g.drawImage(img, 0, 0, width, height);
          // Preserve the original alpha (cut-outs such as hair strands).
          g.globalCompositeOperation = 'destination-in';
          g.drawImage(canvas, 0, 0);
          avatar.replaceMaterialTexture(edit.material, out);
          done++;
          this.step(`テクスチャ ${done}/${total} 枚を描き換えました`);
        } catch (err) {
          toast(`「${edit.material}」の描き換えに失敗: ${(err as Error).message}`, 'warn');
        }
      }),
    );
    this.step(`テクスチャ ${done}/${total} 枚を描き換えました`);
  }

  private reset(): void {
    this.app.avatar?.resetStyle();
    this.app.accessories.clear();
    this.app.mixer.bias = { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 };
    this.app.stage.setLights('#ffffff', '#ffffff');
    this.app.style = null;
    this.persona.hidden = true;
    this.step('サンプルの元の見た目に戻しました');
  }

  private async makeConcept(): Promise<void> {
    const style = this.app.style;
    if (!style) throw new Error('先に「デザインを適用」してください');
    this.step('設定画を生成中…');
    const res = await this.app.api.concept({ style, reference: dataUrlToPayload(this.app.stage.snapshot('image/jpeg')) });
    const url = payloadToDataUrl(res.image);
    const img = el('img', { src: url, alt: `${style.persona.name} の設定画` });
    const link = el('a', { href: url, download: `${style.persona.name}.png`, text: '保存' });
    this.concept.replaceChildren(img, link);
    this.step(`設定画を生成しました（${res.model}）`);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めません'));
    img.src = src;
  });
}
