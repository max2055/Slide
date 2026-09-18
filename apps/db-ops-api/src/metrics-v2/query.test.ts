import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { definitions, identify, sample } from '../contracts/metrics-v2/fixtures.js';
import type { MetricDefinition, NormalizedObservation } from '../contracts/metrics-v2/index.js';
import { aggregate, SemanticQueryService, type SemanticQuery } from './query.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../docs/slide/metrics-v2/aggregation/fixtures.json', import.meta.url), 'utf8'));
const base = Date.parse('2026-09-01T00:00:00Z');
const stamp = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const gauge: MetricDefinition = { ...definitions[0], aggregation: { ...definitions[0].aggregation,
  min_coverage: 0.5, space: ['none', 'sum', 'weighted_mean'] } };
const counter: MetricDefinition = { ...definitions[3], aggregation: { ...definitions[3].aggregation, min_coverage: 0.5 } };
const reference = (d: MetricDefinition) => sample(definitions.some(x => x.id === d.id) ? d.id : 'db.uptime_seconds');
const series = (d: MetricDefinition, row = reference(d)) => ({ resource_type: row.resource_type, resource_id: row.resource_id,
  metric: { id: d.id, semantic_version: d.semantic_version }, dimensions: row.dimensions });
const point = (d: MetricDefinition, seconds: number, value: NormalizedObservation['value'], options: Partial<NormalizedObservation> = {}): NormalizedObservation => {
  const origin = reference(d);
  return identify({ ...origin, metric: { id: d.id, semantic_version: d.semantic_version }, unit: d.unit,
    observed_at: stamp(seconds), collected_at: stamp(seconds), stored_at: stamp(60), value,
    source: { ...origin.source, attempt_id: `fixture-${seconds}` }, ...options });
};
const query = (d: MetricDefinition, mode: SemanticQuery['mode'], from = 0, to = 40): SemanticQuery => ({
  definition: d, series: [series(d)], from: stamp(from), to: stamp(to), now: stamp(45),
  interval_ms: fixture.interval_ms, max_gap_ms: 30000, stale_after_ms: 30000, mode, space: 'none',
});
const scalar = (bucket: ReturnType<typeof aggregate>[number]) => bucket.value && 'value' in bucket.value ? Number(bucket.value.value) : null;

