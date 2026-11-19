import type { App, Plugin } from '../core/App.ts';
import { dataUrlToPayload, grabFrame, payloadToDataUrl } from '../capture/FrameSource.ts';
import { el, Progress, toast } from '../ui/Panel.ts';
import { modelFor } from './ModelsPlugin.ts';
import { type AvatarPlugin, SAMPLE_AVATARS, type SampleId } from './AvatarPlugin.ts';
import type { AvatarRig } from '../avatar/AvatarRig.ts';
import {
  canvasPayload,
  composeOverlay,
  composeRepaint,
  composeShape,
  frameAtlas,
  keyUnused,
  loadImage,
  mergeByMask,
  pasteRegion,
  recolorTexture,
  referencePayload,
  region,
  toCanvas,
  type TextureSource,
  usedBounds,
} from '../avatar/TextureOps.ts';
import {
  MAX_REFERENCES,
  type AtlasPreview,
  type AvatarStyle,
  type BaseCandidate,
  type DesignMode,
  type ImagePayload,
  type RepaintMode,
  type TextureRecolor,
  repaintMode,
} from '../../shared/protocol.ts';

type BaseChoice = 'auto' | 'current' | SampleId;

interface Reference {
  payload: ImagePayload;
  url: string;
  name: string;
}

/**
 * Avatar designer: Gemini Pro turns a brief (+ optional camera snapshot) into a structured
 * AvatarStyle that *follows the loaded sample's structure* (its own material names), then
 * Nano Banana restyles the sample's texture atlases in place, keeping their UV layout.
 *
 * Transcription: the same pipeline, driven by character reference images. The transcriber model
 * (Gemini 4 Neon) reads the images and picks the sample whose shape (hair, build, outfit) is
 * closest, then writes a spec while looking at that sample's atlases. Plain-colored parts are recolored locally; patterned parts
 * are repainted by Nano Banana with the references attached.
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
  private readonly dSteps = new Progress();
  private concept!: HTMLElement;

  private refs: Reference[] = [];
  private refList!: HTMLElement;
  private notes!: HTMLTextAreaElement;
  private base!: HTMLSelectElement;
  private repaintOutfit = true;
  private readonly tSteps = new Progress();
  private analysis!: HTMLElement;
  private tPersona!: HTMLElement;

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
      s.button('デザインを適用', (b) => this.design(b), 'primary'),
      s.button('元に戻す', () => this.reset()),
      s.button('設定画を生成', () => this.makeConcept()),
    );
    s.body.append(this.dSteps.root);
    this.progress = s.text('', 'hint');
    this.persona = el('div', { class: 'persona', hidden: true });
    this.concept = el('div', { class: 'concept' });
    s.body.append(this.persona, this.concept);

    this.setupTranscription();
  }

  // ------------------------------------------------------------------ transcription UI

  private setupTranscription(): void {
    const t = this.app.panel.section('画像から書き起こし', 'キャラクター画像 → 近い素体に再現');
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, class: 'visually-hidden', id: 'ref-files' });
    input.addEventListener('change', () => {
      void this.addReferences([...(input.files ?? [])]);
      input.value = '';
    });
    const zone = el(
      'label',
      { class: 'dropzone', for: 'ref-files' },
      el('strong', { text: 'キャラクター画像を追加' }),
      el('span', { text: `ここにドロップするか、クリックして選びます（${MAX_REFERENCES} 枚まで）。立ち絵・三面図・顔のアップなど、同じキャラクターの画像` }),
    );
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      void this.addReferences([...(e.dataTransfer?.files ?? [])]);
    });
    this.refList = el('div', { class: 'ref-list' });
    t.body.append(zone, input, this.refList);

    this.notes = t.textarea('補足（任意）: 名前、性格、画像で分かりにくい部分など（例: 名前は「ミナ」。瞳は金色）', '', 2);
    this.base = t.select<BaseChoice>(
      '素体',
      [
        { value: 'auto', label: '自動（髪型と体格で選ぶ）' },
        ...SAMPLE_AVATARS.map((a) => ({ value: a.id, label: a.label })),
        { value: 'current', label: '今のモデルのまま' },
      ],
      'auto',
      () => {},
    );
    t.toggle('服などの柄を画像生成で描き換える（時間と料金がかかります）', this.repaintOutfit, (v) => (this.repaintOutfit = v));
    t.row(t.button('画像から書き起こす', (b) => this.transcribe(b), 'primary'), t.button('元に戻す', () => this.reset()));
    t.body.append(this.tSteps.root);
    this.analysis = el('div', { class: 'analysis', hidden: true });
    this.tPersona = el('div', { class: 'persona', hidden: true });
    t.body.append(this.analysis, this.tPersona);
    t.text('髪型・服の形・体型は素体のままで、色・テクスチャ・頭の小物を画像に合わせます。結果は「3Dモデル」パネルの「今の見た目を .vrm で保存」で保存できます。');
  }

  private async addReferences(files: File[]): Promise<void> {
    const images = files.filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    if (files.length && !images.length) toast('PNG・JPEG・WebP の画像を選んでください', 'warn');
    for (const f of images) {
      if (this.refs.length >= MAX_REFERENCES) {
        toast(`画像は ${MAX_REFERENCES} 枚までです`, 'warn');
        break;
      }
      try {
        const { payload, url } = await referencePayload(f);
        this.refs.push({ payload, url, name: f.name });
      } catch (err) {
        toast(`「${f.name}」を読み込めません: ${(err as Error).message}`, 'warn');
      }
    }
    this.renderReferences();
  }

  private renderReferences(): void {
    this.refList.replaceChildren(
      ...this.refs.map((r, i) => {
        const remove = el('button', { type: 'button', class: 'ref-remove', title: `${r.name} を外す`, 'aria-label': `${r.name} を外す`, text: '×' });
        remove.addEventListener('click', () => {
          this.refs.splice(i, 1);
          this.renderReferences();
        });
        return el('figure', { class: 'ref' }, el('img', { src: r.url, alt: r.name }), remove);
      }),
    );
  }

  private get avatarPlugin(): AvatarPlugin {
    return this.app.plugins.find((p) => p.id === 'avatar') as AvatarPlugin;
  }

  async transcribe(button?: HTMLButtonElement): Promise<void> {
    if (!this.refs.length) throw new Error('キャラクター画像を 1 枚以上追加してください');
    const reader = modelFor(this.app, 'transcriber');
    if (!reader) throw new Error('書き起こし用のモデルが利用できません');
    const references = this.refs.map((r) => r.payload);
    const notes = this.notes.value.trim();
    const avatarPlugin = this.avatarPlugin;
    const baseLabel = (id: string) => (id === 'current' ? '今のモデル' : SAMPLE_AVATARS.find((a) => a.id === id)?.label ?? id);
    const shortLabel = (id: string) => baseLabel(id).replace(/（.*$/, '');
    let choice = this.base.value as BaseChoice;
    const auto = choice === 'auto';
    const p = this.tSteps;
    const started = performance.now();
    p.begin([
      { id: 'read', label: auto ? '画像を読み取り、近い素体を選ぶ' : `素体を「${shortLabel(choice)}」に決める（手動）` },
      { id: 'load', label: '素体を読み込む' },
      { id: 'spec', label: '素体のテクスチャを見ながら仕様を作る' },
      { id: 'recolor', label: '髪・瞳などの色を置き換える' },
      { id: 'body', label: '腕・脚に服を描く' },
      { id: 'repaint', label: '服などの柄を描き換える' },
    ]);
    this.analysis.hidden = true;
    const problems: string[] = [];
    let style: AvatarStyle | undefined;
    let ok = false;
    this.tPersona.hidden = true;
    const label = button?.textContent ?? '';
    if (button) button.textContent = '書き起こし中…';
    try {
      let brief = '';
      if (auto) {
        p.set('read', 'running', reader);
        const candidates: BaseCandidate[] = SAMPLE_AVATARS.map((a) => ({ id: a.id, traits: a.traits }));
        if (avatarPlugin.current === null && this.app.avatar) {
          const names = this.app.avatar.describeMaterials().map((m) => m.name);
          candidates.push({
            id: 'current',
            traits: `ユーザーが読み込んだモデル「${this.app.avatar.meta.name}」（見た目は不明。マテリアル名: ${names.slice(0, 30).join(', ')}）`,
          });
        }
        const res = await this.app.api.transcribe({ references, notes, candidates });
        brief = res.brief;
        choice = res.baseModel as BaseChoice;
        p.set('read', 'done', `素体: ${shortLabel(choice)}`);
        this.analysis.hidden = false;
        this.analysis.replaceChildren(
          el('strong', { text: res.summary || 'キャラクターを読み取りました' }),
          el('p', { text: `素体: ${baseLabel(choice)}` }),
          el('p', { class: 'hint', text: res.reason }),
        );
      } else {
        p.set('read', 'done');
      }

      const sample = SAMPLE_AVATARS.find((a) => a.id === choice)?.id;
      if (sample && sample !== avatarPlugin.current) {
        p.set('load', 'running');
        if (!(await avatarPlugin.loadSample(sample))) throw new Error('素体を読み込めませんでした');
        p.set('load', 'done');
      } else {
        p.set('load', 'skipped', '読み込み済み');
      }
      const avatar = this.app.avatar;
      if (!avatar) throw new Error('モデルが読み込まれていません');

      p.set('spec', 'running', reader);
      const prompt = [brief && `## 画像の分析\n${brief}`, notes && `## ユーザーの補足\n${notes}`].filter(Boolean).join('\n\n');
      style = await this.app.api.design({
        mode: 'transcribe',
        prompt: prompt || '参照画像のキャラクターを再現する',
        references,
        atlases: atlasPreviews(avatar),
        materials: avatar.describeMaterials(),
        baseModel: avatar.meta.name,
        baseTraits: SAMPLE_AVATARS.find((a) => a.id === avatarPlugin.current)?.traits,
      });
      const changes =
        style.materials.length + style.recolors.length + style.textureEdits.length + style.accessories.length + (style.hide?.length ?? 0) + (style.bodyPaint ? 1 : 0);
      if (!changes) throw new Error('画像に合わせる変更が仕様にありませんでした。もう一度お試しください');
      p.set(
        'spec',
        'done',
        `色 ${style.recolors.length}・柄 ${style.textureEdits.length}・小物 ${style.accessories.length}${style.hide?.length ? `・消す ${style.hide.length}` : ''}`,
      );
      this.apply(style, 'transcribe');
      const { failed } = await this.applyTextures(style, { repaint: this.repaintOutfit, references, progress: p, problems });

      const secs = p.finish(true, '書き起こしが完了しました', failed ? `柄の描き換え ${failed} 枚は失敗` : '');
      ok = true;
      toast(
        `書き起こしが完了しました（${secs} 秒）${failed ? `。柄の描き換え ${failed} 枚は失敗しました` : ''}。「3Dモデル」パネルの「今の見た目を .vrm で保存」で保存できます`,
        failed ? 'warn' : 'success',
        10_000,
      );
    } catch (err) {
      problems.push((err as Error).message);
      p.finish(false, `書き起こしに失敗しました: ${(err as Error).message}`);
      throw err; // the panel button shows it as an error toast too
    } finally {
      if (button) button.textContent = label;
      this.app.api.log({
        kind: 'transcribe',
        base: this.app.avatar?.meta.name ?? '',
        ok,
        seconds: Math.round((performance.now() - started) / 1000),
        steps: p.steps(),
        style,
        problems,
      });
    }
  }

  // ------------------------------------------------------------------ design from a brief

  private step(text: string): void {
    this.progress.textContent = text;
  }

  async design(button?: HTMLButtonElement): Promise<void> {
    const avatar = this.app.avatar;
    if (!avatar) throw new Error('モデルが読み込まれていません');
    const designer = modelFor(this.app, 'designer');
    if (!designer) throw new Error('設計用モデルが利用できません');
    const snapshot = this.useSnapshot && this.app.source?.active ? grabFrame(this.app.source, 768) ?? undefined : undefined;
    const p = this.dSteps;
    p.begin([
      { id: 'spec', label: '仕様を設計する' },
      { id: 'recolor', label: '色を置き換える' },
      { id: 'repaint', label: 'テクスチャを描き換える' },
    ]);
    this.step('');
    const started = performance.now();
    const problems: string[] = [];
    let style: AvatarStyle | undefined;
    let ok = false;
    const label = button?.textContent ?? '';
    if (button) button.textContent = '適用中…';
    try {
      p.set('spec', 'running', designer);
      style = await this.app.api.design({
        prompt: this.prompt.value,
        snapshot,
        materials: avatar.describeMaterials(),
        baseModel: avatar.meta.name,
      });
      p.set('spec', 'done', style.persona.name);
      this.apply(style, 'design');
      if (this.makeBackground && style.stage.backgroundPrompt) {
        this.app.bus.emit('ai:scene', { prompt: style.stage.backgroundPrompt, source: 'designer' });
      }
      const { failed } = await this.applyTextures(style, { repaint: this.restyleTextures, progress: p, problems });
      const secs = p.finish(true, 'デザインを適用しました', failed ? `描き換え ${failed} 枚は失敗` : '');
      ok = true;
      toast(`デザインを適用しました（${secs} 秒）`, failed ? 'warn' : 'success', 8000);
    } catch (err) {
      problems.push((err as Error).message);
      p.finish(false, `デザインの適用に失敗しました: ${(err as Error).message}`);
      throw err;
    } finally {
      if (button) button.textContent = label;
      this.app.api.log({
        kind: 'design',
        base: this.app.avatar?.meta.name ?? '',
        ok,
        seconds: Math.round((performance.now() - started) / 1000),
        steps: p.steps(),
        style,
        problems,
      });
    }
  }

  apply(style: AvatarStyle, mode: DesignMode = 'design'): void {
    const avatar = this.app.avatar!;
    avatar.resetStyle();
    const repaint = mode === 'transcribe' ? this.repaintOutfit : this.restyleTextures;
    const retextured = new Set([...style.recolors.map((r) => r.material), ...(repaint ? style.textureEdits.map((e) => e.material) : [])]);
    for (const m of style.materials) {
      // A recolored / repainted texture carries its own colors; tinting it again would double them.
      if (!retextured.has(m.name)) avatar.applyMaterialStyle(m);
    }
    for (const name of style.hide ?? []) avatar.setHidden(name, true);
    this.app.accessories.apply(avatar, style.accessories);
    this.app.mixer.bias = { ...style.expressionBias };
    // A transcription is judged against the references, so keep neutral lighting.
    if (mode === 'transcribe') this.app.stage.setLights('#ffffff', '#ffffff');
    else this.app.stage.setLights(style.stage.lightColor, style.stage.ambientColor);
    this.app.style = style;
    this.app.bus.emit('style', style);

    const p = style.persona;
    const target = mode === 'transcribe' ? this.tPersona : this.persona;
    target.hidden = false;
    target.replaceChildren(
      el('strong', { text: p.name }),
      el('span', { text: p.tagline }),
      el('p', { text: p.personality }),
      el('p', { class: 'hint', text: `声: ${p.voice} / 話し方: ${p.speakingStyle}` }),
      el('p', {
        class: 'hint',
        text: `小物: ${style.accessories.map((a) => a.type).join(', ') || 'なし'} / 色の置き換え: ${style.recolors.map((r) => r.material).join(', ') || 'なし'} / テクスチャ改変: ${style.textureEdits.map((e) => e.material).join(', ') || 'なし'}${style.hide?.length ? ` / 消したパーツ: ${style.hide.join(', ')}` : ''}${style.bodyPaint ? ` / 腕・脚の服: ${[style.bodyPaint.sleeves && `袖 ${style.bodyPaint.sleeves}`, style.bodyPaint.legs && `脚 ${style.bodyPaint.legs}`].filter(Boolean).join('、')}` : ''}`,
      }),
    );
  }

  /**
   * Recolors first (local, instant), then image-model repaints in parallel, one per atlas.
   * With `references` the repaints match those images instead of following a free brief.
   * Each repaint is merged by its material's mode (see repaintMode): outfit and iris designs are
   * painted inside their islands, line art (brows, lashes) is redrawn in gray and then recolored,
   * and face-skin additions keep only the texels that changed.
   * Reports on the "recolor" and "repaint" steps of `progress`; returns how many repaints failed.
   */
  private async applyTextures(
    style: AvatarStyle,
    opts: { repaint: boolean; references?: ImagePayload[]; progress: Progress; problems?: string[] },
  ): Promise<{ failed: number }> {
    const avatar = this.app.avatar!;
    const p = opts.progress;
    const info = new Map(avatar.describeMaterials().map((m) => [m.name, m]));
    const imageModel = modelFor(this.app, 'image');
    const repainting = opts.repaint && !!imageModel;

    // Materials sharing one atlas get one repaint (the first instruction wins).
    const seen = new Set<TextureSource>();
    const edits = style.textureEdits.filter((e) => {
      const src = avatar.getMaterialTexture(e.material);
      if (!src || seen.has(src)) return false;
      seen.add(src);
      return true;
    });
    const modeOf = (material: string): RepaintMode => {
      const m = info.get(material);
      return (m && repaintMode(m)) ?? 'paint';
    };
    // Redrawn line art comes back gray: its recolor runs after the redraw (or alone if that fails).
    const afterShape = new Map<string, TextureRecolor>();
    if (repainting) {
      for (const e of edits) {
        const rc = style.recolors.find((r) => r.material === e.material);
        if (rc && modeOf(e.material) === 'shape') afterShape.set(e.material, rc);
      }
    }
    const recolor = (rc: TextureRecolor, src: TextureSource | null) => {
      let canvas = src && recolorTexture(src, rc.color, { tip: rc.tipColor, tipStart: rc.tipStart });
      // Heterochromia: the island of the avatar's own left eye (found from the mesh) gets its color.
      if (canvas && src && rc.leftEyeColor) {
        const left = recolorTexture(src, rc.leftEyeColor);
        const mask = avatar.uvMask(rc.material, canvas.width, canvas.height, { side: 'left' });
        if (left && mask) canvas = mergeByMask(canvas, left, mask);
      }
      if (canvas) for (const name of avatar.replaceMaterialTexture(rc.material, canvas)) avatar.useTextureColors(name, rc.color);
    };

    const now = style.recolors.filter((rc) => !afterShape.has(rc.material));
    const n = now.length;
    if (!n) p.set('recolor', 'skipped', afterShape.size ? '線の描き直しの後で' : 'なし');
    for (const [i, rc] of now.entries()) {
      p.set('recolor', 'running', `${i + 1}/${n}`);
      await new Promise((r) => setTimeout(r)); // ~1 s per 2K atlas: let the page repaint between them
      recolor(rc, avatar.getMaterialTexture(rc.material));
    }
    if (n) p.set('recolor', 'done', `${n} 個`);

    // Bare arms / legs of the base painted as sleeves / trousers (after a skin recolor, if any).
    const paints = (['arms', 'legs'] as const).filter((k) => (k === 'arms' ? style.bodyPaint?.sleeves : style.bodyPaint?.legs));
    if (!paints.length) p.set('body', 'skipped', 'なし');
    const painted: string[] = [];
    for (const kind of paints) {
      p.set('body', 'running', kind === 'arms' ? '袖' : '脚');
      await new Promise((r) => setTimeout(r));
      const color = (kind === 'arms' ? style.bodyPaint!.sleeves : style.bodyPaint!.legs)!;
      const limb = avatar.limbMask(kind);
      const src = limb && avatar.getMaterialTexture(limb.material);
      const canvas = src && toCanvas(src);
      const recolored = canvas && recolorTexture(canvas, color);
      if (!canvas || !limb || !recolored) {
        const msg = `${kind === 'arms' ? '腕' : '脚'}の範囲が見つからないため、服を描けませんでした`;
        opts.problems?.push(msg);
        toast(msg, 'warn', 8000);
        continue;
      }
      avatar.replaceMaterialTexture(limb.material, mergeByMask(canvas, recolored, limb.mask));
      painted.push(kind === 'arms' ? `袖 ${color}` : `脚 ${color}`);
    }
    if (paints.length) p.set('body', painted.length === paints.length ? 'done' : painted.length ? 'warn' : 'failed', painted.join('、') || '範囲なし');

    if (!opts.repaint) p.set('repaint', 'skipped', 'オフ');
    else if (!edits.length) p.set('repaint', 'skipped', 'なし');
    else if (!imageModel) p.set('repaint', 'skipped', '画像生成モデルなし');
    if (!repainting || !edits.length) return { failed: 0 };

    const total = edits.length;
    let done = 0;
    let failed = 0;
    const report = () => p.set('repaint', 'running', `${done}/${total} 枚・${imageModel}`);
    report();
    await Promise.all(
      edits.map(async (edit) => {
        const source = avatar.getMaterialTexture(edit.material);
        if (!source) return;
        const canvas = toCanvas(source);
        const { width, height } = canvas;
        const mask = avatar.uvMask(edit.material, width, height);
        const mode = modeOf(edit.material);
        const part = info.get(edit.material)?.part;
        // Small islands (iris, brows) are cut out with their surroundings and sent enlarged.
        const bounds = mask && usedBounds(mask.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data, width, height);
        const atlas = bounds ? region(canvas, bounds) : canvas;
        const used = bounds && mask ? region(mask, bounds) : mask;
        const frame = frameAtlas(keyUnused(atlas, used));
        try {
          const res = await this.app.api.texture({
            image: canvasPayload(frame.image),
            prompt: edit.prompt,
            materialName: edit.material,
            // Face parts get the designer's words only: given the drawing, the image model pasted
            // the character itself into small islands such as irises.
            references: part ? undefined : opts.references,
            aspect: frame.aspect,
            size: Math.max(frame.image.width, frame.image.height),
            part,
            leftEye: (() => {
              const side = part === 'iris' ? info.get(edit.material)?.leftEye : undefined;
              return side === 'left' || side === 'right' ? side : undefined;
            })(),
          });
          const img = frame.back(await loadImage(payloadToDataUrl(res.image)));
          const merged =
            mode === 'shape' ? composeShape(atlas, img, used) : mode === 'overlay' ? composeOverlay(atlas, img, used) : composeRepaint(atlas, img, used);
          const out = bounds ? pasteRegion(canvas, merged, bounds) : merged;
          const names = avatar.replaceMaterialTexture(edit.material, out);
          // Added marks keep the skin's own tint and shade; gray line art keeps the old tint
          // unless a recolor follows; painted designs carry their final colors.
          if (mode === 'paint') for (const name of names) avatar.useTextureColors(name);
          done++;
        } catch (err) {
          failed++;
          opts.problems?.push(`${edit.material}: ${(err as Error).message}`);
          toast(`「${edit.material}」の描き換えに失敗: ${(err as Error).message}`, 'warn', 8000);
        }
        const rc = afterShape.get(edit.material);
        if (rc) recolor(rc, avatar.getMaterialTexture(edit.material));
        report();
      }),
    );
    p.set('repaint', failed ? (done ? 'warn' : 'failed') : 'done', failed ? `${done}/${total} 枚、${failed} 枚失敗` : `${total} 枚`);
    return { failed };
  }

  private reset(): void {
    this.app.avatar?.resetStyle();
    this.app.accessories.clear();
    this.app.mixer.bias = { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 };
    this.app.stage.setLights('#ffffff', '#ffffff');
    this.app.style = null;
    this.persona.hidden = true;
    this.tPersona.hidden = true;
    this.analysis.hidden = true;
    this.dSteps.hide();
    this.tSteps.hide();
    this.step('');
    toast('元の見た目に戻しました');
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

/**
 * One small preview per distinct atlas, labelled with every material that samples it. Unused
 * space is keyed magenta, as in the atlases the image model receives.
 */
export function atlasPreviews(avatar: AvatarRig, max = 24, side = 256): AtlasPreview[] {
  const groups = new Map<TextureSource, string[]>();
  for (const m of avatar.describeMaterials()) {
    if (!m.hasTexture) continue;
    const src = avatar.getMaterialTexture(m.name);
    if (!src) continue;
    if (groups.has(src)) groups.get(src)!.push(m.name);
    else groups.set(src, [m.name]);
  }
  return [...groups].slice(0, max).map(([src, materials]) => {
    const small = toCanvas(src, side);
    const mask = avatar.uvMask(materials[0]!, small.width, small.height);
    return { materials, image: canvasPayload(keyUnused(small, mask)) };
  });
}
