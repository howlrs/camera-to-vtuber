import { FilesetResolver } from '@mediapipe/tasks-vision';
import type { TrackingFrame } from '../core/types.ts';
import type { Tracker } from './Tracker.ts';

/**
 * Owns the MediaPipe WASM runtime and runs registered trackers on each new video frame.
 * GPU delegate is tried first; on failure every tracker is re-created on CPU.
 */
export class TrackerHost {
  readonly trackers: Tracker[] = [];
  delegate: 'GPU' | 'CPU' = 'GPU';
  private lastVideoTime = -1;
  private lastTs = 0;

  constructor(
    private readonly wasmBase = '/mediapipe/wasm',
    private readonly modelBase = '/models',
  ) {}

  add(tracker: Tracker): this {
    this.trackers.push(tracker);
    return this;
  }

  get<T extends Tracker>(id: string): T | undefined {
    return this.trackers.find((t) => t.id === id) as T | undefined;
  }

  async init(onStatus?: (msg: string) => void): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(this.wasmBase);
    for (const delegate of ['GPU', 'CPU'] as const) {
      try {
        for (const t of this.trackers) {
          onStatus?.(`${t.id} モデル読込中 (${delegate})…`);
          await t.init({ fileset, delegate, modelBase: this.modelBase });
        }
        this.delegate = delegate;
        return;
      } catch (err) {
        console.warn(`[tracker] ${delegate} init failed`, err);
        this.trackers.forEach((t) => t.close());
        if (delegate === 'CPU') throw err;
      }
    }
  }

  /** Re-initialise a single tracker (e.g. after switching the pose model variant). */
  async reinit(tracker: Tracker): Promise<void> {
    tracker.close();
    const fileset = await FilesetResolver.forVisionTasks(this.wasmBase);
    await tracker.init({ fileset, delegate: this.delegate, modelBase: this.modelBase });
  }

  /** Returns null when the video has no new frame since the last call. */
  process(video: HTMLVideoElement): TrackingFrame | null {
    if (video.readyState < 2 || video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;
    // MediaPipe requires strictly increasing timestamps (ms).
    const ts = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = ts;
    const frame: TrackingFrame = {
      timestamp: ts,
      width: video.videoWidth,
      height: video.videoHeight,
      face: null,
      pose: null,
      hands: [],
      timings: {},
    };
    // Pose runs before hands so hand sides can be matched to pose wrists.
    for (const t of this.trackers) {
      if (!t.enabled) continue;
      const t0 = performance.now();
      try {
        t.detect(video, ts, frame);
      } catch (err) {
        console.error(`[tracker] ${t.id} failed`, err);
      }
      frame.timings[t.id] = performance.now() - t0;
    }
    return frame;
  }

  close(): void {
    this.trackers.forEach((t) => t.close());
  }
}
