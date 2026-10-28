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
