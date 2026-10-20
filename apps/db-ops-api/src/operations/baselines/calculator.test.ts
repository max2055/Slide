/** Synthetic windows test boundaries, never real observation qualification. */
import { describe, expect, it } from 'vitest';
import { calculateBaseline, invalidateBaseline } from './calculator.js';
import { DAY } from './source-adapter.js';
import { syntheticInput, syntheticWindow } from './test-support.js';

describe('P04 B06 synthetic temporal qualification', () => {
  it.each(['daily', 'weekly'] as const)('%s isolates final seven days and enforces repeat cycles', mode => {
    const input = { ...syntheticInput, mode }, source = syntheticWindow(mode), result = calculateBaseline(input, source);
    expect(result).toMatchObject({ status: 'known', state: 'qualified', quality: { coverage: 1, validDays: mode === 'daily' ? 14 : 28 } });
    expect(Date.parse(result.validation.until) - Date.parse(result.validation.from)).toBe(7 * DAY);
    expect(result.training.until).toBe(result.validation.from);
    expect(result.referenceBands).toHaveLength(mode === 'daily' ? 24 : 168);
    expect(result.referenceBands.every(b => b.repeats === (mode === 'daily' ? 7 : 3))).toBe(true);
    expect(result.temporalReport).toMatchObject({ status: 'evaluated', samples: 168, labelledSamples: 0, falsePositiveRate: null, improvement: 'not_established' });
  });
  it('does not leak holdout anomalies into training or change static thresholds', () => {
    const source = syntheticWindow();
    source.buckets.at(-1)!.value = { encoding: 'float64', value: 99 }; source.latest.value = 99;
    const result = calculateBaseline(syntheticInput, source);
    expect(result.referenceBands.every(b => b.median === 40 && b.upper === 40)).toBe(true);
    expect(result.comparison).toMatchObject({ baselineAnomaly: true, staticAnomaly: true, deviation: 59 });
    expect(result.temporalReport).toMatchObject({ baselineFlags: 1, staticFlags: 1 });
    expect(syntheticInput.staticThreshold!.value).toBe(80);
  });
  it('invalidates sustained holdout drift instead of learning the new level as normal', () => {
    const source = syntheticWindow(); for (const b of source.buckets.slice(-168)) b.value = { encoding: 'float64', value: 90 };
    expect(calculateBaseline(syntheticInput, source)).toMatchObject({ state: 'invalidated', reason: 'severe_drift', referenceBands: [], comparison: { baselineAnomaly: null } });
  });
  it('requires the full 14/28 days, never stretches short windows', () => {
    const source = syntheticWindow(); source.from = new Date(Date.parse(source.from) + DAY).toISOString();
    expect(calculateBaseline(syntheticInput, source).reason).toBe('observation_window');
    expect(calculateBaseline({ ...syntheticInput, mode: 'weekly' }, syntheticWindow()).reason).toBe('observation_window');
  });
  it('preserves the independent static comparison when fresh measurements lack baseline history', () => {
    const source = syntheticWindow(); source.buckets = []; source.latest.value = 99;
    expect(calculateBaseline(syntheticInput, source)).toMatchObject({ status: 'unknown', comparison: { baselineAnomaly: null },
      staticComparison: { status: 'known', anomaly: true, value: 99, threshold: { operator: '>', value: 80 } } });
  });
  it('90 percent is inclusive; partial coverage is not interpolated', () => {
    const source = syntheticWindow(); for (const b of source.buckets) { b.coverage = .9; b.quality = { status: 'partial', reason: 'gap' }; }
    expect(calculateBaseline(syntheticInput, source).status).toBe('known');
    for (const b of source.buckets) b.coverage = .8999;
    expect(calculateBaseline(syntheticInput, source)).toMatchObject({ status: 'unknown', reason: 'long_gap' });
  });
  it('high global coverage cannot hide a missing repeated hour or a six hour break', () => {
    const source = syntheticWindow(); source.buckets.splice(0, 1);
    expect(calculateBaseline(syntheticInput, source).reason).toBe('insufficient_repeated_periods');
    source.buckets.splice(0, 5);
    expect(calculateBaseline(syntheticInput, source).reason).toBe('long_gap');
  });
  it('training and holdout coverage are checked independently', () => {
    const source = syntheticWindow('weekly');
    // One hour each day in holdout is insufficient repetition in weekly mode;
    // four scattered missing hours/day also takes holdout below 90%.
    source.buckets = source.buckets.filter((_, i) => i < 21 * 24 || i % 6 !== 0);
    expect(calculateBaseline({ ...syntheticInput, mode: 'weekly' }, source).reason).toBe('coverage_below_90_percent');
  });
  it.each(['stale_observation', 'future_observation', 'series_identity_changed', 'counter_reset', 'observation_quality', 'late_collection'])('fails closed for %s', reason => {
    const source = syntheticWindow(); source.reason = reason;
    expect(calculateBaseline(syntheticInput, source)).toMatchObject({ status: 'unknown', state: 'invalidated', reason, referenceBands: [] });
  });
  it('rejects duplicate buckets and precision loss; zero is still a valid value', () => {
    const source = syntheticWindow(); source.buckets.push(source.buckets[0]);
    expect(calculateBaseline(syntheticInput, source).reason).toBe('bucket_window'); source.buckets.pop();
    for (const b of source.buckets) b.value = { encoding: 'float64', value: 0 }; source.latest.value = 0;
    expect(calculateBaseline(syntheticInput, source).comparison).toMatchObject({ value: 0, baselineAnomaly: false, deviationRatio: null });
    source.buckets[0].accuracy = 'estimated';
    expect(calculateBaseline(syntheticInput, source).status).toBe('unknown');
  });
  it('removes outward numeric references after invalidation and retains immutable input', () => {
    const result = calculateBaseline(syntheticInput, syntheticWindow());
    expect(invalidateBaseline(result, 'expired')).toMatchObject({ status: 'unknown', comparison: { value: null, baselineAnomaly: null }, referenceBands: [] });
    expect(result.status).toBe('known'); expect(result.referenceBands).toHaveLength(24);
  });
});
