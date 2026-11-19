import { Euler, Quaternion, Vector3 } from 'three';
import type { App, Plugin } from '../core/App.ts';
import type { HumanBoneName, MotionFrame } from '../core/types.ts';
import type { FaceTracker, HandTracker } from '../tracking/MediaPipeTrackers.ts';

/**
 * Development diagnostics: aggregates numeric tracking/motion statistics over 2 s windows and
 * posts them to /api/diag (written to logs/diag.jsonl on this machine). No images are sent.
 * Used to tune thresholds and smoothing against a real camera.
 */

const SHAPES = [
  'eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthFunnel', 'mouthPucker',
  'browInnerUp', 'browDownLeft', 'eyeWideLeft', 'eyeLookOutLeft', 'eyeLookInLeft', 'eyeLookUpLeft', 'eyeLookDownLeft',
];
const POSE_POINTS: Record<string, number> = { nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24 };
const JITTER_BONES: HumanBoneName[] = ['head', 'neck', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand', 'chest'];
const EXPRS = ['blinkLeft', 'blinkRight', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'angry', 'sad', 'surprised', 'relaxed'];

interface Range {
  min: number;
  max: number;
  sum: number;
  n: number;
}
const range = (): Range => ({ min: Infinity, max: -Infinity, sum: 0, n: 0 });
const add = (r: Range, v: number) => {
  r.min = Math.min(r.min, v);
  r.max = Math.max(r.max, v);
  r.sum += v;
  r.n++;
};
const summary = (r: Range, digits = 3) =>
  r.n ? { min: +r.min.toFixed(digits), max: +r.max.toFixed(digits), avg: +(r.sum / r.n).toFixed(digits) } : null;

export class DiagnosticsPlugin implements Plugin {
  readonly id = 'diagnostics';
  enabled = import.meta.env.DEV;
  private app!: App;
  private w = this.fresh();
  private prevBones = new Map<string, Quaternion>();
  private prevRawHead: Quaternion | null = null;
  private prevHeadWorld: Quaternion | null = null;
  private prevRawT = 0;
  private errors: string[] = [];
  private timer = 0;
  private seq = 0;
  private lastSwaps = 0;

  setup(app: App): void {
    this.app = app;
    const s = app.panel.section('診断', '開発用（数値のみ・ローカル保存）', false);
    s.toggle('診断ログを送信（logs/diag.jsonl）', this.enabled, (v) => (this.enabled = v));
    s.row(s.button('マーカーを記録', () => this.mark(prompt('マーカー名（例: 右手を上げた）') ?? '')));

    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      this.errors.push(args.map(String).join(' ').slice(0, 300));
      origError(...args);
    };
    window.addEventListener('error', (e) => this.errors.push(`onerror: ${e.message}`));
    window.addEventListener('unhandledrejection', (e) => this.errors.push(`rejection: ${String(e.reason).slice(0, 300)}`));

    app.bus.on('tracking', (f) => {
      const w = this.w;
      w.frames++;
      if (f.face) w.face++;
      if (f.pose) w.pose++;
      for (const h of f.hands) w.hands[h.side]++;
      for (const [k, v] of Object.entries(f.timings)) add((w.timings[k] ??= range()), v);
      if (f.face) for (const k of SHAPES) add((w.shapes[k] ??= range()), f.face.blendshapes[k] ?? 0);
      if (f.pose) {
        for (const [k, i] of Object.entries(POSE_POINTS)) add((w.vis[k] ??= range()), f.pose.landmarks[i]?.visibility ?? 0);
      }
      const faceTracker = app.trackers.get<FaceTracker>('face');
      if (faceTracker?.mode === 'crop') w.faceCrop++;
      w.video = `${f.width}x${f.height}`;
    });
    app.bus.on('avatarSpace', (s) => {
      if (!s.head) return;
      const e = new Euler().setFromQuaternion(s.head.rotation, 'YXZ');
      add(this.w.headYaw, (e.y * 180) / Math.PI);
      add(this.w.headPitch, (e.x * 180) / Math.PI);
      add(this.w.headRoll, (e.z * 180) / Math.PI);
      const t = s.timestamp / 1000;
      if (this.prevRawHead && t > this.prevRawT) {
        add(this.w.rawHeadSpeed, (this.prevRawHead.angleTo(s.head.rotation) * 180) / Math.PI / (t - this.prevRawT));
      }
      this.prevRawHead = s.head.rotation.clone();
      this.prevRawT = t;
    });

    this.timer = window.setInterval(() => void this.flush(), 2000);
  }

  update(dt: number, _now: number, motion: MotionFrame): void {
    if (!this.enabled || dt <= 0) return;
    const w = this.w;
    add(w.fps, 1 / dt);
    for (const b of JITTER_BONES) {
      const q = motion.bones.get(b);
      if (!q) continue;
      const prev = this.prevBones.get(b);
      if (prev) add((w.boneSpeed[b] ??= range()), (prev.angleTo(q) * 180) / Math.PI / dt);
      this.prevBones.set(b, q.clone());
    }
    // Perceived head motion: torso chain + neck + head composed in avatar space.
    const hw = new Quaternion();
    for (const b of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'] as const) {
      const q = motion.bones.get(b);
      if (q) hw.multiply(q);
    }
    if (this.prevHeadWorld) add(w.headWorldSpeed, (this.prevHeadWorld.angleTo(hw) * 180) / Math.PI / dt);
    this.prevHeadWorld = hw;
    for (const k of EXPRS) add((w.expr[k] ??= range()), motion.expressions.get(k) ?? 0);
    const modes = this.app.solver.body.armModes;
    for (const side of ['left', 'right'] as const) w.armModes[`${side}:${modes[side]}`] = (w.armModes[`${side}:${modes[side]}`] ?? 0) + 1;
    add(w.conf.face, motion.confidence.face);
    add(w.conf.body, motion.confidence.body);
    add(w.conf.left, motion.confidence.left);
    add(w.conf.right, motion.confidence.right);
    if (motion.eye) {
      add(w.eyeYaw, motion.eye.yaw);
      add(w.eyePitch, motion.eye.pitch);
    }
  }

  private fresh() {
    return {
      frames: 0, face: 0, faceCrop: 0, pose: 0, hands: { left: 0, right: 0 }, video: '',
      timings: {} as Record<string, Range>, shapes: {} as Record<string, Range>, vis: {} as Record<string, Range>,
      headYaw: range(), headPitch: range(), headRoll: range(), rawHeadSpeed: range(), headWorldSpeed: range(),
      fps: range(), boneSpeed: {} as Record<string, Range>, expr: {} as Record<string, Range>,
      conf: { face: range(), body: range(), left: range(), right: range() },
      eyeYaw: range(), eyePitch: range(),
      armModes: {} as Record<string, number>,
      marker: '' as string,
    };
  }

  private mark(name: string): void {
    if (name) this.w.marker = name;
  }

  /** World direction each upper/lower arm currently points to (avatar space). */
  private armDirections() {
    const a = this.app.avatar;
    if (!a) return null;
    const out: Record<string, number[]> = {};
    const rest: [HumanBoneName, Vector3][] = [
      ['leftUpperArm', new Vector3(1, 0, 0)], ['leftLowerArm', new Vector3(1, 0, 0)],
      ['rightUpperArm', new Vector3(-1, 0, 0)], ['rightLowerArm', new Vector3(-1, 0, 0)],
    ];
    const rootInv = a.object.getWorldQuaternion(new Quaternion()).invert();
    for (const [b, r] of rest) {
      const n = a.getBoneNode(b);
      if (!n) continue;
      const q = rootInv.clone().multiply(n.getWorldQuaternion(new Quaternion()));
      out[b] = r.applyQuaternion(q).toArray().map((v) => +v.toFixed(2));
    }
    return out;
  }

  private async flush(): Promise<void> {
    const w = this.w;
    this.w = this.fresh();
    if (!this.enabled || !this.app.source?.active) return;
    const pct = (n: number) => (w.frames ? +((100 * n) / w.frames).toFixed(0) : 0);
    const mapRanges = (o: Record<string, Range>, d = 3) => Object.fromEntries(Object.entries(o).map(([k, r]) => [k, summary(r, d)]));
    const payload = {
      seq: this.seq++,
      marker: w.marker || undefined,
      source: this.app.source.label,
      video: w.video,
      avatar: this.app.avatar?.meta.name,
      settings: {
        mirror: this.app.coords.options.mirror,
        inputMirrored: this.app.coords.options.inputMirrored,
        swapSides: this.app.coords.options.blendshapeImageSides,
        legs: this.app.solver.body.options.legs,
        calibrationDeg: +((this.app.coords.calibration.angleTo(new Quaternion()) * 180) / Math.PI).toFixed(1),
        delegate: this.app.trackers.delegate,
        trackers: this.app.trackers.trackers.map((t) => `${t.id}:${t.enabled ? 'on' : 'off'}/${t.interval}`),
      },
      trackingFps: +(w.frames / 2).toFixed(1),
      renderFps: summary(w.fps, 1),
      detectPct: { face: pct(w.face), faceCrop: pct(w.faceCrop), pose: pct(w.pose), handL: pct(w.hands.left), handR: pct(w.hands.right) },
      timingsMs: mapRanges(w.timings, 1),
      poseVisibility: mapRanges(w.vis, 2),
      blendshapes: mapRanges(w.shapes),
      headDeg: { yaw: summary(w.headYaw, 1), pitch: summary(w.headPitch, 1), roll: summary(w.headRoll, 1) },
      rawHeadSpeedDegPerSec: summary(w.rawHeadSpeed, 1),
      headWorldSpeedDegPerSec: summary(w.headWorldSpeed, 1),
      boneSpeedDegPerSec: mapRanges(w.boneSpeed, 1),
      expressions: mapRanges(w.expr, 2),
      eye: { yaw: summary(w.eyeYaw, 1), pitch: summary(w.eyePitch, 1) },
      confidence: { face: summary(w.conf.face, 2), body: summary(w.conf.body, 2), left: summary(w.conf.left, 2), right: summary(w.conf.right, 2) },
      armDirections: this.armDirections(),
      armModes: w.armModes,
      handSwaps: (() => {
        const id = this.app.trackers.get<HandTracker>('hands')?.identity;
        const n = id ? id.swaps - this.lastSwaps : 0;
        this.lastSwaps = id?.swaps ?? 0;
        return n;
      })(),
      errors: this.errors.splice(0),
    };
    try {
      await fetch('/api/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    } catch {
      /* server restarting */
    }
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
