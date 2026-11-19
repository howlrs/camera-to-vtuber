import type { ImagePayload } from '../../shared/protocol.ts';

/** Stage 0: anything that yields video frames (camera, file, screen, WebRTC, …). */
export interface FrameSource {
  readonly label: string;
  readonly video: HTMLVideoElement;
  readonly active: boolean;
  start(): Promise<void>;
  stop(): void;
}

function makeVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  v.playsInline = true;
  v.muted = true;
  v.autoplay = true;
  return v;
}

export interface CameraOptions {
  deviceId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
}

export class CameraSource implements FrameSource {
  readonly video = makeVideo();
  private stream: MediaStream | null = null;
  label = 'camera';

  constructor(private readonly options: CameraOptions = {}) {}

  static async listDevices(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  get active(): boolean {
    return !!this.stream?.active;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('getUserMedia が使えません。http://localhost で開いているか確認してください');
    }
    const { deviceId, width = 1280, height = 720, frameRate = 30 } = this.options;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: frameRate },
      },
    });
    this.label = this.stream.getVideoTracks()[0]?.label || 'camera';
    this.video.srcObject = this.stream;
    await this.video.play();
    await waitForSize(this.video);
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

/** Plays a local video file in a loop — handy for testing without a camera. */
export class VideoFileSource implements FrameSource {
  readonly video = makeVideo();
  label: string;
  private url: string;

  constructor(file: File) {
    this.label = file.name;
    this.url = URL.createObjectURL(file);
  }

  get active(): boolean {
    return !this.video.paused;
  }

  async start(): Promise<void> {
    this.video.src = this.url;
    this.video.loop = true;
    await this.video.play();
    await waitForSize(this.video);
  }

  stop(): void {
    this.video.pause();
    URL.revokeObjectURL(this.url);
  }
}

function waitForSize(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
}

/** Downscaled JPEG of the current frame for Gemini (unmirrored, as the camera sees it). */
export function grabFrame(source: FrameSource, maxWidth = 640, quality = 0.75): ImagePayload | null {
  const v = source.video;
  if (!v.videoWidth) return null;
  const scale = Math.min(1, maxWidth / v.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(v.videoWidth * scale);
  canvas.height = Math.round(v.videoHeight * scale);
  canvas.getContext('2d')!.drawImage(v, 0, 0, canvas.width, canvas.height);
  return dataUrlToPayload(canvas.toDataURL('image/jpeg', quality));
}

export function dataUrlToPayload(dataUrl: string): ImagePayload {
  const [head, data] = dataUrl.split(',', 2);
  const mimeType = head.match(/data:([^;]+)/)?.[1] ?? 'image/png';
  return { data, mimeType };
}

export function payloadToDataUrl(p: ImagePayload): string {
  return `data:${p.mimeType};base64,${p.data}`;
}
