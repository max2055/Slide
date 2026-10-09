import { beforeEach, expect, it, vi } from 'vitest';
import { MetricConsumerService, type ConsumerStore } from './service.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { PolicyService } from '../policy/service.js';
import { MemoryPolicyStore, admin, resource } from '../policy/test-support.js';
import { sample, identify } from '../../contracts/metrics-v2/fixtures.js';
import { capacityDefinition, capacityReleases } from '../database/catalog.js';
import type { CollectionAttempt, NormalizedObservation } from '../../contracts/metrics-v2/index.js';
const ref = { type: 'instance' as const, id: 1 }, id = capacityDefinition('mysql')!.id;
let policies: PolicyService, service: MetricConsumerService, store: MemoryPolicyStore, db: ConsumerStore;
let now: string, point: NormalizedObservation | null, attempts: CollectionAttempt[];
beforeEach(async () => {
  now = '2026-09-18T00:01:00.000Z'; attempts = []; store = new MemoryPolicyStore();
  const registry = createConfigurationRegistry(), release = capacityReleases()[0];
  policies = new PolicyService(store, registry, { exists: async () => true, inventory: async () => resource() }, () => now);
  const { id: packageId, version, digest } = release.package;
  await policies.changeBinding(admin, ref, { expected_revision: 0, package: { id: packageId, version, digest } }, true);
  store.caps.set('instance:1', release.package.collectors.flatMap(c => c.mappings.map(m => ({
    metric: m.metric, resource_id: '1', method: c.method, status: 'supported' as const,
    basis: [{ kind: 'permission' as const, evidence: 'fixed_read_succeeded' }], evaluated_at: '2026-09-18T00:00:00Z', valid_until: '2026-09-19T00:00:00Z',
  }))));
  point = identify({ ...sample('db.uptime_seconds'), resource_id: '1', metric: { id, semantic_version: '1.0.0' }, unit: 'By',
    value: { encoding: 'uint64', value: '8192' }, observed_at: '2026-09-18T00:00:30.000Z',
    collected_at: '2026-09-18T00:00:30.000Z', stored_at: '2026-09-18T00:00:30.000Z', accuracy: 'estimated' });
  db = { queryWindow: vi.fn(async () => []), inventory: vi.fn(async () => resource()), dimensions: vi.fn(async () => [{}]),
    attempts: async () => attempts, latestCapacity: vi.fn(async () => point) };
  service = new MetricConsumerService(policies, registry, db, () => now);
});
const query = () => service.query(admin, { resource: ref, latest_capacity: true });
const capacity = (r: Awaited<ReturnType<typeof query>>) => r.metrics.find(m => m.definition.id === id)!;
it('serves small bytes with their actual timestamp, retaining stale values beyond the normal window', async () => {
  let m = capacity(await query());
  expect(m.observed_at).toBe(point!.observed_at);
  expect(m.series[0].buckets[0]).toMatchObject({ value: { encoding: 'uint64', value: '8192' }, accuracy: 'estimated', freshness: 'fresh' });
  now = '2026-09-18T00:10:00.000Z'; m = capacity(await query());
  expect(m.series[0].buckets[0]).toMatchObject({ value: { value: '8192' }, freshness: 'stale' });
  expect(db.latestCapacity).toHaveBeenCalledTimes(2);
  expect(vi.mocked(db.queryWindow).mock.calls.every(c => c[0].metric.id !== id)).toBe(true);
});
it('distinguishes no result and a genuine zero', async () => {
  point!.value = { encoding: 'uint64', value: '0' };
  expect(capacity(await query()).series[0].buckets[0].value).toEqual(point!.value);
  point = null; expect(capacity(await query()).series).toEqual([]);
});
it('does not allow a historical range to silently become a latest query', async () => {
  await expect(service.query(admin, { resource: ref, latest_capacity: true, from: '2026-09-18T00:00:00Z', to: now })).rejects.toThrow('LATEST_CAPACITY_WINDOW');
});
it('retains prior evidence after timeout and hides values after permission denial or disabling', async () => {
  attempts = [{ id: 'failed', resource_id: '1', binding_id: 'instance:1', collector_id: 'mysql-size', config_revision: 1,
    started_at: now, ended_at: now, status: 'failed', error: 'timeout', observation_ids: [] }];
  expect(capacity(await query())).toMatchObject({ state: 'temporary_failure', observed_at: point!.observed_at });
  attempts[0].error = 'permission_denied';
  expect(capacity(await query())).toMatchObject({ state: 'permission_denied', series: [] });
  attempts = [];
  await policies.changeBinding(admin, ref, { expected_revision: 1, overrides: { metrics: { [`${id}@1.0.0`]: 'disable' } } }, true);
  expect(capacity(await query())).toMatchObject({ state: 'disabled', series: [] });
});
it('checks access before any capacity or inventory read', async () => {
  await expect(service.query({ ...admin, permissions: ['instance:view'], instanceScopes: {} }, { resource: ref, latest_capacity: true })).rejects.toThrow('POLICY_FORBIDDEN');
  expect(db.latestCapacity).not.toHaveBeenCalled(); expect(db.inventory).not.toHaveBeenCalled();
});
