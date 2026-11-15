import Fastify from 'fastify';
import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { createConfigurationRegistry } from '../../metrics/config/registry.js';
import { PolicyService } from '../../metrics/policy/service.js';
import { MemoryPolicyStore, admin, pin, capabilities, testResources, at } from '../../metrics/policy/test-support.js';
import { MetricConsumerService, type ConsumerStore } from '../../metrics/consumers/service.js';
import { FormalObservationService } from '../../metrics/consumers/observations.js';
import { MysqlMetricStorage } from '../../metrics/storage.js';
import { sample, identify, definitions } from '../../contracts/metrics/fixtures.js';
import { ResourceDiagnosticService } from '../../resources/resource-diagnostic-service.js';
import { registerResourceRoutes } from '../../resources/resource-routes.js';
import { createQueryMetricsTool } from './query_metrics.js';

// Explicit opt-in connection; never read a developer credential file in test collection.
const config = process.env.MAX5_MYSQL_CONFIG;
describe.skipIf(!config)('GitHub #366/#620 isolated MySQL entry points', () => {
  const database = `max5_metrics_${process.pid}`;
  const now = '2026-09-18T00:01:00.000Z';
  let root: Pool, pool: Pool, consumer: MetricConsumerService;
  let reads = 0;
  const app = Fastify();
  const resource = { type: 'instance' as const, id: 1 };
  const query = { instance_id: 1, metric_ids: ['db.uptime_seconds'], from: at, to: now };
  beforeAll(async () => {
    const connection: PoolOptions = JSON.parse(config!);
    root = mysql.createPool({ ...connection, database: undefined });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...connection, database, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    const storage = new MysqlMetricStorage(pool, () => new Date(now));
    const point = identify({ ...sample('db.uptime_seconds'), resource_id: '1', observed_at: at, collected_at: at, stored_at: null });
    await storage.write(point, definitions.find(d => d.id === point.metric.id)!);
    const policies = new MemoryPolicyStore(), registry = createConfigurationRegistry();
    const policy = new PolicyService(policies, registry, testResources, () => now);
    await policy.changeBinding(admin, resource, { expected_revision: 0, package: pin }, true);
    policies.caps.set('instance:1', capabilities());
    const store: ConsumerStore = {
      queryWindow: async (...args) => { reads++; return storage.queryWindow(...args); },
      inventory: (type, id) => storage.inventory(type, id),
      dimensions: async () => [{}], attempts: async () => [],
    };
    consumer = new MetricConsumerService(policy, registry, store, () => now);
    const observations = new FormalObservationService(consumer);
    const diagnostics = new ResourceDiagnosticService({
      list: async () => [], detail: async () => null, relations: async () => [], alerts: async () => [],
      observations: async (ref, actor, options) => Promise.all((options?.metricIds ?? ['db.uptime_seconds'])
        .slice(0, options?.limit).map(id => observations.latest(actor, ref, id, { now: new Date(now), validForMs: 300000 }))),
    });
    await registerResourceRoutes(app, async request => { (request as any).user = admin; }, diagnostics);
    await app.listen({ host: '127.0.0.1', port: 0 });
  }, 120000);
  afterAll(async () => {
    await app.close();
    await pool?.end();
    if (root) { try { await root.query(`DROP DATABASE IF EXISTS ${database}`); } finally { await root.end(); } }
  });
  it('HTTP rejects invalid limits without SQL reads and still returns persisted observations', async () => {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('LISTEN_FAILED');
    const base = `http://127.0.0.1:${address.port}/api/resources/instance/1/observations?metricIds=db.uptime_seconds`;
    for (const limit of ['abc', 'NaN', 'Infinity', '3.5']) {
      const response = await fetch(`${base}&limit=${limit}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'OBSERVATION_LIMIT_INVALID' });
    }
    expect(reads).toBe(0);
    const response = await fetch(`${base}&limit=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ observations: [{ metricId: 'db.uptime_seconds', quality: 'good', value: expect.any(Number) }] });
    expect(reads).toBeGreaterThan(0);
  });
  it('tool distinguishes invalid inputs, selection, persisted values and SQL failure', async () => {
    const tool = createQueryMetricsTool(consumer, () => now);
    const before = reads;
    expect(await tool.handler({ ...query, resourceType: 'server' }, { actor: admin })).toMatchObject({ errorCode: 'RESOURCE_AMBIGUOUS' });
    expect(await tool.handler({}, { actor: admin })).toMatchObject({ errorCode: 'RESOURCE_INVALID' });
    expect(reads).toBe(before);
    expect(await tool.handler({ ...query, series_index: 1 }, { actor: admin })).toMatchObject({ errorCode: 'SERIES_INDEX_UNAVAILABLE' });
    expect(await tool.handler({ ...query, series_index: 0 }, { actor: admin })).toMatchObject({ success: true,
      data: { selection: { series_index: 0, total_series: 1 }, metrics: [{ series: [{ buckets: [expect.objectContaining({ value: expect.any(Object) })] }] }] } });
    // The failure is confined to this disposable schema and restored before cleanup.
    await pool.query('RENAME TABLE metric_observations TO max5_unavailable');
    try {
      expect(await tool.handler(query, { actor: admin })).toMatchObject({ success: false, errorCode: 'QUERY_METRICS_FAILED' });
    } finally { await pool.query('RENAME TABLE max5_unavailable TO metric_observations'); }
  });
});
