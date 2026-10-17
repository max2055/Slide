import { describe, expect, it } from 'vitest';
import { compareAttention, scoreAttention, type AttentionSeverity } from './scoring.js';
describe('B08 fixed weight bounded score', () => {
  it('uses 50/20/15/15 without redistributing missing weights', () => {
    expect(scoreAttention({ severity: 'critical', impact: 1, persistence: 1, baseline: 1 })).toMatchObject({ lower: 100, upper: 100, coverage: 1 });
    expect(scoreAttention({ severity: 'critical', impact: null, persistence: 0.5, baseline: null })).toEqual({ lower: 57.5, upper: 92.5, coverage: 0.65,
      components: { severity: 50, impact: null, persistence: 7.5, baseline: null } });
    expect(scoreAttention({ severity: 'critical', impact: null, persistence: null, baseline: null })).toMatchObject({ lower: 50, upper: 100, coverage: 0.5 });
  });
  it('keeps unknown critical above fully measured error and orders deterministic ties', () => {
    const item = (severity: AttentionSeverity, measured: boolean, id: string, firstObservedAt = '2026-10-17T00:00:00.000Z') => ({ severity, id, firstObservedAt,
      score: scoreAttention({ severity, impact: measured ? 1 : null, persistence: measured ? 1 : null, baseline: measured ? 1 : null }) });
    const values = [item('error', true, 'a'), item('critical', false, 'c'), item('critical', false, 'b'), item('critical', false, 'd', '2026-10-16T00:00:00.000Z')];
    expect(values.sort(compareAttention).map(i => i.id)).toEqual(['d', 'b', 'c', 'a']);
  });
  it.each([-1, 1.01, Infinity, NaN, undefined])('rejects non-normalized fact %s', value => {
    expect(() => scoreAttention({ severity: 'warning', impact: value as number, persistence: null, baseline: null })).toThrow('OPERATIONS_INPUT_INVALID');
  });
});
