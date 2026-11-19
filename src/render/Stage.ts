import {
  AmbientLight,
  Color,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AvatarRig } from '../avatar/AvatarRig.ts';

export type Framing = 'bust' | 'upper' | 'full';
export type BackgroundMode = 'color' | 'image' | 'transparent' | 'chroma';

/** three.js scene, camera framing presets, lights and backgrounds (incl. OBS-friendly modes). */
export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(30, 1, 0.05, 50);
  readonly controls: OrbitControls;
  readonly key = new DirectionalLight(0xffffff, Math.PI * 0.9);
  readonly ambient = new AmbientLight(0xffffff, Math.PI * 0.45);
  private avatar: AvatarRig | null = null;
  private bgColor = new Color('#1d2333');
  private bgTexture: Texture | null = null;
  private mode: BackgroundMode = 'color';
  private framing: Framing = 'upper';

  constructor(private readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.key.position.set(0.6, 1.8, 2.2);
    this.scene.add(this.key, this.ambient);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.applyBackground();
  }

  setAvatar(avatar: AvatarRig | null): void {
    if (this.avatar) this.scene.remove(this.avatar.object);
    this.avatar = avatar;
    if (avatar) {
      this.scene.add(avatar.object);
      this.frame(this.framing);
    }
  }

  frame(framing: Framing): void {
    this.framing = framing;
    const h = this.avatar?.headHeight ?? 1.4;
    const presets: Record<Framing, { y: number; dist: number }> = {
      bust: { y: h - 0.04, dist: 1.3 },
      upper: { y: h - 0.2, dist: 2.1 },
      full: { y: h * 0.55, dist: 3.6 },
    };
    const p = presets[framing];
    this.controls.target.set(0, p.y, 0);
    this.camera.position.set(0, p.y + 0.02, p.dist);
    this.controls.update();
  }

  setLights(key: string, ambient: string): void {
    this.key.color.set(key);
    this.ambient.color.set(ambient);
  }

  setBackgroundColor(color: string): void {
    this.bgColor.set(color);
    this.setBackgroundMode('color');
  }

  async setBackgroundImage(url: string): Promise<void> {
    const tex = await new TextureLoader().loadAsync(url);
    tex.colorSpace = SRGBColorSpace;
    this.bgTexture?.dispose();
    this.bgTexture = tex;
    this.setBackgroundMode('image');
  }

  setBackgroundMode(mode: BackgroundMode): void {
    this.mode = mode;
    this.applyBackground();
  }

  get backgroundMode(): BackgroundMode {
    return this.mode;
  }

  render(): void {
    this.controls.update();
    this.coverBackground();
    this.renderer.render(this.scene, this.camera);
  }

  /** Current frame as a JPEG/PNG data URL (used as a reference image for Gemini). */
  snapshot(type = 'image/png'): string {
    return this.renderer.domElement.toDataURL(type);
  }

  private applyBackground(): void {
    switch (this.mode) {
      case 'transparent':
        this.scene.background = null;
        this.renderer.setClearColor(0x000000, 0);
        break;
      case 'chroma':
        this.scene.background = new Color('#00ff00');
        break;
      case 'image':
        this.scene.background = this.bgTexture ?? this.bgColor;
        break;
      default:
        this.scene.background = this.bgColor;
    }
  }

  /** Emulate CSS background-size: cover for image backgrounds. */
  private coverBackground(): void {
    const tex = this.bgTexture;
    if (this.mode !== 'image' || !tex?.image) return;
    const img = tex.image as { width: number; height: number };
    const canvasAspect = this.camera.aspect;
    const imageAspect = img.width / img.height;
    const factor = imageAspect / canvasAspect;
    tex.offset.set(factor > 1 ? (1 - 1 / factor) / 2 : 0, factor > 1 ? 0 : (1 - factor) / 2);
    tex.repeat.set(factor > 1 ? 1 / factor : 1, factor > 1 ? 1 : factor);
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  worldToScreen(p: Vector3): { x: number; y: number } {
    const v = p.clone().project(this.camera);
    return { x: (v.x + 1) / 2, y: (1 - v.y) / 2 };
  }
}
