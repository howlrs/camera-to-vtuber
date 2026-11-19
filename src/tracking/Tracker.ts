import type { FilesetResolver } from '@mediapipe/tasks-vision';
import type { TrackingFrame } from '../core/types.ts';

/**
 * Stage 1: a tracker turns a video frame into observations written into a TrackingFrame.
 * Trackers are independent; add a new one (e.g. an object detector, gaze model, or a remote
 * tracker) by implementing this interface and registering it with the TrackerHost.
 */
export interface Tracker {
  readonly id: string;
  enabled: boolean;
  /** Run detection every N frames (1 = every frame). Skipped frames keep the last result. */
  interval: number;
  init(ctx: TrackerInitContext): Promise<void>;
  detect(video: HTMLVideoElement, timestamp: number, out: TrackingFrame): void;
  close(): void;
}

export type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

export interface TrackerInitContext {
  fileset: WasmFileset;
  delegate: 'GPU' | 'CPU';
  modelBase: string;
}
