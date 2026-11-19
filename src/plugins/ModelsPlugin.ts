import type { App, Plugin } from '../core/App.ts';
import type { ModelRole } from '../../shared/protocol.ts';
import { el } from '../ui/Panel.ts';

const ROLE_LABEL: Record<ModelRole, string> = {
  live: 'Live 演出',
  reactor: '表情リアクター',
  spatial: '空間認識・座標化',
  designer: 'アバター設計',
  transcriber: '画像から書き起こし',
  image: 'テクスチャ・設定画',
  imageFast: '背景生成',
  tts: '音声合成',
  general: '汎用',
};

/** Shows which Gemini model serves each role (resolved server-side from config/models.json). */
export class ModelsPlugin implements Plugin {
  readonly id = 'models';

  async setup(app: App): Promise<void> {
    const s = app.panel.section('Gemini モデル割り当て', 'ロール→モデル', false);
    try {
      const res = await app.api.models();
      app.models = res;
      if (!res.apiKeyConfigured) {
        s.text('GEMINI_API_KEY が未設定のため、AI 機能は無効です（トラッキングと描画は動作します）。', 'warn');
      }
      const table = el('table', { class: 'models' });
      table.append(el('tr', {}, el('th', { text: '役割' }), el('th', { text: 'モデル' })));
      for (const a of res.assignments) {
        table.append(
          el(
            'tr',
            { title: `${a.purpose}\n候補: ${a.candidates.join(', ')}` },
            el('td', { text: ROLE_LABEL[a.role] ?? a.role }),
            el('td', { class: a.model ? 'mono' : 'mono missing', text: a.model ?? '利用不可' }),
          ),
        );
      }
      s.body.append(table);
      s.text('config/models.json の候補順で、この API キーで使える最初のモデルを採用します。VTUBER_MODEL_<ROLE> で上書きできます。');
    } catch (err) {
      s.text(`モデル情報を取得できません: ${(err as Error).message}`, 'warn');
    }
  }
}

export function modelFor(app: App, role: ModelRole): string | null {
  return app.models?.assignments.find((a) => a.role === role)?.model ?? null;
}
