/**
 * Audio plumbing:
 *  - PcmPlayer: gapless playback of PCM16 chunks (Gemini Live / TTS) through an analyser
 *  - LipSync: analyser -> VRM visemes (aa/ih/ou/ee/oh) via formant-band energy heuristics
 *  - MicCapture: microphone -> 16 kHz PCM16 base64 chunks (Gemini Live input)
 */

export function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return new Int16Array(buf, 0, bin.length >> 1);
}

export function int16ToBase64(data: Int16Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export class PcmPlayer {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  readonly output: GainNode;
  private playhead = 0;
  private sources = new Set<AudioBufferSourceNode>();

  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext();
    this.output = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.5;
    this.output.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  set muted(m: boolean) {
    this.output.gain.value = m ? 0 : 1;
  }

  /** True while queued audio is still playing. */
  get playing(): boolean {
    return this.playhead > this.ctx.currentTime;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  enqueue(pcm: Int16Array, sampleRate: number): void {
    if (!pcm.length) return;
    const buffer = this.ctx.createBuffer(1, pcm.length, sampleRate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.output);
    const start = Math.max(this.playhead, this.ctx.currentTime + 0.03);
    src.start(start);
    this.playhead = start + buffer.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** Stop immediately (barge-in / interruption). */
  interrupt(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.playhead = this.ctx.currentTime;
  }
}

export interface Visemes {
  aa: number;
  ih: number;
  ou: number;
  ee: number;
  oh: number;
}

/**
 * Lightweight vowel estimation from the spectrum: speech level from RMS, vowel class from the
 * balance of F1 (300-900 Hz) and F2 (900-2600 Hz) band energies. Not phoneme-accurate, but
 * reads naturally for anime-style mouths.
 */
export class LipSync {
  private freq: Uint8Array<ArrayBuffer>;
  private time: Float32Array<ArrayBuffer>;
  private level = 0;
  gain = 1.6;

  constructor(private readonly analyser: AnalyserNode) {
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Float32Array(analyser.fftSize);
  }

  sample(): { visemes: Visemes; level: number } {
    this.analyser.getFloatTimeDomainData(this.time);
    let sum = 0;
    for (const v of this.time) sum += v * v;
    const rms = Math.sqrt(sum / this.time.length);
    const target = Math.min(1, Math.max(0, (rms - 0.01) * 6 * this.gain));
    this.level += (target - this.level) * (target > this.level ? 0.6 : 0.25);

    this.analyser.getByteFrequencyData(this.freq);
    const hz = this.analyser.context.sampleRate / this.analyser.fftSize;
    const band = (lo: number, hi: number) => {
      let s = 0;
      const a = Math.floor(lo / hz);
      const b = Math.min(this.freq.length - 1, Math.ceil(hi / hz));
      for (let i = a; i <= b; i++) s += this.freq[i];
      return s / Math.max(1, b - a + 1) / 255;
    };
    const f1 = band(300, 900);
    const f2 = band(900, 2600);
    const total = f1 + f2 + 1e-6;
    const brightness = f2 / total; // high -> i/e, low -> o/u
    const openness = Math.min(1, f1 * 2.2); // high F1 -> open vowels (a)

    const l = this.level;
    const visemes: Visemes = {
      aa: l * openness * (1 - Math.abs(brightness - 0.45) * 1.5),
      ee: l * clamp((brightness - 0.45) * 3) * openness,
      ih: l * clamp((brightness - 0.55) * 3) * (1 - openness * 0.5),
      oh: l * clamp((0.42 - brightness) * 3) * openness,
      ou: l * clamp((0.38 - brightness) * 3) * (1 - openness * 0.5),
    };
    for (const k of Object.keys(visemes) as (keyof Visemes)[]) visemes[k] = clamp(visemes[k]);
    return { visemes, level: l };
  }
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.len = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.push(new Float32Array(ch));
      this.len += ch.length;
      if (this.len >= 1600) { // 100 ms @ 16 kHz
        const out = new Float32Array(this.len);
        let o = 0;
        for (const b of this.buf) { out.set(b, o); o += b.length; }
        this.port.postMessage(out, [out.buffer]);
        this.buf = []; this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', Capture);
`;

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  onChunk: ((base64Pcm16: string, level: number) => void) | null = null;

  get active(): boolean {
    return !!this.ctx;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // A 16 kHz context makes the browser resample the mic for us.
    this.ctx = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const f = e.data;
      let peak = 0;
      for (const v of f) peak = Math.max(peak, Math.abs(v));
      this.onChunk?.(int16ToBase64(floatToInt16(f)), peak);
    };
    src.connect(this.node);
  }

  stop(): void {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.stream = null;
  }
}
