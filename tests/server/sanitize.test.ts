import { describe, expect, it } from 'vitest';
import type { MaterialInfo } from '../../shared/protocol.ts';
import { sanitizeStyle } from '../../server/gemini/designer.ts';
import { sanitizeReaction } from '../../server/gemini/reactor.ts';
import { sanitizeSpatial } from '../../server/gemini/spatial.ts';
import { extractPcm, parseSampleRate } from '../../server/gemini/tts.ts';
import { validateToolCall } from '../../server/gemini/live.ts';

const mats: MaterialInfo[] = [
  { name: 'Hair', category: 'HAIR', baseColor: '#000000', hasTexture: true },
  { name: 'Eye', category: 'EYE', baseColor: '#ffffff', hasTexture: false },
];

describe('sanitizeStyle', () => {
  it('drops unknown materials, bad colors, textureEdits on untextured materials, clamps bias', () => {
    const s = sanitizeStyle(
      {
        persona: { name: 'A', voice: 'NotAVoice' },
        materials: [
          { name: 'Hair', color: '#FF0000', rimColor: 'red' },
          { name: 'Ghost', color: '#ffffff' },
          { name: 'Eye', color: 'bad' },
          { name: 'Hair', color: '#00ff00' },
        ],
        textureEdits: [
          { material: 'Eye', prompt: 'x' },
          { material: 'Hair', prompt: 'blue' },
          { material: 'Ghost', prompt: 'y' },
        ],
        accessories: [{ type: 'catEars', color: '#abc' }, { type: 'jetpack', color: '#ffffff' }, { type: 'catEars', color: '#ffffff' }],
        expressionBias: { happy: 5, angry: -1, sad: 'x' },
        stage: { lightColor: 'nope' },
      },
      mats,
    );
    expect(s.persona.voice).toBe('Kore');
    expect(s.materials).toEqual([{ name: 'Hair', color: '#ff0000' }]);
    expect(s.textureEdits).toEqual([{ material: 'Hair', prompt: 'blue' }]);
    expect(s.accessories).toEqual([{ type: 'catEars', color: '#ffffff' }]);
    expect(s.expressionBias.happy).toBe(0.3);
    expect(s.expressionBias.angry).toBe(0);
    expect(s.expressionBias.sad).toBe(0);
    expect(s.stage.lightColor).toBe('#ffffff');
  });
  it('limits textureEdits to 3 and survives garbage', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `M${i}`, category: 'CLOTH' as const, baseColor: '#ffffff', hasTexture: true }));
    const s = sanitizeStyle({ textureEdits: many.map((m) => ({ material: m.name, prompt: 'p' })) }, many);
    expect(s.textureEdits).toHaveLength(3);
    expect(() => sanitizeStyle(null, mats)).not.toThrow();
  });
});

describe('sanitizeReaction', () => {
  it('validates enums, clamps intensity, truncates caption', () => {
    const r = sanitizeReaction({ emotion: 'ecstatic', intensity: 3, gesture: 'wave', caption: 'あ'.repeat(80) });
    expect(r).toMatchObject({ emotion: 'neutral', intensity: 1, gesture: 'wave' });
    expect(Array.from(r.caption)).toHaveLength(40);
    expect(sanitizeReaction(undefined)).toEqual({ emotion: 'neutral', intensity: 0, gesture: 'none', caption: '' });
  });
});

describe('sanitizeSpatial', () => {
  it('clamps coordinates, normalizes boxes, drops invalid entries', () => {
    const s = sanitizeSpatial({
      framing: 'closeup',
      objects: [
        { label: 'cup', point: [1200, -5], box: [900, 800, 100, 50], heldBy: 'right' },
        { label: 'bad', point: 'x', heldBy: 'left' },
        { label: 'boxonly', box: [0, 0, 100, 200], heldBy: 'nobody' },
      ],
      keypoints: [{ label: 'nose', point: [500.4, 400.6] }, { label: 'x', point: [1] }],
    });
    expect(s.framing).toBe('none');
    expect(s.objects[0]).toEqual({ label: 'cup', point: [1000, 0], box: [100, 50, 900, 800], heldBy: 'right' });
    expect(s.objects[1]).toEqual({ label: 'boxonly', point: [50, 100], box: [0, 0, 100, 200], heldBy: 'none' });
    expect(s.objects).toHaveLength(2);
    expect(s.keypoints).toEqual([{ label: 'nose', point: [500, 401] }]);
  });
});

describe('tts helpers', () => {
  it('parses sample rate', () => {
    expect(parseSampleRate('audio/L16;codec=pcm;rate=24000')).toBe(24000);
    expect(parseSampleRate('audio/L16;rate=16000')).toBe(16000);
    expect(parseSampleRate(undefined)).toBe(24000);
  });
  it('strips a WAV header', () => {
    const pcm = Buffer.from([1, 0, 2, 0]);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(22050, 24); h.write('data', 36); h.writeUInt32LE(4, 40);
    const out = extractPcm(Buffer.concat([h, pcm]), 'audio/wav');
    expect(out.sampleRate).toBe(22050);
    expect(out.pcm.equals(pcm)).toBe(true);
  });
});

describe('validateToolCall', () => {
  it('accepts valid and rejects invalid calls', () => {
    expect(validateToolCall('set_expression', { emotion: 'happy', intensity: 9 })).toEqual({ name: 'set_expression', args: { emotion: 'happy', intensity: 1 } });
    expect(validateToolCall('set_expression', { emotion: 'meh', intensity: 1 })).toBeNull();
    expect(validateToolCall('play_gesture', { gesture: 'wave' })).not.toBeNull();
    expect(validateToolCall('show_caption', { text: 'x'.repeat(100) })).toMatchObject({ args: { text: 'x'.repeat(40) } });
    expect(validateToolCall('rm_rf', {})).toBeNull();
  });
});
