import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { createConfigurationRegistry } from '../config/registry.js';
import { PolicyService } from '../policy/service.js';
import { MemoryPolicyStore, admin, pin, capabilities, testResources } from '../policy/test-support.js';
import { sample, identify } from '../../contracts/metrics-v2/fixtures.js';
import { CoreProfileSchema } from '../../contracts/metrics-v2/index.js';
import type { CollectionAttempt, NormalizedObservation } from '../../contracts/metrics-v2/index.js';
import { MetricConsumerService, type ConsumerStore } from './service.js';
import { registerMetricConsumerRoutes } from './routes.js';
import { createQueryMetricsTool } from '../../tools/ops/query_metrics.js';
import { evaluateAlertPolicy, evaluateMetric, scoreMetrics } from './evaluation.js';
import { migrateReference } from './migration.js';
const fixture = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/consumers/fixtures.json', import.meta.url), 'utf8'));
const policy = { metric_id: fixture.metric, unit: fixture.unit, threshold: fixture.threshold, operator: '>' as const, duration_seconds: 60, recovery_seconds: 60 };
describe('MAX-75 deterministic consumer contract', () => {
  let service: MetricConsumerService, store: MemoryPolicyStore, rows: NormalizedObservation[], attempts: CollectionAttempt[], reads: number, now: string;
  let policies: PolicyService;
  const query = () => ({ resource: fixture.resource, ...fixture.window });
  beforeEach(async () => {
    now = fixture.window.to; reads = 0; attempts = []; store = new MemoryPolicyStore();
    const registry = createConfigurationRegistry();
    policies = new PolicyService(store, registry, testResources, () => now);
    await policies.changeBinding(admin, fixture.resource, { expected_revision: 0, package: pin }, true);
    store.caps.set('instance:1', capabilities());
    rows = [identify({ ...sample(fixture.metric), resource_id: '1', observed_at: fixture.observed_at,
      collected_at: fixture.observed_at, stored_at: fixture.observed_at })];
    const db: ConsumerStore = { queryWindow: async s => { reads++; return rows.filter(r => r.metric.id === s.metric.id); },
      inventory: async () => testResources.inventory(fixture.resource), dimensions: async () => [{}], attempts: async () => attempts };
    service = new MetricConsumerService(policies, registry, db, () => now);
  });
  it('uses exactly the same values, quality, units, sources and window for HTTP, Agent, alert and score', async () => {
    const app = Fastify(); await registerMetricConsumerRoutes(app, async r => { (r as any).user = admin; }, service);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/metrics-v2/query', payload: query() });
      expect(response.statusCode).toBe(200);
      const ui = response.json();
      const agent = await createQueryMetricsTool(service).handler({ instance_id: 1, ...fixture.window }, { actor: admin });
      expect(agent.success).toBe(true); expect((agent.data as any).metrics).toEqual(ui.metrics);
      const bucket = ui.metrics[0].series[0].buckets[0];
      expect(bucket).toMatchObject({ value: { value: fixture.value }, coverage: 1, unit: 's', freshness: 'fresh', accuracy: 'exact' });
      expect(bucket.sources).toHaveLength(1);
      expect(evaluateMetric(ui.metrics[0], policy)).toMatchObject({ state: 'firing', value: fixture.value });
      const evaluated = await app.inject({ method: 'POST', url: '/api/metrics-v2/evaluate', payload: { query: query(), policies: [policy] } });
      expect(evaluated.json().metrics).toEqual(ui.metrics);
      expect(evaluated.json().assessment).toEqual(scoreMetrics(ui.metrics, [policy]));
    } finally { await app.close(); }
  });
  it.each(['missing', 'stale', 'estimated', 'invalid_denominator'] as const)('%s never yields healthy or a fabricated score', async state => {
    if (state === 'missing') rows = [];
    if (state === 'stale') now = '2026-09-18T01:00:00.000Z';
    if (state === 'estimated') rows[0] = identify({ ...rows[0], accuracy: 'estimated' });
    if (state === 'invalid_denominator') rows[0] = identify({ ...rows[0], value: null, quality: { status: 'unknown', reason: 'invalid_denominator' } });
    const result = await service.query(admin, query());
    expect(evaluateMetric(result.metrics[0], policy)).toMatchObject({ state: 'unknown', recovery: false });
    expect(scoreMetrics(result.metrics, [policy])).toMatchObject({ status: 'unknown', score: null });
  });
  it('retains a supported metric after timeout, and distinguishes permission denial', async () => {
    attempts = [{ id: 'timeout', resource_id: '1', binding_id: 'instance:1', collector_id: 'mysql-status', config_revision: 1,
      started_at: fixture.observed_at, ended_at: fixture.window.to, status: 'failed', error: 'timeout', observation_ids: [] }];
    let result = await service.query(admin, query());
    expect(result.metrics[0]).toMatchObject({ state: 'temporary_failure', capability: { status: 'supported' } });
    expect(result.metrics[0].series).toHaveLength(1);
    attempts[0].error = 'permission_denied'; result = await service.query(admin, query());
    expect(result.metrics[0]).toMatchObject({ state: 'permission_denied', series: [] });
  });
  it('denies resource scope before reading observations or revealing extensions', async () => {
    const actor = { ...admin, permissions: ['instance:view'], instanceScopes: {} };
    await expect(service.query(actor, query())).rejects.toThrow('POLICY_FORBIDDEN');
    await expect(service.discover(actor, fixture.resource)).rejects.toThrow('POLICY_FORBIDDEN');
    expect(reads).toBe(0);
  });
  it('keeps product profile fixed across template changes and filters extension discovery', async () => {
    const before = await service.discover(admin, fixture.resource);
    expect(CoreProfileSchema.parse(before.profile)).toEqual(before.profile);
    expect(before.definitions.some(d => d.id === 'mysql.queries.per_second')).toBe(true);
    const binding = store.bindings.get('instance:1')!;
    const release = createConfigurationRegistry().list().find(r => r.package.id === 'mysql-representative')!;
    const next = { id: release.package.id, version: release.package.version, digest: release.package.digest };
    // Simulate a newly bound fixture, not an unsupported in-place package-id switch.
    store.bindings.delete('instance:1'); await policies.changeBinding(admin, fixture.resource, { expected_revision: 0, package: next }, true);
    expect((await service.discover(admin, fixture.resource)).profile).toEqual(before.profile);
    expect(binding.binding.package.id).toBe('mysql-basic');
  });
  it('canonical default and explicit extension use one query; unknown/InnoDB and inventory are not invented metrics', async () => {
    const result = await service.query(admin, query()); expect(result.metrics.map(m => m.definition.category)).toEqual(['canonical']);
    const extension = await service.query(admin, { ...query(), metric_ids: ['mysql.queries.per_second'] });
    expect(extension.metrics[0].definition.category).toBe('extension');
    expect(extension.metrics[0].series[0].buckets[0].value).toBeNull();
    for (const id of ['mysql.innodb.fake', 'db.version']) await expect(service.query(admin, { ...query(), metric_ids: [id] })).rejects.toThrow('UNKNOWN_METRIC');
    expect((await service.inventory(admin, fixture.resource))?.attributes['db.version']).toBeDefined();
  });
  it('consumes the frozen AlertPolicy including independent quality, version and recovery', async () => {
    const metric = (await service.query(admin, query())).metrics[0];
    const input = { id: 'test-policy', revision: 1, enabled: true, metric: { id: fixture.metric, semantic_version: '1.0.0' },
      operator: 'gt' as const, threshold: 3000, unit: 's' as const, for_ms: 60000, min_coverage: 1,
      accepted_quality: ['good'] as ['good'], allow_estimated: false, on_missing: 'unknown' as const };
    expect(evaluateAlertPolicy(metric, input, { for_ms: 120000 })).toMatchObject({ state: 'firing', recovery: false });
    expect(evaluateAlertPolicy(metric, { ...input, metric: { ...input.metric, semantic_version: '2.0.0' } }, { for_ms: 0 })).toMatchObject({ state: 'unknown', reason: 'semantic_version_mismatch' });
  });
  it('requires full duration and independent recovery threshold; preserves count migrations', async () => {
    const metric = (await service.query(admin, query())).metrics[0];
    expect(evaluateMetric(metric, { ...policy, duration_seconds: 120 })).toMatchObject({ state: 'pending' });
    expect(evaluateMetric(metric, { ...policy, threshold: 4000, recovery_threshold: 3000 })).toMatchObject({ state: 'pending', recovery: false });
    expect(migrateReference(fixture.resource, 'mysql', 'connections')).toMatchObject({ metric_id: 'mysql.processlist.count', threshold_conversion: 'none', resource: fixture.resource });
    expect(migrateReference(fixture.resource, 'mysql', 'cpu_usage')).toMatchObject({ status: 'review_required', metric_id: null });
  });
});
