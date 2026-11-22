import { expect, it } from 'vitest';
import { aggregateHistory, aggregateHistoryChart } from './history-query.js';
import { identify, sample } from '../../contracts/metrics/fixtures.js';
import { canonicalDefinitions } from '../packages/builtins.js';
import type { SemanticQuery } from '../query.js';
import type { ConfigurationAt } from '../../contracts/metrics/configuration-history.js';
const start = Date.parse('2026-10-29T12:00:00.000Z');
const iso = (n: number) => new Date(start + n).toISOString();
const observation = (ms: number, revision: number) => {
  const fixture = sample('db.uptime_seconds');
  return identify({ ...fixture, observed_at: iso(ms), collected_at: iso(ms), stored_at: iso(ms),
    versions: { ...fixture.versions, config_revision: revision } });
};
const point = observation(0, 1);
const q: SemanticQuery = { definition: canonicalDefinitions.find(d => d.id === point.metric.id)!,
  series: [{ resource_type: point.resource_type, resource_id: point.resource_id, metric: point.metric, dimensions: {} }],
  from: iso(0), to: iso(240000), now: iso(240000), interval_ms: 60000, max_gap_ms: 180000,
  stale_after_ms: 180000, bucket_ms: 120000, mode: 'last', space: 'none' };
const configuration = (revision: number, interval: number): Exclude<ConfigurationAt, { state: 'unknown' }> => ({ resource: { type: 'instance', id: 1 },
  revision, state: 'effective', settings: { enabled: true, interval_ms: interval, timeout_ms: 5000,
    stale_after_ms: 600000, max_counter_gap_ms: interval * 3, max_rows: 1, max_concurrency: 1, max_series_per_resource: 10 },
  published_at: iso(0), snapshot_digest: `sha256:${'a'.repeat(64)}`, resolution_identity: null,
  evidence: [{ basis: 'application_report', at: iso(0), sample_ids: [] }] });
const minute = 60000, hour = 60 * minute;
const ratio = (n: number, d = 1) => ({ numerator: String(n), denominator: String(d) });
// Count, average and envelope from Zabbix 7.0.21 testDataDisplayInGraphs.php, at Slide's archived 5m grain.
const archived = (ms: number, count: number, avg: number, min: number, max: number) => ({
  metadata: q.series[0], bucket: { from: iso(ms), to: iso(ms + 5 * minute), count, numeric_count: count,
    invalid_count: 0, non_numeric_count: 0, estimated_count: 0, sum: ratio(count * avg, 100),
    avg: ratio(avg, 100), min: ratio(min, 100), max: ratio(max, 100), first_at: iso(ms),
    last_at: iso(ms + 4 * minute), max_gap_ms: minute, coverage: 1, quality: 'good' as const },
});
const chartPoint = (ms: number, value: number) => identify({ ...observation(ms, 1), value: { encoding: 'float64', value } });
const chart = { ...q, sample_last: true,
  definition: { ...q.definition, aggregation: { ...q.definition.aggregation, min_coverage: 0 } } };
it('computes each old revision with its own cadence and freshness', async () => {
  const revisions: number[] = [];
  const buckets = await aggregateHistory(q, [point, observation(60000, 1), observation(120000, 2)], async r => {
    revisions.push(r); return configuration(r, r === 1 ? 60000 : 120000);
  });
  expect(revisions).toEqual([1, 2]);
  expect(buckets.map(b => b.coverage)).toEqual([1, 1]);
  expect(buckets.map(b => b.freshness)).toEqual(['fresh', 'fresh']);
});
it('does not treat a published or missing snapshot as effective sampling', async () => {
  for (const state of ['published', 'unknown'] as const) {
    const buckets = await aggregateHistory(q, [point], async revision => state === 'unknown'
      ? { resource: { type: 'instance', id: 1 }, revision, state, reason: 'snapshot_not_recorded' }
      : { ...configuration(revision, 120000), state, evidence: [] });
    expect(buckets[0].coverage).toBe(0.5);
    expect(buckets[0].freshness).toBe('stale');
  }
});
it('keeps mixed-revision buckets unknown and propagates damaged snapshot errors', async () => {
  const buckets = await aggregateHistory(q, [point, observation(60000, 2)], async r => configuration(r, 60000));
  expect(buckets[0]).toMatchObject({ value: null, coverage: 0, quality: { status: 'unknown' } });
  expect(buckets[0].sources.map(s => s.versions.config_revision)).toEqual([1, 2]);
  await expect(aggregateHistory(q, [point], async () => { throw new Error('CONFIGURATION_HISTORY_INVALID'); })).rejects.toThrow('CONFIGURATION_HISTORY_INVALID');
});

