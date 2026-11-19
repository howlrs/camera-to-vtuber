import type { AvatarStyle, Emotion, Gesture, ModelsResponse, SpatialResponse } from '../../shared/protocol.ts';
import { ApiClient } from '../ai/ApiClient.ts';
import { AccessoryManager } from '../avatar/Accessories.ts';
import type { AvatarRig } from '../avatar/AvatarRig.ts';
import { ExpressionMixer } from '../avatar/ExpressionMixer.ts';
import { GestureLayer } from '../avatar/GestureLayer.ts';
import { LipSync, PcmPlayer } from '../audio/Audio.ts';
import type { FrameSource } from '../capture/FrameSource.ts';
import { CoordinateSpace } from '../coords/CoordinateSpace.ts';
import type { Stage } from '../render/Stage.ts';
import { MotionSmoother } from '../solver/MotionSmoother.ts';
import { MotionSolver } from '../solver/MotionSolver.ts';
import type { TrackerHost } from '../tracking/TrackerHost.ts';
import type { Panel } from '../ui/Panel.ts';
import { EventBus } from './EventBus.ts';
import { type AvatarSpaceFrame, emptyMotion, type MotionFrame, type TrackingFrame } from './types.ts';

export interface AppEvents extends Record<string, unknown> {
  status: { key: string; text: string };
  tracking: TrackingFrame;
  avatarSpace: AvatarSpaceFrame;
  avatar: AvatarRig;
  source: FrameSource | null;
  'ai:expression': { emotion: Emotion; intensity: number; durationSec: number; source: string };
  'ai:gesture': { gesture: Gesture; source: string };
  'ai:scene': { prompt: string; source: string };
  'ai:caption': { text: string; source: string };
  'ai:transcript': { role: 'user' | 'model'; text: string };
  'ai:spatial': SpatialResponse;
  style: AvatarStyle;
}

/**
 * A feature module. Gemini integrations, overlays and props are all plugins: they get the App
 * (pipeline stages, stage, bus, API client, UI panel) in setup() and may post-process each
 * MotionFrame in update() before it reaches the avatar.
 */
export interface Plugin {
  readonly id: string;
  setup(app: App): void | Promise<void>;
  update?(dt: number, now: number, motion: MotionFrame): void;
  dispose?(): void;
}

export class App {
  readonly bus = new EventBus<AppEvents>();
  readonly api = new ApiClient();
  readonly coords = new CoordinateSpace();
  readonly solver = new MotionSolver();
  readonly smoother = new MotionSmoother();
  readonly mixer = new ExpressionMixer();
  readonly gestures = new GestureLayer();
  readonly accessories = new AccessoryManager();
  readonly plugins: Plugin[] = [];
  models: ModelsResponse | null = null;
  avatar: AvatarRig | null = null;
  source: FrameSource | null = null;
  /** Latest avatar-space observation (for calibration and plugins). */
  lastAvatarSpace: AvatarSpaceFrame | null = null;
  lastTracking: TrackingFrame | null = null;
  style: AvatarStyle | null = null;

  private lastRaw: MotionFrame = emptyMotion();
  private lastRawAt = 0;
  private lastTime = performance.now();
  private audio: { player: PcmPlayer; lipSync: LipSync } | null = null;
  private fps = 0;
  private running = false;

  constructor(
    readonly stage: Stage,
    readonly trackers: TrackerHost,
    readonly panel: Panel,
  ) {
    this.bus.on('ai:expression', (e) => this.mixer.hint(e.emotion, e.intensity, e.durationSec, this.now(), e.source));
    this.bus.on('ai:gesture', (g) => this.gestures.play(g.gesture, this.now()));
  }

  now(): number {
    return performance.now() / 1000;
  }

  /** Shared audio output for avatar speech (created lazily after a user gesture). */
  get voice(): { player: PcmPlayer; lipSync: LipSync } {
    if (!this.audio) {
      const player = new PcmPlayer();
      this.audio = { player, lipSync: new LipSync(player.analyser) };
    }
    return this.audio;
  }

  async use(plugin: Plugin): Promise<void> {
    this.plugins.push(plugin);
    await plugin.setup(this);
  }

  setAvatar(avatar: AvatarRig): void {
    this.avatar?.dispose();
    this.accessories.clear();
    this.avatar = avatar;
    this.solver.body.hasUpperChest = avatar.hasUpperChest;
    this.smoother.reset();
    this.stage.setAvatar(avatar);
    this.bus.emit('avatar', avatar);
  }

  async setSource(source: FrameSource | null): Promise<void> {
    this.source?.stop();
    this.source = source;
    if (source) await source.start();
    this.bus.emit('source', source);
  }

  /** Treat the current head pose as "facing the screen" (compensates camera placement). */
  calibrate(): boolean {
    const head = this.lastAvatarSpace?.head;
    if (!head) return false;
    this.coords.calibrate(head.rotation);
    this.solver.calibrateNeutral(this.lastAvatarSpace?.blendshapes ?? null);
    this.smoother.reset();
    return true;
  }

  resetCalibration(): void {
    this.coords.resetCalibration();
    this.solver.resetCalibration();
    this.smoother.reset();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.tick();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  get stats() {
    return { fps: this.fps, timings: this.lastTracking?.timings ?? {}, delegate: this.trackers.delegate };
  }

  private tick(): void {
    const nowMs = performance.now();
    const dt = Math.min(0.1, (nowMs - this.lastTime) / 1000);
    this.lastTime = nowMs;
    const now = nowMs / 1000;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    // 1. capture + track
    if (this.source?.active) {
      const frame = this.trackers.process(this.source.video);
      if (frame) {
        this.lastTracking = frame;
        this.bus.emit('tracking', frame);
        // 2. coordinates -> 3. motion
        const space = this.coords.convert(frame);
        this.lastAvatarSpace = space;
        this.bus.emit('avatarSpace', space);
        this.lastRaw = this.solver.solve(space);
        this.lastRawAt = now;
      }
    }
    const raw = now - this.lastRawAt < 0.5 ? this.lastRaw : emptyMotion();

    // 4. smoothing + 5. layers (expressions, voice, gestures, plugins)
    const motion = this.smoother.smooth(raw, now, dt);
    if (this.audio?.player.playing) {
      const { visemes, level } = this.audio.lipSync.sample();
      this.mixer.setVoice(visemes, level);
    } else {
      this.mixer.setVoice({}, 0);
    }
    motion.expressions = this.mixer.mix(motion.expressions, now);
    this.gestures.apply(motion, now);
    for (const p of this.plugins) p.update?.(dt, now, motion);

    // 6. avatar + render
    if (this.avatar) {
      this.avatar.apply(motion);
      this.avatar.update(dt);
    }
    this.stage.render();
  }
}

