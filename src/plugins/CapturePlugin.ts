import type { App, Plugin } from '../core/App.ts';
import type { Landmark, TrackingFrame } from '../core/types.ts';
import { CameraSource, VideoFileSource } from '../capture/FrameSource.ts';
import type { HandTracker, PoseTracker } from '../tracking/MediaPipeTrackers.ts';
import { el, toast } from '../ui/Panel.ts';
import type { SpatialResponse } from '../../shared/protocol.ts';

const POSE_EDGES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
];
const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
const RESUME_KEY = 'vtuber.camera.resume';
const INPUT_MIRRORED_KEY = 'vtuber.camera.inputMirrored';
const MIRROR_KEY = 'vtuber.display.mirror';
const BLUR_KEY = 'vtuber.display.blurPreview';
/** localStorage wrapper (per-browser preferences), tolerant of disabled storage. */
export const localStore = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};
/** sessionStorage wrapper that tolerates disabled storage. */
const storage = {
  get(k: string): string | null {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
  remove(k: string): void {
    try {
      sessionStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  },
};
const FACE_OUTLINE = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10];

/** Camera selection, mirror/calibration, tracker toggles, and the landmark preview overlay. */
export class CapturePlugin implements Plugin {
  readonly id = 'capture';
  private app!: App;
  private preview = document.getElementById('preview')!;
  private canvas = el('canvas');
  private showOverlay = true;
  private spatial: { res: SpatialResponse; at: number } | null = null;
  private cameraLabel = '';

  setup(app: App): void {
    this.app = app;
    this.preview.append(this.canvas);
    app.bus.on('tracking', (f) => this.draw(f));
    app.bus.on('ai:spatial', (res) => (this.spatial = { res, at: performance.now() }));

    // ---------------------------------------------------------------- camera
    const s = app.panel.section('カメラ', 'ローカル映像の取得');
    const deviceSel = s.select('デバイス', [{ value: '', label: '既定のカメラ' }], '', () => {});
    const refresh = async () => {
      const devices = await CameraSource.listDevices();
      s.setOptions(
        deviceSel,
        [{ value: '', label: '既定のカメラ' }, ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `カメラ ${i + 1}` }))],
        deviceSel.value,
      );
    };
    void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void refresh());

    const startCamera = async (deviceId?: string) => {
      const cam = new CameraSource({ deviceId: deviceId || undefined });
      await app.setSource(cam);
      this.attachVideo(cam.video);
      startBtn.textContent = 'カメラ停止';
      storage.set(RESUME_KEY, deviceId ?? '');
      await refresh(); // labels become available after permission
      if (deviceId) deviceSel.value = deviceId;
      toast(`${cam.label} を開始しました`);
      // Whether this camera delivers a flipped image is remembered per camera; unknown cameras
      // get a one-time guided check (raise your right hand).
      this.cameraLabel = cam.label;
      const known = localStore.get(`${INPUT_MIRRORED_KEY}:${cam.label}`);
      if (known !== null) setInputMirrored(known === '1');
      else void orientationCheck(true);
    };
    const startBtn = s.button(
      'カメラ開始',
      async () => {
        if (app.source?.active) {
          await app.setSource(null);
          startBtn.textContent = 'カメラ開始';
          storage.remove(RESUME_KEY);
          return;
        }
        await startCamera(deviceSel.value);
      },
      'primary',
    );
    const fileInput = el('input', { type: 'file', accept: 'video/*', class: 'visually-hidden', id: 'video-file' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const src = new VideoFileSource(file);
      await app.setSource(src);
      this.attachVideo(src.video);
      startBtn.textContent = 'カメラ開始';
    });
    s.row(startBtn, el('label', { class: 'btn plain', for: 'video-file', text: '動画ファイル' }), fileInput);

    // Resume the camera after a reload (e.g. dev hot reload) when it was running in this tab.
    const resumeId = storage.get(RESUME_KEY);
    if (resumeId !== null && !app.source) {
      void startCamera(resumeId).catch(() => storage.remove(RESUME_KEY));
    }

    // Auto-calibration state (armed on camera start and after left/right setting changes).
    let pending = false;
    let steady = 0;
    let prev: import('three').Quaternion | null = null;
    const rearm = () => {
      pending = !!app.source?.active && auto.checked;
      steady = 0;
      prev = null;
    };
    const syncPreview = () => this.preview.classList.toggle('mirrored', app.coords.flip);
    app.coords.options.mirror = localStore.get(MIRROR_KEY) !== '0';
    s.toggle('ミラー表示（鏡のように動く）', app.coords.options.mirror, (v) => {
      app.coords.options.mirror = v;
      localStore.set(MIRROR_KEY, v ? '1' : '0');
      app.resetCalibration();
      syncPreview();
      rearm();
    });
    // Some webcams/drivers deliver an already-flipped image; remembered per camera.
    const inputMirrored = s.toggle('カメラ映像自体が左右反転している', app.coords.options.inputMirrored, (v) => setInputMirrored(v));
    const orientationNote = s.text('', 'hint');
    const setInputMirrored = (v: boolean) => {
      app.coords.options.inputMirrored = v;
      inputMirrored.checked = v;
      if (this.cameraLabel) localStore.set(`${INPUT_MIRRORED_KEY}:${this.cameraLabel}`, v ? '1' : '0');
      orientationNote.textContent = this.cameraLabel
        ? `${this.cameraLabel}: 映像の左右反転${v ? 'あり（自動で補正中）' : 'なし'}`
        : '';
      app.resetCalibration();
      syncPreview();
      rearm();
    };
    syncPreview();

    /**
     * Guided left/right check: the performer raises their RIGHT hand. MediaPipe labels sides
     * anatomically for an unflipped image, so if the raised hand is reported as "left", the camera
     * delivers a flipped image. Resolves with the decision, or null when skipped / timed out.
     */
    const guide = document.getElementById('guide')!;
    let checking = false;
    const orientationCheck = async (automatic: boolean): Promise<boolean | null> => {
      if (checking) return null;
      checking = true;
      const text = el('span', { text: 'カメラの左右を確認します。右手を顔の横まで上げてください' });
      const skip = el('button', { class: 'btn plain', type: 'button', text: 'スキップ' });
      guide.replaceChildren(text, skip);
      guide.hidden = false;
      let left = 0;
      let right = 0;
      const result = await new Promise<boolean | null>((resolve) => {
        const done = (v: boolean | null) => {
          off();
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(() => done(null), 25000);
        skip.onclick = () => done(null);
        const off = app.bus.on('tracking', (f) => {
          const p = f.pose?.landmarks;
          if (!p) return;
          const l = p[15].y < p[11].y - 0.03 && (p[15].visibility ?? 0) > 0.4;
          const r = p[16].y < p[12].y - 0.03 && (p[16].visibility ?? 0) > 0.4;
          // Count frames where exactly one hand is up; decay the other side.
          if (l && !r) {
            left++;
            right = Math.max(0, right - 1);
          } else if (r && !l) {
            right++;
            left = Math.max(0, left - 1);
          }
          if (left >= 30) done(true);
          else if (right >= 30) done(false);
        });
      });
      checking = false;
      if (result === null) {
        guide.hidden = true;
        if (automatic) toast('左右の確認をスキップしました（「左右判定」ボタンでいつでも実行できます）', 'info', 5000);
        return null;
      }
      setInputMirrored(result);
      text.textContent = result ? '確認しました: このカメラは映像が左右反転しています（自動で補正します）' : '確認しました: このカメラの映像は正常な向きです';
      skip.remove();
      setTimeout(() => (guide.hidden = true), 3000);
      return result;
    };
    s.row(
      s.button('左右判定（右手を上げる）', async () => {
        if (!app.source?.active) throw new Error('カメラを開始してください');
        await orientationCheck(false);
      }),
    );
    s.toggle('ランドマーク表示', true, (v) => {
      this.showOverlay = v;
      this.canvas.hidden = !v;
    });
    // Hides the performer's face in the preview (screenshots, streams) but keeps the overlay sharp.
    const blurPreview = localStore.get(BLUR_KEY) === '1';
    this.preview.classList.toggle('blurred', blurPreview);
    s.toggle('カメラ映像をぼかす（スクリーンショット・配信用）', blurPreview, (v) => {
      this.preview.classList.toggle('blurred', v);
      localStore.set(BLUR_KEY, v ? '1' : '0');
    });
    s.row(
      s.button('正面キャリブレーション', () => {
        if (app.calibrate()) toast('現在の顔の向きを正面として登録しました');
        else toast('顔が検出されていません', 'warn');
      }),
      s.button('解除', () => app.resetCalibration()),
    );
    s.text('画面を正面から見た状態で「正面キャリブレーション」を押すと、カメラ位置のずれ・視線・無表情時の癖を補正します。');
    const auto = s.toggle('カメラ開始時に自動で正面補正', true, () => {});
    // Auto-calibrate once per camera start, after the face has been steady for ~1 s.
    app.bus.on('source', (src) => {
      if (src && auto.checked) rearm();
      else pending = false;
    });
    app.bus.on('avatarSpace', (space) => {
      if (!pending) return;
      const q = space.head?.rotation;
      if (!q) {
        steady = 0;
        return;
      }
      steady = prev && prev.angleTo(q) < 0.03 ? steady + 1 : 0;
      prev = q.clone();
      if (steady >= 45 && app.calibrate()) {
        pending = false;
        toast('正面を自動補正しました（ずれる場合は画面を見て「正面キャリブレーション」）');
      }
    });

    // ---------------------------------------------------------------- tracking
    const t = app.panel.section('モーショントラッキング', `MediaPipe (${app.trackers.delegate})`);
    for (const tracker of app.trackers.trackers) {
      const label = { face: '顔・表情・視線', pose: '上半身・腕', hands: '手・指' }[tracker.id] ?? tracker.id;
      t.toggle(label, tracker.enabled, (v) => (tracker.enabled = v));
    }
    const legs = t.toggle('全身（脚・腰）', app.solver.body.options.legs, (v) => {
      app.solver.body.options.legs = v;
      app.smoother.reset();
    });
    const autoFraming = t.toggle('Gemini の構図判定で全身モードを自動切替', true, () => {});
    app.bus.on('ai:spatial', (res) => {
      if (!autoFraming.checked || res.framing === 'none') return;
      const full = res.framing === 'fullBody';
      if (legs.checked !== full) {
        legs.checked = full;
        app.solver.body.options.legs = full;
        toast(`構図「${res.framing}」を検出: 全身モードを${full ? '有効' : '無効'}にしました`);
      }
    });
    const pose = app.trackers.get<PoseTracker>('pose');
    if (pose) {
      t.select(
        'ポーズモデル',
        [
          { value: 'full', label: 'full（高精度）' },
          { value: 'lite', label: 'lite（高速）' },
        ],
        pose.variant,
        async (v) => {
          pose.variant = v;
          await app.trackers.reinit(pose);
        },
      );
    }
    const hands = app.trackers.get<HandTracker>('hands');
    if (hands) {
      t.range('手の検出間隔（フレーム）', 1, 4, 1, hands.interval, (v) => (hands.interval = v));
    }
    t.range('視線の強さ', 0, 30, 1, app.solver.face.calibration.gazeYaw, (v) => {
      app.solver.face.calibration.gazeYaw = v;
      app.solver.face.calibration.gazePitch = v * 0.66;
    });
    t.toggle('表情の左右を入れ替える（ウインクが逆になる場合）', app.coords.options.blendshapeImageSides, (v) => {
      app.coords.options.blendshapeImageSides = v;
    });
  }

  private attachVideo(video: HTMLVideoElement): void {
    this.preview.querySelector('video')?.remove();
    video.className = 'preview-video';
    this.preview.prepend(video);
    this.preview.hidden = false;
  }

  private draw(frame: TrackingFrame): void {
    if (!this.showOverlay) return;
    const c = this.canvas;
    if (c.width !== frame.width) {
      c.width = frame.width;
      c.height = frame.height;
    }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    const W = c.width;
    const H = c.height;
    const line = (pts: Landmark[], edges: number[][], color: string, w = 3) => {
      g.strokeStyle = color;
      g.lineWidth = w;
      g.beginPath();
      for (const [a, b] of edges) {
        const p = pts[a];
        const q = pts[b];
        if (!p || !q || (p.visibility ?? 1) < 0.3 || (q.visibility ?? 1) < 0.3) continue;
        g.moveTo(p.x * W, p.y * H);
        g.lineTo(q.x * W, q.y * H);
      }
      g.stroke();
    };
    if (frame.pose) line(frame.pose.landmarks, POSE_EDGES, '#7cc4ff', 4);
    for (const h of frame.hands) line(h.landmarks, HAND_EDGES, h.side === 'left' ? '#ffc46b' : '#9ef0b0', 3);
    if (frame.face) {
      const lm = frame.face.landmarks;
      line(lm, FACE_OUTLINE.slice(1).map((v, i) => [FACE_OUTLINE[i], v]), '#ff9bd2', 2);
    }
    // Gemini Robotics-ER points (fade out after 6 s)
    if (this.spatial) {
      const age = (performance.now() - this.spatial.at) / 1000;
      if (age < 6) {
        g.globalAlpha = 1 - age / 6;
        g.fillStyle = '#ffe14d';
        g.strokeStyle = '#ffe14d';
        g.lineWidth = 2;
        g.font = `${Math.round(H / 26)}px sans-serif`;
        for (const o of this.spatial.res.objects) {
          const [y, x] = o.point;
          g.beginPath();
          g.arc((x / 1000) * W, (y / 1000) * H, 8, 0, Math.PI * 2);
          g.fill();
          if (o.box) {
            const [y0, x0, y1, x1] = o.box;
            g.strokeRect((x0 / 1000) * W, (y0 / 1000) * H, ((x1 - x0) / 1000) * W, ((y1 - y0) / 1000) * H);
          }
          // Text is drawn un-mirrored by flipping locally when the preview is mirrored.
          const tx = (x / 1000) * W + 12;
          const ty = (y / 1000) * H;
          if (this.app.coords.flip) {
            g.save();
            g.translate(tx, ty);
            g.scale(-1, 1);
            g.fillText(o.label, -g.measureText(o.label).width - 24, 0);
            g.restore();
          } else {
            g.fillText(o.label, tx, ty);
          }
        }
        g.globalAlpha = 1;
      }
    }
  }
}
