import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  type BufferGeometry,
  Group,
  Mesh,
  MeshToonMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
} from 'three';
import type { App, Plugin } from '../core/App.ts';
import { grabFrame } from '../capture/FrameSource.ts';
import { el, toast } from '../ui/Panel.ts';
import { modelFor } from './ModelsPlugin.ts';
import type { SpatialObject } from '../../shared/protocol.ts';

/**
 * Gemini Robotics-ER "座標化": normalized 2D points/boxes of what the performer holds, plus the
 * framing. Held objects become simple 3D props attached to the avatar's matching hand; framing
 * can switch full-body tracking automatically (see CapturePlugin).
 */
export class SpatialPlugin implements Plugin {
  readonly id = 'spatial';
  private app!: App;
  private props = new Map<string, Group>();
  private auto = false;
  private timer = 0;
  private out!: HTMLElement;

  setup(app: App): void {
    this.app = app;
    const s = app.panel.section('空間認識・小道具', 'Robotics-ER で手持ち物体を座標化', false);
    s.row(
      s.button('いま解析', () => this.scan(), 'primary'),
      s.button('小道具を消す', () => this.clearProps()),
    );
    s.toggle('10 秒ごとに自動解析', this.auto, (v) => {
      this.auto = v;
      clearInterval(this.timer);
      if (v) this.timer = window.setInterval(() => void this.scan().catch(() => {}), 10000);
    });
    this.out = el('p', { class: 'hint', text: 'カップやスマホなどを手に持って解析すると、アバターの手に小道具が付きます。' });
    s.body.append(this.out);
    app.bus.on('avatar', () => this.clearProps());
  }

  async scan(): Promise<void> {
    if (!modelFor(this.app, 'spatial')) throw new Error('空間認識モデルが利用できません');
    const src = this.app.source;
    if (!src?.active) throw new Error('カメラを開始してください');
    const frame = grabFrame(src, 960, 0.8);
    if (!frame) return;
    const res = await this.app.api.spatial({ frame });
    this.app.bus.emit('ai:spatial', res);
    const held = res.objects.filter((o) => o.heldBy !== 'none');
    this.out.textContent =
      `構図: ${res.framing} / 物体: ${res.objects.map((o) => `${o.label}${o.heldBy !== 'none' ? `(${o.heldBy})` : ''}`).join(', ') || 'なし'}` +
      ` / ${res.latencyMs} ms (${res.model})`;
    this.syncProps(held);
  }

  private syncProps(held: SpatialObject[]): void {
    const avatar = this.app.avatar;
    if (!avatar) return;
    const wanted = new Set<string>();
    for (const o of held) {
      if (o.heldBy === 'none') continue;
      const side = this.app.coords.avatarSide(o.heldBy);
      const key = `${side}:${o.label}`;
      wanted.add(key);
      if (this.props.has(key)) continue;
      const hand = avatar.getBoneNode(`${side}Hand`);
      if (!hand) continue;
      const prop = buildProp(o.label);
      // Hand bones point along ±X in the normalized rig; place the prop in the palm (-Y).
      prop.position.set(side === 'left' ? 0.08 : -0.08, -0.04, 0);
      hand.add(prop);
      this.props.set(key, prop);
      toast(`小道具「${o.label}」を${side === 'left' ? '左' : '右'}手に付けました`);
    }
    for (const [key, prop] of this.props) {
      if (!wanted.has(key)) {
        prop.removeFromParent();
        this.props.delete(key);
      }
    }
  }

  private clearProps(): void {
    for (const p of this.props.values()) p.removeFromParent();
    this.props.clear();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.clearProps();
  }
}

/** Primitive stand-in for a detected object + a floating label. */
function buildProp(label: string): Group {
  const l = label.toLowerCase();
  let geo: BufferGeometry;
  let color = new Color('#e8e2d0');
  if (/cup|mug|カップ|マグ|bottle|ボトル|can|缶|glass/.test(l)) {
    geo = new CylinderGeometry(0.035, 0.03, 0.1, 24);
    color = new Color('#f4f1ea');
  } else if (/phone|スマホ|携帯|remote|リモコン/.test(l)) {
    geo = new BoxGeometry(0.075, 0.15, 0.01);
    color = new Color('#2b2f3a');
  } else if (/ball|ボール|apple|りんご|orange|fruit/.test(l)) {
    geo = new SphereGeometry(0.045, 24, 16);
    color = new Color('#e85d4a');
  } else if (/pen|ペン|pencil|鉛筆|stick|brush/.test(l)) {
    geo = new CylinderGeometry(0.006, 0.006, 0.14, 12);
    color = new Color('#3b6fd8');
  } else if (/book|本|note|ノート|card|カード/.test(l)) {
    geo = new BoxGeometry(0.15, 0.2, 0.025);
    color = new Color('#c9a36b');
  } else {
    geo = new BoxGeometry(0.07, 0.07, 0.07);
  }
  const g = new Group();
  g.name = `prop:${label}`;
  g.add(new Mesh(geo, new MeshToonMaterial({ color })));
  g.add(labelSprite(label));
  return g;
}

function labelSprite(text: string): Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(16,20,28,0.78)';
  g.beginPath();
  g.roundRect(0, 8, 256, 48, 12);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = '28px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text.slice(0, 14), 128, 33);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const s = new Sprite(new SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(0.16, 0.04, 1);
  s.position.set(0, 0.12, 0);
  return s;
}