it('weights archived means by sample count, preserves the envelope and keeps the next detail and gap buckets', async () => {
  const archivedInputs = [archived(0, 59, 907, 454, 1381), archived(5 * minute, 48, 431, -256, 1010)];
  const detail = chartPoint(2 * hour, 20);
  const buckets = await aggregateHistoryChart({ ...chart, from: iso(0), to: iso(3 * hour), now: iso(3 * hour),
    bucket_ms: hour }, { points: [chartPoint(10 * minute, 20), detail], retained: archivedInputs });
  expect(buckets[0]).toMatchObject({ retained_sample_count: 107, sample_count: 108,
    stats: { count: 108, min: { value: -2.56 }, max: { value: 20 } } });
  expect(buckets[0].value).toMatchObject({ value: expect.closeTo((59 * 9.07 + 48 * 4.31 + 20) / 108, 10) });
  expect(buckets[1]).toMatchObject({ value: null, sample_count: 0 });
  expect(buckets[2]).toMatchObject({ value: { value: 20 }, sample_count: 1 });
  expect(buckets[2]).not.toHaveProperty('retained_sample_count');
});

it('does not project a clipped archive outside its window or fill a failed detail bucket', async () => {
  const failed = identify({ ...chartPoint(6 * minute, 99), value: null,
    quality: { status: 'unknown', reason: 'source_error' }, accuracy: 'unknown' });
  const buckets = await aggregateHistoryChart({ ...chart, from: iso(minute), to: iso(15 * minute), now: iso(15 * minute) }, {
    points: [failed], retained: [archived(0, 59, 907, 454, 1381), archived(5 * minute, 48, 431, -256, 1010)],
  });
  expect(buckets.map(bucket => bucket.value)).toEqual([null, null, null]);
  expect(buckets[0].window).toEqual({ from: iso(minute), to: iso(5 * minute) });
  expect(buckets[1].quality.reason).toBe('source_error');
  expect(buckets[1]).toMatchObject({ retained_sample_count: 48, stats: { avg: { value: 4.31 } } });
});

it('independent review: uses exact edge evidence and keeps other sub-buckets when one archive straddles the window', async () => {
  const window = { ...chart, from: iso(minute), to: iso(hour), now: iso(hour), bucket_ms: hour };
  const straddles = archived(0, 59, 907, 454, 1381);
  const inside = archived(5 * minute, 48, 431, -256, 1010);
  const [partial] = await aggregateHistoryChart(window, { points: [], retained: [straddles, inside] });
  expect(partial).toMatchObject({ value: { value: 4.31 }, retained_sample_count: 48,
    quality: { status: 'partial' }, stats: { count: 48 } });
  const [exact] = await aggregateHistoryChart(window, { points: [], retained: [
    { ...straddles, bucket: { ...straddles.bucket, first_at: iso(minute) } },
  ] });
  expect(exact).toMatchObject({ value: { value: 9.07 }, retained_sample_count: 59 });
});

it('independent review: counts different observations at one timestamp and preserves a plottable partial detail at the seam', async () => {
  const good = chartPoint(6 * minute, 2);
  const partial = identify({ ...good, source: { ...good.source, attempt_id: 'independent-detail' },
    value: { encoding: 'float64', value: 8 }, quality: { status: 'partial', reason: 'partial_input' } });
  const window = { ...chart, from: iso(0), to: iso(hour), now: iso(hour), bucket_ms: hour };
  const [detail] = await aggregateHistoryChart(window, { points: [good, partial, partial], retained: [] });
  expect(detail).toMatchObject({ sample_count: 2, stats: { count: 2, min: { value: 2 }, max: { value: 8 } } });
  const [joined] = await aggregateHistoryChart(window, { points: [good, partial], retained: [archived(0, 1, 200, 200, 200)] });
  expect(joined).toMatchObject({ sample_count: 3, stats: { count: 3, min: { value: 2 }, max: { value: 8 }, avg: { value: 4 } },
    quality: { status: 'partial' } });
});
