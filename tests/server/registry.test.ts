import { describe, expect, it } from 'vitest';
import { resolveAssignments, type ModelsConfig } from '../../server/gemini/registry.ts';

const config: ModelsConfig = {
  roles: {
    designer: { purpose: 'd', candidates: ['a', 'b', 'c'] },
    imageFast: { purpose: 'i', candidates: ['x', 'y'] },
  },
};
const get = (r: ReturnType<typeof resolveAssignments>, role: string) => r.find((a) => a.role === role)!;

describe('resolveAssignments', () => {
  it('picks the first available candidate in order', () => {
    const r = resolveAssignments(config, new Set(['c', 'b', 'y']));
    expect(get(r, 'designer').model).toBe('b');
    expect(get(r, 'imageFast').model).toBe('y');
    expect(get(r, 'designer').source).toBe('config');
  });
  it('env override wins (role matched case-insensitively, models/ prefix stripped)', () => {
    const r = resolveAssignments(config, new Set(['a']), { VTUBER_MODEL_IMAGEFAST: 'models/custom', VTUBER_MODEL_DESIGNER: 'zzz' });
    expect(get(r, 'imageFast')).toMatchObject({ model: 'custom', source: 'env' });
    expect(get(r, 'designer')).toMatchObject({ model: 'zzz', source: 'env' });
  });
  it('returns null when nothing is available', () => {
    const r = resolveAssignments(config, new Set(['nope']));
    expect(get(r, 'designer').model).toBeNull();
  });
  it('uses the first candidate unverified when the list is unavailable', () => {
    expect(get(resolveAssignments(config, null), 'designer').model).toBe('a');
  });
});
