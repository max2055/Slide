import { extension, fixtureRelease } from '../triggers/test-support.js';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { createConfigurationRegistry } from '../config/registry.js';
import { PolicyService } from '../policy/service.js';
import { MemoryPolicyStore, admin, pin, capabilities, testResources } from '../policy/test-support.js';
import { sample, identify } from '../../contracts/metrics/fixtures.js';
import { CoreProfileSchema } from '../../contracts/metrics/index.js';
import type { CollectionAttempt, NormalizedObservation } from '../../contracts/metrics/index.js';
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
      const response = await app.inject({ method: 'POST', url: '/api/metrics/query', payload: query() });
      expect(response.statusCode).toBe(200);
      const ui = response.json();
      const agent = await createQueryMetricsTool(service).handler({ instance_id: 1, ...fixture.window }, { actor: admin });
      expect(agent.success).toBe(true); expect((agent.data as any).metrics).toEqual(ui.metrics);
      const bucket = ui.metrics[0].series[0].buckets[0];
      expect(bucket).toMatchObject({ value: { value: fixture.value }, coverage: 1, unit: 's', freshness: 'fresh', accuracy: 'exact' });
      expect(bucket.sources).toHaveLength(1);
      expect(evaluateMetric(ui.metrics[0], policy)).toMatchObject({ state: 'firing', value: fixture.value });
      const evaluated = await app.inject({ method: 'POST', url: '/api/metrics/evaluate', payload: { query: query(), policies: [policy] } });
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
  it('history ignores the current binding and interval, while live queries still respect coverage', async () => {
    const before = await service.query(admin, { ...query(), history: true, metric_ids: [fixture.metric], bucket_ms: 60000 });
    store.bindings.delete('instance:1');
    const after = await service.query(admin, { ...query(), history: true, metric_ids: [fixture.metric], bucket_ms: 60000 });
    expect(after.metrics[0].state).toBe('not_covered');
    expect(after.metrics[0].series).toEqual(before.metrics[0].series);
    expect((await service.query(admin, { ...query(), metric_ids: [fixture.metric] })).metrics[0].series).toEqual([]);
  });
  it('keeps installed semantic versions separate without duplicating metrics or stitching their curves', async () => {
    store.bindings.delete('instance:1');
    const registry = createConfigurationRegistry();
    const first = extension('fixture.alpha', '1'), second = { ...first, semantic_version: '2.0.0' };
    // Consumer catalog port: installation/mapping validation is covered by PackageRegistry tests.
    registry.list = () => [{ ...fixtureRelease(), extensions: [first, second] }];
    const points = [first, second].map((definition, i) => identify({ ...sample(fixture.metric), resource_id: '1',
      observed_at: fixture.observed_at, collected_at: fixture.observed_at, stored_at: fixture.observed_at,
      metric: { id: definition.id, semantic_version: definition.semantic_version }, unit: '1', value: { encoding: 'float64', value: 95 + i } }));
    const versions = new MetricConsumerService(policies, registry, {
      queryWindow: async series => points.filter(p => p.metric.semantic_version === series.metric.semantic_version),
      dimensions: async () => [{}], inventory: async () => null, attempts: async () => [],
      historyMetrics: async () => points.map(p => p.metric),
    }, () => now);
    const result = await versions.query(admin, { ...query(), history: true, view: 'extension' });
    expect(result.metrics.map(m => m.definition.semantic_version)).toEqual(['1.0.0', '2.0.0']);
    expect(result.metrics.map(m => m.series[0].buckets[0].value)).toEqual([
      { encoding: 'float64', value: 95 }, { encoding: 'float64', value: 96 }]);
  });
  it('rejects a revocation committed during a window or raw-page storage wait', async () => {
    let live = admin;
    const revoked = { ...admin, permissions: ['instance:view'], instanceScopes: {} };
    const registry = createConfigurationRegistry();
    const guarded = new MetricConsumerService(policies, registry, {
      queryWindow: async () => { live = revoked; return rows; },
      dimensions: async () => [{}], inventory: async () => null, attempts: async () => [],
      readObservationPage: async () => { live = revoked; return { observations: rows, total: 1, has_more: false, next: null }; },
    }, () => now, undefined, async () => live);
    await expect(guarded.query(admin, { ...query(), metric_ids: [fixture.metric] })).rejects.toThrow('POLICY_FORBIDDEN');
    live = admin;
    await expect(guarded.observations(admin, { resource: fixture.resource, metric: rows[0].metric,
      dimensions: {}, ...fixture.window })).rejects.toThrow('POLICY_FORBIDDEN');
  });
  it.each(['discover', 'inventory'] as const)('%s revalidates after its storage reads', async operation => {
    let live = admin;
    const guarded = new MetricConsumerService(policies, createConfigurationRegistry(), {
      queryWindow: async () => [], attempts: async () => [], dimensions: async () => [],
      inventory: async () => { live = { ...admin, permissions: [], instanceScopes: {} }; return null; },
    }, () => now, undefined, async () => live);
    await expect(guarded[operation](admin, fixture.resource)).rejects.toThrow('POLICY_FORBIDDEN');
  });
  it('denies resource scope before reading observations or revealing extensions', async () => {
    const actor = { ...admin, permissions: ['instance:view'], instanceScopes: {} };
    await expect(service.query(actor, query())).rejects.toThrow('POLICY_FORBIDDEN');
    await expect(service.discover(actor, fixture.resource)).rejects.toThrow('POLICY_FORBIDDEN');
    expect(reads).toBe(0);
  });
  it('keeps the formal API available when a host counter has no supported rate unit',async()=>{
    const registry=createConfigurationRegistry();
    const release=registry.list().find(r=>r.package.id==='linux-host'&&r.package.version==='1.1.0')!.package;
    const host={type:'server' as const,id:3};
    const hostPolicy=new PolicyService(new MemoryPolicyStore(),registry,{exists:async()=>true,
      inventory:async()=>({type:'server',id:'3',attributes:{'os.family':{value:'linux',source:'test',observed_at:now}}})},()=>now);
    await hostPolicy.changeBinding(admin,host,{expected_revision:0,package:{id:release.id,version:release.version,digest:release.digest}},true);
    const readMetrics:string[]=[];
    const hostService=new MetricConsumerService(hostPolicy,registry,{queryWindow:async s=>{readMetrics.push(s.metric.id);return[];},
      dimensions:async()=>[{device:'nvme0n1'}],inventory:async()=>null,attempts:async()=>[]},()=>now);
    const app=Fastify();await registerMetricConsumerRoutes(app,async r=>{(r as any).user=admin;},hostService);
    try{
      const response=await app.inject({method:'POST',url:'/api/metrics/query',payload:{resource:host,...fixture.window,
        metric_ids:['linux.block.io_time_ms_total','linux.uptime.seconds']}});
      expect(response.statusCode).toBe(200);
      expect(response.json().metrics[0]).toMatchObject({state:'query_operation_unavailable',series:[]});
      expect(readMetrics).toEqual(['linux.uptime.seconds']);
    }finally{await app.close();}
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
    const result = await service.query(admin, query()); expect(result.metrics.map(m => m.definition.category)).toEqual(['canonical', 'extension']);
    expect(result.metrics[1]).toMatchObject({ state: 'not_covered', series: [] });
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
