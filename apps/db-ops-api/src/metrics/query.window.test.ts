import { describe, expect, it } from 'vitest';
import { definitions, identify, sample } from '../contracts/metrics/fixtures.js';
import type { MetricDefinition, NormalizedObservation } from '../contracts/metrics/index.js';
import { aggregate, MAX_BUCKETS, SemanticQueryService, type QueryStore, type SemanticQuery } from './query.js';

const definition: MetricDefinition = definitions[0];
const base = sample(definition.id);
const series = { resource_type: base.resource_type, resource_id: base.resource_id, metric: base.metric, dimensions: base.dimensions };
const origin = Date.parse('2026-10-01T00:00:00Z'), DAY = 86_400_000;
const at = (ms: number) => new Date(origin + ms).toISOString();
const point = (ms: number, value: number, attempt = `minute-${ms}`): NormalizedObservation => identify({ ...base,
  observed_at: at(ms), collected_at: at(ms), stored_at: null,
  value: { encoding: 'float64', value }, source: { ...base.source, attempt_id: attempt } });
const window = (points: { from: number; to: number }) => Array.from({ length: (points.to - points.from) / 60_000 },
  (_, i) => point(points.from + i * 60_000, i % 41));
const query = (overrides: Partial<SemanticQuery> = {}): SemanticQuery => ({ definition, series: [series],
  from: at(0), to: at(DAY), now: at(DAY), interval_ms: 60_000, max_gap_ms: 300_000, stale_after_ms: 300_000,
  bucket_ms: 60_000, mode: 'last', space: 'none', ...overrides });
const scalar = (bucket: { value: NormalizedObservation['value'] }) =>
  bucket.value && 'value' in bucket.value ? Number(bucket.value.value) : null;

describe('complete history window', () => {
  it('returns all 1,440 one-minute slots for 24h with intact edges and no zero fill', () => {
    const rows = window({ from: 0, to: DAY }).filter((_, i) => i !== 100 && i !== 101);
    const buckets = aggregate(query(), [rows]);
    expect(buckets).toHaveLength(1440);
    expect(buckets[0].window).toEqual({ from: at(0), to: at(60_000) });
    expect(buckets.at(-1)!.window).toEqual({ from: at(DAY - 60_000), to: at(DAY) });
    expect(buckets.map((b, i) => b.sample_count).reduce((a, b) => a + b, 0)).toBe(1438);
    // Missing minutes stay null; they are never replaced with 0.
    expect(buckets[100]).toMatchObject({ value: null, stats: null, coverage: 0, sample_count: 0,
      quality: { status: 'unknown', reason: 'missing_input' } });
    expect(buckets[99].quality.status).toBe('good');
    // Historical quality is judged in its own window; freshness alone reflects the age at read time.
    expect(buckets[0]).toMatchObject({ freshness: 'stale', quality: { status: 'good' }, accuracy: 'exact' });
    expect(scalar(buckets[0])).toBe(0);
    expect(scalar(buckets.at(-1)!)).toBe(4);
  });

  it('keeps the bucket envelope so a spike never disappears behind the selected mode', () => {
    const definition2 = { ...definition, aggregation: { ...definition.aggregation, min_coverage: 0.5 } };
    // 'last' would report the final sample; the envelope must still retain the peak in the bucket.
    const bursts = [point(0, 4, 'b-0'), point(10_000, 60, 'b-1'), point(20_000, 5, 'b-2'), point(30_000, 6, 'b-3')];
    const buckets = aggregate(query({ definition: definition2, to: at(60_000), now: at(60_000), interval_ms: 10_000 }), [bursts]);
    expect(scalar(buckets[0])).toBe(6);
    expect(buckets[0].stats).toEqual({ count: 4, min: { encoding: 'float64', value: 4 },
      max: { encoding: 'float64', value: 60 }, avg: { encoding: 'float64', value: 18.75 } });
  });

  it('returns count/min/max/avg over every sample in a multi-sample bucket', () => {
    const definition2 = { ...definition, aggregation: { ...definition.aggregation, min_coverage: 0.5 } };
    const rows = [0, 15_000, 30_000, 45_000].map((ms, i) => point(ms, [2, 8, 5, 6][i]));
    const buckets = aggregate(query({ definition: definition2, to: at(60_000), now: at(60_000), bucket_ms: 60_000, interval_ms: 15_000 }), [rows]);
    expect(buckets[0].stats).toEqual({ count: 4, min: { encoding: 'float64', value: 2 },
      max: { encoding: 'float64', value: 8 }, avg: { encoding: 'float64', value: 5.25 } });
    expect(scalar(buckets[0])).toBe(6);
  });

  it('supports 7 days of minute buckets but bounds the response instead of truncating', () => {
    const week = Array.from({ length: 10_080 }, (_, i) => point(i * 60_000, i % 7));
    expect(aggregate(query({ to: at(7 * DAY), now: at(7 * DAY), bucket_ms: 60_000 }), [week])).toHaveLength(MAX_BUCKETS);
    expect(() => aggregate(query({ to: at(7 * DAY), now: at(7 * DAY), bucket_ms: 59_000 }), [week]))
      .toThrow('QUERY_LIMIT_EXCEEDED');
  });

});

