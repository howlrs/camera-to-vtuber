import type { Emotion } from '../../shared/protocol.ts';

/**
 * Combines expression sources into final VRM expression weights:
 *   tracked face (camera)  +  AI emotion hints (Gemini Live / reactor)  +  persona bias
 *   + lip-sync visemes (avatar voice) which override the tracked mouth while speaking.
 */

const EMOTION_KEYS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;

interface Hint {
  emotion: Exclude<Emotion, 'neutral'>;
  intensity: number;
  until: number;
  source: string;
}

export class ExpressionMixer {
  /** How strongly AI hints may push an emotion (0..1). */
  aiWeight = 0.8;
  bias: Record<(typeof EMOTION_KEYS)[number], number> = { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 };
  private hints: Hint[] = [];
  private visemes = new Map<string, number>();
  private speaking = 0;

  /** Register an AI emotion hint; `neutral` clears active hints. */
  hint(emotion: Emotion, intensity: number, durationSec: number, now: number, source = 'ai'): void {
    if (emotion === 'neutral') {
      this.hints = [];
      return;
    }
    this.hints = this.hints.filter((h) => h.emotion !== emotion);
    this.hints.push({ emotion, intensity: Math.min(1, Math.max(0, intensity)), until: now + durationSec, source });
  }

  /** Lip-sync visemes from the avatar's own voice (TTS / Live audio), plus speech level 0..1. */
  setVoice(visemes: Partial<Record<(typeof VISEMES)[number], number>>, level: number): void {
    for (const v of VISEMES) this.visemes.set(v, visemes[v] ?? 0);
    this.speaking = level;
  }

  activeHints(now: number): Hint[] {
    return this.hints.filter((h) => h.until > now);
  }

  mix(tracked: Map<string, number>, now: number): Map<string, number> {
    this.hints = this.hints.filter((h) => h.until > now);
    const out = new Map(tracked);

    for (const key of EMOTION_KEYS) {
      const hint = this.hints.find((h) => h.emotion === key);
      // Fade the last 0.6 s of a hint so expressions don't snap.
      const fade = hint ? Math.min(1, (hint.until - now) / 0.6) : 0;
      const ai = hint ? hint.intensity * this.aiWeight * fade : 0;
      out.set(key, Math.min(1, Math.max(tracked.get(key) ?? 0, ai) + this.bias[key]));
    }
    // Keep a single dominant emotion readable.
    const dominant = Math.max(...EMOTION_KEYS.map((k) => out.get(k) ?? 0));
    for (const key of EMOTION_KEYS) {
      const v = out.get(key) ?? 0;
      if (v < dominant) out.set(key, v * (1 - dominant * 0.7));
    }

    if (this.speaking > 0.02) {
      const w = Math.min(1, this.speaking * 3);
      for (const v of VISEMES) {
        out.set(v, (out.get(v) ?? 0) * (1 - w) + (this.visemes.get(v) ?? 0) * w);
      }
    }
    // Strong happy/surprised expressions usually already close/open the eyes in VRM models.
    const happy = out.get('happy') ?? 0;
    if (happy > 0.5) {
      out.set('blinkLeft', (out.get('blinkLeft') ?? 0) * (1 - happy));
      out.set('blinkRight', (out.get('blinkRight') ?? 0) * (1 - happy));
    }
    return out;
  }
}