describe('semantic V2 reducer', () => {
  it('separates sample mean and time-weighted gauge; window and downsample use identical rules', () => {
    const rows = fixture.gauge.seconds.map((s: number, i: number) => point(gauge, s, { encoding: 'float64', value: fixture.gauge.values[i] }));
    expect(scalar(aggregate(query(gauge, 'mean'), [rows])[0])).toBeCloseTo(fixture.gauge.sample_mean);
    const weighted = { ...query(gauge, 'mean'), weighting: 'time' as const };
    expect(scalar(aggregate(weighted, [rows])[0])).toBe(fixture.gauge.weighted_mean);
    const buckets = aggregate({ ...weighted, bucket_ms: 20000 }, [rows]);
    expect(buckets.map(scalar)).toEqual(fixture.gauge.weighted_buckets);
    expect(buckets.map(b => b.coverage)).toEqual([1, 1]);
    expect(buckets[0]).toMatchObject({ contract_version: '1.0.0', unit: 's', metric: { id: gauge.id }, freshness: 'stale' });
    expect(buckets[0].sources).toHaveLength(2);
    expect(buckets[0].window).toEqual({ from: stamp(0), to: stamp(20) });
    expect(() => aggregate({ ...weighted, mode: 'last' }, [rows])).toThrow('QUERY_WEIGHTING');
  });

  it('processes each counter reset before clipping intervals across bucket boundaries', () => {
    const rows = fixture.counter.seconds.map((s: number, i: number) => point(counter, s,
      { encoding: 'uint64', value: String(fixture.counter.values[i]) },
      { counter: { start_at: stamp(s >= 20 ? 20 : 0), bits: '64' } }));
    const q = query(counter, 'rate', ...fixture.counter.window_seconds);
    const total = aggregate(q, [rows])[0];
    expect(scalar(total)).toBe(fixture.counter.rate);
    expect(total.coverage).toBeCloseTo(fixture.counter.covered_seconds / 30);
    expect(total.unit).toBe('By/s');
    expect(aggregate({ ...q, bucket_ms: 10000 }, [rows]).map(scalar)).toEqual(fixture.counter.bucket_rates);
    const withoutEvidence = rows.map((p, i) => i === 2 ? identify({ ...p, counter: { start_at: stamp(0), bits: '64' as const } }) : p);
    expect(aggregate(q, [withoutEvidence])[0]).toMatchObject({ value: null, quality: { reason: 'gap' } });
  });

  it('keeps gaps null below coverage threshold and preserves source freshness', () => {
    const rows = [point(gauge, 0, { encoding: 'float64', value: 2 }), point(gauge, 30, { encoding: 'float64', value: 8 })];
    const buckets = aggregate({ ...query(gauge, 'mean'), bucket_ms: 10000 }, [rows]);
    expect(buckets[1]).toMatchObject({ value: null, coverage: 0, freshness: 'unknown', quality: { reason: 'missing_input' } });
    expect(buckets[0].sample_count).toBe(1);
    const replay = { ...rows[0] };
    expect(aggregate(query(gauge, 'mean'), [[...rows, replay]])[0].sample_count).toBe(2);
    expect(() => aggregate({ ...query(gauge, 'mean'), series: [series(gauge), series(gauge)] }, [rows, rows])).toThrow('QUERY_IDENTITY');
  });

  it('supports last/min/max and explicit spatial weights without mixing semantic identities', () => {
    const first = [point(gauge, 0, { encoding: 'float64', value: 2 }), point(gauge, 10, { encoding: 'float64', value: 4 })];
    const second = [point(gauge, 0, { encoding: 'float64', value: 6 }, { resource_id: 'db-2',
      versions: { ...first[0].versions, package_version: '1.1.0' } }),
    point(gauge, 10, { encoding: 'float64', value: 6 }, { resource_id: 'db-2' })];
    expect(scalar(aggregate(query(gauge, 'last', 0, 20), [first])[0])).toBe(4);
    expect(scalar(aggregate(query(gauge, 'min', 0, 20), [first])[0])).toBe(2);
    expect(scalar(aggregate(query(gauge, 'max', 0, 20), [first])[0])).toBe(4);
    const spatial = { ...query(gauge, 'mean', 0, 20), series: [series(gauge), { ...series(gauge), resource_id: 'db-2' }],
      space: 'weighted_mean' as const, weights: [1, 3] };
    expect(scalar(aggregate(spatial, [first, second])[0])).toBe(5.25);
    expect(aggregate(spatial, [first, second])[0].sources).toHaveLength(4);
    expect(() => aggregate(spatial, [first, [identify({ ...second[0], metric: { ...second[0].metric, semantic_version: '2.0.0' } })]])).toThrow('OBSERVATION_IDENTITY');
    expect(() => aggregate(spatial, [first, [identify({ ...second[0], unit: 'ms' })]])).toThrow('UNIT_CONFLICT');
    expect(() => aggregate({ ...spatial, weights: undefined }, [first, second])).toThrow('SPATIAL_WEIGHTS_REQUIRED');
    expect(() => aggregate({ ...spatial, space: 'none' }, [first, second])).toThrow('SPACE_OPERATION_REQUIRED');
  });

  it('preserves source partial reason and estimated accuracy without inventing precision loss', () => {
    const p = point(gauge, 0, { encoding: 'float64', value: 2 },
      { quality: { status: 'partial', reason: 'partial_input' }, accuracy: 'estimated' });
    const result = aggregate(query(gauge, 'last', 0, 10), [[p]])[0];
    expect(result).toMatchObject({ accuracy: 'estimated', quality: { status: 'partial', reason: 'partial_input' } });
    expect(aggregate({ ...query(gauge, 'last', 0, 10), now: stamp(-1) }, [[p]])[0].freshness).toBe('unknown');
  });

  it('weights ratios by original numerator/denominator and rejects incompatible inputs', () => {
    const numerator = { ...gauge, id: 'db.ratio_numerator', unit: 'count' as const };
    const denominator = { ...gauge, id: 'db.ratio_denominator', unit: 'count' as const };
    const output = { ...gauge, id: 'db.weighted_ratio', unit: '1' as const };
    const row = (d: MetricDefinition, seconds: number, value: number, resource_id = 'db-1') =>
      point(d, seconds, { encoding: 'float64', value }, { resource_id });
    const n = fixture.ratio.numerators.map((v: number, i: number) => row(numerator, i * 10, v));
    const d = fixture.ratio.denominators.map((v: number, i: number) => row(denominator, i * 10, v));
    const q: SemanticQuery = { ...query(output, 'ratio', 0, 30), numerator, denominator };
    expect(scalar(aggregate(q, [n], [d])[0])).toBeCloseTo(fixture.ratio.ratio);
    expect(scalar(aggregate({ ...q, series: [q.series[0], { ...q.series[0], resource_id: 'db-2' }], space: 'sum' },
      [n.slice(0, 2), [row(numerator, 0, 9, 'db-2')]], [d.slice(0, 2), [row(denominator, 0, 10, 'db-2')]])[0])).toBeCloseTo(fixture.ratio.ratio);
    expect(() => aggregate({ ...q, denominator: { ...denominator, unit: 'By' } }, [n], [d])).toThrow('RATIO_INPUT');
    expect(scalar(aggregate(q, [n], [d.map((p, i) => i === 2 ? point(denominator, 20, { encoding: 'float64', value: 0 }) : p)])[0])).toBe(0.5);
    expect(aggregate(q, [[n[0]]], [[point(denominator, 0, { encoding: 'float64', value: 0 })]])[0])
      .toMatchObject({ value: null, quality: { reason: 'invalid_denominator' } });
  });

  it('integrates states with bounded hold, clipping and missing segments', () => {
    const d = { ...gauge, id: 'db.oper_up', unit: '1' as const };
    const rows = fixture.state.seconds.map((s: number, i: number) => point(d, s, { encoding: 'float64', value: fixture.state.values[i] }));
    const result = aggregate({ ...query(d, 'duration', ...fixture.state.window_seconds), state_value: 1 }, [rows])[0];
    expect(scalar(result)).toBe(fixture.state.up_ms);
    expect(result.unit).toBe('ms');
    expect(result.coverage).toBe(1);
    const shortHold = aggregate({ ...query(d, 'duration', 5, 30), state_value: 1, max_gap_ms: 5000 }, [rows])[0];
    expect(shortHold.coverage).toBe(0.4);
    expect(shortHold.value).toBeNull();
  });

  it('merges only compatible histogram deltas and never averages summary quantiles', () => {
    const hist: MetricDefinition = { ...gauge, id: 'db.latency', kind: 'histogram', value_type: 'histogram',
      temporality: 'cumulative', aggregation: { time: ['last', 'merge', 'quantile'], space: ['none', 'merge'],
        missing: 'preserve_null', min_coverage: 0.5, quantiles: 'from_merged_histogram' } };
    const h = (s: number, counts: number[], bounds: Array<number | '+Inf'> = fixture.histogram.bounds) =>
      point(hist, s, { encoding: 'histogram', count: String(counts.at(-1)), sum: counts.at(-1)!,
        buckets: counts.map((count, i) => ({ upper_bound: bounds[i], count: String(count) })) },
      { counter: { start_at: stamp(0), bits: '64' } });
    const rows = fixture.histogram.cumulative_counts.map((counts: number[], i: number) => h(i * 10, counts));
    const merged = aggregate(query(hist, 'merge', 10, 30), [rows])[0];
    expect(merged.value).toMatchObject({ count: String(fixture.histogram.merged_interval_count),
      buckets: [{ count: '3' }, { count: '6' }] });
    expect(scalar(aggregate({ ...query(hist, 'quantile', 10, 30), quantile: 0.4 }, [rows])[0])).toBe(10);
    expect(() => aggregate(query(hist, 'merge', 10, 30), [[rows[0], rows[1], h(20, [4, 8], [20, '+Inf'])]])).toThrow('HISTOGRAM_BUCKET_MISMATCH');
    const summary: MetricDefinition = { ...hist, id: 'db.summary', kind: 'summary', value_type: 'summary', temporality: 'delta',
      aggregation: { time: ['last'], space: ['none'], missing: 'preserve_null', min_coverage: 0.5, quantiles: 'non_mergeable' } };
    expect(() => aggregate(query(summary, 'mean'), [[]])).toThrow();
    const summaryPoint = point(summary, 0, { encoding: 'summary', count: '2', sum: 5, quantiles: [{ quantile: 0.95, value: 4 }] });
    expect(aggregate(query(summary, 'last', 0, 10), [[summaryPoint]])[0].value).toEqual(summaryPoint.value);
  });

  it('preserves exact counter integers above 2^53 and resets on source switches', () => {
    const base = 9007199254740993n;
    const rows = [point(counter, 0, { encoding: 'uint64', value: String(base) },
      { counter: { start_at: stamp(0), bits: '64' } }),
    point(counter, 10, { encoding: 'uint64', value: String(base + 40n) },
      { counter: { start_at: stamp(0), bits: '64' } })];
    expect(scalar(aggregate(query(counter, 'rate', 0, 10), [rows])[0])).toBe(4);
    const changed = identify({ ...rows[1], source: { ...rows[1].source, collector_id: 'other' } });
    expect(aggregate(query(counter, 'rate', 0, 10), [[rows[0], changed]])[0].value).toBeNull();
  });

  it('authorizes every series before reading and exposes inventory only through its separate boundary', async () => {
    let reads = 0;
    const store = { queryWindow: async () => { reads++; return []; }, inventory: async () => null };
    await expect(new SemanticQueryService(store, async () => false).query(query(gauge, 'mean'))).rejects.toThrow('QUERY_FORBIDDEN');
    expect(reads).toBe(0);
    await expect(new SemanticQueryService(store, async () => true).inventory('instance', 'db-1')).rejects.toThrow('QUERY_FORBIDDEN');
    expect(await new SemanticQueryService(store, async () => true, async () => true).inventory('instance', 'db-1')).toBeNull();
  });
});