describe('counter rate keeps the accepted baseline across bucket edges', () => {
  // F1: a precision_loss sample never advances the counter baseline, so the accepted baseline can
  // sit further back than the one raw sample before a bucket. Slicing per bucket then restarting
  // the reducer from an empty state silently shortened the delta interval.
  const counter: MetricDefinition = { ...definitions[3], aggregation: { ...definitions[3].aggregation, min_coverage: 0.75 } };
  const origin = Date.parse('2026-09-01T00:00:00Z');
  const stamp = (seconds: number) => new Date(origin + seconds * 1000).toISOString();
  const fixture = sample(counter.id);
  const series = { resource_type: fixture.resource_type, resource_id: fixture.resource_id,
    metric: { id: counter.id, semantic_version: counter.semantic_version }, dimensions: fixture.dimensions };
  const loss = { status: 'partial' as const, reason: 'precision_loss' as const };
  const counterPoint = (seconds: number, value: number, options: Partial<NormalizedObservation> = {}) => identify({ ...fixture,
    metric: { id: counter.id, semantic_version: counter.semantic_version }, unit: counter.unit,
    observed_at: stamp(seconds), collected_at: stamp(seconds), stored_at: stamp(200_000),
    value: { encoding: 'uint64' as const, value: String(value) },
    source: { ...fixture.source, attempt_id: `rate-${seconds}-${value}` },
    counter: { start_at: stamp(-3600), bits: '64' as const }, ...options });
  const rateQuery = (overrides: Partial<SemanticQuery> = {}): SemanticQuery => ({ definition: counter, series: [series],
    from: stamp(0), to: stamp(40), now: stamp(40), interval_ms: 10_000, max_gap_ms: 60_000, stale_after_ms: 60_000,
    bucket_ms: 10_000, mode: 'rate', space: 'none', ...overrides });
  const rate = (buckets: ReturnType<typeof aggregate>) =>
    buckets.map(b => b.value && 'value' in b.value ? Number(b.value.value) : null);

  it('keeps the trusted baseline when the preceding sample is precision_loss', () => {
    const rows = [counterPoint(0, 100), counterPoint(15, 115, { quality: loss, accuracy: 'estimated' }),
      counterPoint(25, 125), counterPoint(35, 135)];
    const buckets = aggregate(rateQuery(), [rows]);
    expect(rate(buckets)).toEqual([1, 1, 1, null]);
    expect(buckets.map(b => b.coverage)).toEqual([1, 1, 1, 0.5]);
    // The regression bucket: the 0→25 s interval covers 10 s of it, not only 25→35 s (coverage 0.5).
    expect(buckets[2]).toMatchObject({ value: { encoding: 'float64', value: 1 }, coverage: 1,
      quality: { status: 'good', reason: 'none' }, accuracy: 'exact' });
    expect(buckets[2].stats).toEqual({ count: 2, min: { encoding: 'float64', value: 1 },
      max: { encoding: 'float64', value: 1 }, avg: { encoding: 'float64', value: 1 } });
    // The precision_loss sample is never adopted as a baseline, so its value cannot enter the delta.
    expect(buckets[2].sources).toHaveLength(3);
    expect(buckets[2].sources.map(s => s.id)).not.toContain(rows[1].id);
  });

  it('holds one accepted baseline across several consecutive non-advancing samples', () => {
    const rows = [counterPoint(0, 100), counterPoint(10, 110, { quality: loss, accuracy: 'estimated' }),
      counterPoint(15, 118, { quality: loss, accuracy: 'estimated' }), counterPoint(25, 125),
      counterPoint(35, 135)];
    const buckets = aggregate(rateQuery({ to: stamp(30), now: stamp(30), bucket_ms: 30_000 }), [rows]);
    // 25 bytes over 25 s, not (125−118) over 10 s: neither rounded sample became the baseline.
    expect(buckets[0]).toMatchObject({ value: { encoding: 'float64', value: 1 }, coverage: 1,
      quality: { status: 'good', reason: 'none' }, accuracy: 'exact' });
  });

  it('does not bridge a reset or a source change with an old baseline', () => {
    const rows = [counterPoint(0, 100), counterPoint(15, 115, { quality: loss, accuracy: 'estimated' }),
      counterPoint(25, 125, { source: { ...fixture.source, collector_id: 'other', attempt_id: 'reset' } }),
      counterPoint(35, 135, { source: { ...fixture.source, collector_id: 'other', attempt_id: 'after-reset' } }),
      counterPoint(45, 145, { source: { ...fixture.source, collector_id: 'other', attempt_id: 'successor' } })];
    const buckets = aggregate(rateQuery(), [rows]);
    // The reset sample starts a new baseline: the 20→30 s bucket has only half of the 25→35 s interval.
    expect(buckets[2]).toMatchObject({ value: null, coverage: 0.5, quality: { status: 'unknown', reason: 'gap' } });
    expect(rate(buckets)[2]).not.toBe(1);
    // Once the post-reset pair is complete the rate is ordinary again.
    expect(buckets[3]).toMatchObject({ value: { encoding: 'float64', value: 1 }, coverage: 1 });
  });

  it('closes a bucket through samples that follow but do not advance it', () => {
    // 20→35 s is a precision_loss sample, so the interval that clips the 20→30 s bucket ends at 45 s.
    const rows = [counterPoint(0, 100), counterPoint(25, 125),
      counterPoint(35, 135, { quality: loss, accuracy: 'estimated' }), counterPoint(45, 145)];
    const buckets = aggregate(rateQuery(), [rows]);
    expect(buckets[2]).toMatchObject({ value: { encoding: 'float64', value: 1 }, coverage: 1 });
  });

  it('never extends an interval beyond max_gap, even across non-advancing samples', () => {
    const rows = [counterPoint(0, 100), counterPoint(15, 115, { quality: loss, accuracy: 'estimated' }),
      counterPoint(95, 195)];
    const buckets = aggregate(rateQuery({ to: stamp(100), now: stamp(100) }), [rows]);
    // 0→95 s exceeds max_gap_ms=60 s: no delta, so the whole window stays a gap.
    expect(buckets.every(b => b.value === null)).toBe(true);
    expect(buckets[2]).toMatchObject({ coverage: 0, quality: { status: 'unknown', reason: 'missing_input' } });
  });

  it('serves 1,440 minute buckets with no restart loss and no zero fill', () => {
    const day = 86_400_000, minute = 60_000;
    const start = Date.parse('2026-09-01T00:00:00Z');
    // Predecessor and successor frames of the window, as the paging store returns them.
    const rows = [counterPoint(-60, 40), ...Array.from({ length: 1440 }, (_, i) => {
      const seconds = i * 60, value = 100 + seconds;
      return i % 10 === 5
        ? counterPoint(seconds, value, { quality: loss, accuracy: 'estimated' })
        : counterPoint(seconds, value);
    }), counterPoint(1440 * 60, 100 + 1440 * 60)];
    const buckets = aggregate(rateQuery({ from: new Date(start).toISOString(), to: new Date(start + day).toISOString(),
      now: new Date(start + day).toISOString(), interval_ms: minute, bucket_ms: minute, max_gap_ms: 300_000 }), [rows]);
    expect(buckets).toHaveLength(1440);
    expect(buckets.map(b => b.coverage).every(c => c === 1)).toBe(true);
    expect(rate(buckets).every(v => v === 1)).toBe(true);
  });
});

describe('complete history window through the paging store', () => {
  it('reads the whole window through the paging store and refuses a denied series before any read', async () => {
    const rows = window({ from: 0, to: DAY }).filter((_, i) => i !== 100 && i !== 101);
    const calls: string[] = [];
    const store: QueryStore = {
      readWindow: async (_series, from, to) => { calls.push(`${from}/${to}`); return rows; },
      queryWindow: async () => { throw new Error('SINGLE_PAGE_READ_MUST_NOT_BE_USED'); },
      inventory: async () => null,
    };
    const buckets = await new SemanticQueryService(store, async () => true).query(query());
    expect(buckets).toHaveLength(1440);
    expect(calls).toEqual([`${at(0)}/${at(DAY)}`]);
    calls.length = 0;
    await expect(new SemanticQueryService(store, async () => false).query(query())).rejects.toThrow('QUERY_FORBIDDEN');
    expect(calls).toEqual([]);
    // Stores without the paging capability keep the single bounded page contract.
    const legacy: QueryStore = { queryWindow: async () => rows, inventory: async () => null };
    expect(await new SemanticQueryService(legacy, async () => true).query(query())).toHaveLength(1440);
  });
});
