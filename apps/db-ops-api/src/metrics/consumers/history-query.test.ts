import { expect, it } from 'vitest';
import { aggregateHistory } from './history-query.js';
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
