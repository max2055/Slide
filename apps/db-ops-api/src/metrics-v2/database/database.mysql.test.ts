import mysql, { type Pool } from 'mysql2/promise';
import { writeFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import type { NormalizedObservation, Resource } from '../../contracts/metrics-v2/index.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { createDatabaseRegistry, databaseReleases } from './catalog.js';
import { bindMySql, collectFixed } from '../packages/adapters.js';
import { MysqlMetricStorage } from '../storage.js';
import { SemanticQueryService } from '../query.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MetricScheduler } from '../scheduler/service.js';
import { RolloutControl, type Ticket } from '../rollout/control.js';

const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
describe.skipIf(!port)('MAX-71 isolated MySQL collection → Worker → storage → derived → query', () => {
  const database = `max71_${process.pid}`, ref = { type: 'instance' as const, id: 71 };
  const packages = createDatabaseRegistry(), release = databaseReleases()[0];
  const pin = (({ id, version, digest }) => ({ id, version, digest }))(release.package);
  let root: Pool, pool: Pool, resource: Resource, policies: PolicyService;
  let now = Date.now() - 20000;
  let startAt: string;
  const collectorWallMs: number[] = [];
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, timezone: 'Z', connectionLimit: 20, supportBigNumbers: true, bigNumberStrings: true });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    const [version] = await pool.query<any[]>('SELECT VERSION() AS version');
    const [uptime] = await pool.query<any[]>("SHOW GLOBAL STATUS LIKE 'Uptime'");
    startAt = new Date(Date.now() - Number(uptime[0].Value) * 1000).toISOString();
    // Fixture driver holds a stable epoch; actual drivers must retain trusted startup/reset evidence.
    resource = { type: 'instance', id: '71', attributes: {
      'db.engine': { value: 'mysql', observed_at: new Date(now).toISOString(), source: 'driver' },
      'db.version': { value: version[0].version, observed_at: new Date(now).toISOString(), source: 'driver' },
    } };
    await new MysqlMetricStorage(pool).writeInventory(resource);
    policies = new PolicyService(new MysqlPolicyStore(() => pool), packages, { exists: async () => true, inventory: async () => resource }, () => new Date(now).toISOString());
    await policies.changeBinding(admin, ref, { expected_revision: 0, package: pin, overrides: {} }, true);
  }, 120000);
  afterAll(async () => { await pool?.end(); if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); } });
  function setup(ticket?: Ticket) {
    const scheduler = new MetricScheduler(new MysqlScheduleStore(pool, packages, ticket), packages, { resolve: async () => ({ resource, credential_ref: 'credential:isolated-mysql', evidence: { counter: { bits: '64', start_at: startAt } }, resolve: async () => bindMySql(pool) }) }, () => now, async (...args) => {
      const started = performance.now(); try { return await collectFixed(...args); } finally { collectorWallMs.push(performance.now() - started); }
    });
    const registry = new JobRegistry(); scheduler.register(registry);
    const worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as never), `max71-${now}`, 30);
    return { scheduler, run: () => worker.runOnce((job, context) => registry.execute(job, context), now) };
  }
  const outputs = async (): Promise<NormalizedObservation[]> => (await pool.query<any[]>('SELECT payload FROM metric_v2_observations'))[0].map(r => typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload);
  const ready = () => pool.query("UPDATE workflow_jobs SET available_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE state = 'queued'");
  it('publishes/applies pinned config and stores all representative observations from five real SQL reads', async () => {
    const s = setup(); await s.scheduler.tick(); now += 10000;
    expect(await s.scheduler.tick()).toBe(1); expect(await s.run()).toBe('completed');
    const data = await outputs();
    for (const id of ['db.uptime_seconds', 'mysql.queries.total', 'mysql.processlist.count', 'mysql.connections.limit', 'mysql.tables.estimated_allocated_bytes', 'mysql.transaction_commands.commit_total', 'mysql.transaction_commands.rollback_total']) {
      expect(data.find(o => o.metric.id === id)?.value, id).not.toBeNull();
      expect(data.some(o => o.metric.id === id), id).toBe(true);
    }
    expect(data.find(o => o.metric.id === 'mysql.tables.estimated_allocated_bytes')!.accuracy).toBe('estimated');
    expect(data.filter(o => o.production === 'derived').every(o => o.quality.reason === 'counter_baseline')).toBe(true);
    expect((await policies.binding(admin, ref)).application).toMatchObject({ status: 'applied', applied_revision: 1 });
    expect((await pool.query<any[]>('SELECT logical_reads FROM metric_v2_schedule_events'))[0]).toEqual([{ logical_reads: 5 }]);
  });
  it('restarts Worker/store, resumes persistent counter state, and serves exact delta with query lineage', async () => {
    const before = await outputs(); const first = before.find(o => o.metric.id === 'mysql.transaction_commands.commit_total')!;
    await pool.query('COMMIT'); await pool.query('COMMIT'); await pool.query('ROLLBACK');
    now += 60000; const restarted = setup(); expect(await restarted.scheduler.tick()).toBe(1); await ready(); expect(await restarted.run()).toBe('completed');
    const data = await outputs();
    const commits = data.filter(o => o.metric.id === first.metric.id).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    const a = commits[0].value!, b = commits[1].value!;
    if (a.encoding !== 'uint64' || b.encoding !== 'uint64') throw new Error('COUNTER_ENCODING');
    const expected = Number(BigInt(b.value) - BigInt(a.value)) / 60;
    expect(expected).toBeGreaterThan(0);
    const rate = data.find(o => o.metric.id === 'mysql.transaction_commands.commit_rate' && o.observed_at === commits[1].observed_at)!;
    expect(rate.value).toEqual({ encoding: 'float64', value: expected });
    expect(rate.lineage.length).toBeGreaterThanOrEqual(2);
    const storage = new MysqlMetricStorage(pool), query = new SemanticQueryService(storage, async () => true);
    const definition = packages.catalog(pin).find(d => d.id === rate.metric.id)!;
    const result = await query.query({ definition, series: [{ resource_type: 'instance', resource_id: '71', metric: rate.metric, dimensions: {} }],
      from: rate.observed_at, to: new Date(now + 1000).toISOString(), now: new Date(now + 1000).toISOString(), interval_ms: 60000, max_gap_ms: 300000, stale_after_ms: 120000, mode: 'last', space: 'none' });
    expect(result[0].value).toEqual(rate.value); expect(result[0].sources[0].versions.package_id).toBe('mysql-representative');
    expect((await storage.inventory('instance', '71'))?.attributes['db.version'].value).toBe(resource.attributes['db.version'].value);
  });
  it('opt-in Worker publishes under captured source ticket and rejects a switched generation atomically', async () => {
    const control = new RolloutControl(pool), ticket = { source: 'v2', generation: 1, revision: 1 };
    const prior = await outputs(), at = prior.at(-1)!.observed_at;
    const series = prior.filter(o => o.observed_at === at);
    for (const o of series) {
      await control.initialize(o, { source: 'v2', read: 'v2', revision: 1, package: pin });
      await control.applied(o, ticket);
    }
    now += 60000; const s = setup(ticket); expect(await s.scheduler.tick()).toBe(1); await ready(); expect(await s.run()).toBe('completed');
    expect((await control.current(series[0])).latest).not.toBeNull();
    const before = (await pool.query<any[]>('SELECT COUNT(*) AS n FROM metric_v2_publications'))[0][0].n;
    expect(Number(before)).toBe(series.length);
    await control.switch(series[0], 1, { source: 'legacy', read: 'legacy', revision: 2, package: pin });
    now += 60000; expect(await s.scheduler.tick()).toBe(1); await ready(); expect(await s.run()).not.toBe('completed');
    expect((await pool.query<any[]>('SELECT COUNT(*) AS n FROM metric_v2_publications'))[0][0].n).toBe(before);
    if (process.env.MAX76_DATABASE_REPORT) await writeFile(process.env.MAX76_DATABASE_REPORT, JSON.stringify({
      evidence: 'real isolated MySQL target + Worker + persistence; legacy counter comparison uses the same measured inputs',
      collector_wall_ms: collectorWallMs, observations: await outputs(), events: (await pool.query('SELECT revision, code, uncertain, duration_ms, logical_reads FROM metric_v2_schedule_events'))[0],
      unique_publisher_switch: 'passed', late_worker_batch: 'rolled back',
    }, null, 2) + '\n');
  });
});
