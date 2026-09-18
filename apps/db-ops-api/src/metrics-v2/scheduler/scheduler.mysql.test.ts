import { readFileSync } from 'node:fs';
import mysql, { type Pool } from 'mysql2/promise';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { createBuiltinRegistry, builtinReleases } from '../packages/builtins.js';
import { sealRelease } from '../packages/model.js';
import { type DecodedRow, AdapterError } from '../packages/adapters.js';
import { MysqlMetricStorage } from '../storage.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin, pin, resource } from '../policy/test-support.js';
import { compilePlan } from './compiler.js';
import { MysqlScheduleStore, GLOBAL_CONCURRENCY } from './store.js';
import { MetricScheduler, type CollectorAccess } from './service.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/scheduler/fixtures.json', import.meta.url), 'utf8'));
const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
const ref = { type: 'instance' as const, id: 1 };
const batch = (queries = fixture.first.Queries): DecodedRow[] => [{ dimensions: {}, fields: {
  Uptime: { encoding: 'float64', value: fixture.first.Uptime }, Queries: { encoding: 'uint64', value: queries },
}, counter: { bits: '64', start_at: fixture.counter_start } }];
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

describe.skipIf(!port)('scheduler isolated MySQL + existing Worker', () => {
  let root: Pool, pool: Pool, store: MysqlScheduleStore, policies: PolicyService, queue: MysqlWorkflowStore;
  let now: number;
  const database = `max70_${process.pid}`;
  const packages = createBuiltinRegistry();
  const access: CollectorAccess = { resolve: async r => ({ resource: resource(r.id), credential_ref: `credential:resource-${r.id}`, evidence: {},
    resolve: async (_credential, actual) => {
      expect(actual.id).toBe(String(r.id));
      return { method: 'sql', pool: { query: async () => [[], []] } };
    } }) };
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', timezone: 'Z', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', timezone: 'Z', port, user: 'root', password: '', database, connectionLimit: 20 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
  }, 120000);
  afterAll(async () => { await pool?.end(); if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); } });
  beforeEach(async () => {
    now = Date.now() - 20000;
    for (const table of ['metric_v2_schedule', 'metric_v2_schedule_events', 'metric_v2_policy_bindings', 'metric_v2_policy_audit', 'metric_v2_observations', 'metric_v2_attempts', 'workflow_jobs']) await pool.query(`DELETE FROM ${table}`);
    store = new MysqlScheduleStore(pool, packages);
    queue = new MysqlWorkflowStore(() => pool as never);
    policies = new PolicyService(new MysqlPolicyStore(() => pool), packages, { exists: async () => true, inventory: async r => resource(r.id) }, () => new Date(now).toISOString());
  });
  const create = async (id = 1, interval = 60000) => (await policies.changeBinding(admin, { ...ref, id }, { expected_revision: 0, package: pin,
    overrides: { interval_ms: { mode: 'set', value: interval }, stale_after_ms: { mode: 'set', value: Math.max(interval, 120000) },
      max_counter_gap_ms: { mode: 'set', value: Math.max(interval, 300000) } } }, true)).resources[0];
  const setup = (collect = vi.fn(async () => batch()), customAccess = access) => {
    const scheduler = new MetricScheduler(store, packages, customAccess, () => now, collect);
    const registry = new JobRegistry(); scheduler.register(registry);
    const worker = (id: string, lease = 30) => new WorkerRuntime(queue, id, lease);
    const run = (w: WorkerRuntime) => w.runOnce((j, ctx) => registry.execute(j, ctx), now);
    return { scheduler, registry, collect, worker, run };
  };
  const enqueue = async (scheduler: MetricScheduler) => { await scheduler.tick(); now += 10000; return scheduler.tick(); };
  const rows = async (sql: string) => (await pool.query<any[]>(sql))[0];
  const outputs = () => rows('SELECT payload FROM metric_v2_observations');
  const expire = () => pool.query("UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 5 SECOND), available_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE state = 'running'");
  const ready = () => pool.query("UPDATE workflow_jobs SET available_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE state IN ('queued','retry')");

  it('deduplicates scans, one query yields multiple metrics and restart preserves cadence/counter state', async () => {
    await create(); const s = setup(); expect(await enqueue(s.scheduler)).toBe(1);
    expect(await s.scheduler.tick()).toBe(0);
    expect((await policies.binding(admin, ref)).application.applied_revision).toBeNull();
    expect(await s.run(s.worker('one'))).toBe('completed'); expect(s.collect).toHaveBeenCalledTimes(1);
    expect(await outputs()).toHaveLength(3);
    expect((await policies.binding(admin, ref)).application).toMatchObject({ status: 'applied', applied_revision: 1 });
    store = new MysqlScheduleStore(pool, packages);
    const restarted = setup(vi.fn(async () => batch(fixture.second.Queries)));
    now += 59999; expect(await restarted.scheduler.tick()).toBe(0);
    now++; expect(await restarted.scheduler.tick()).toBe(1); await ready();
    expect(await restarted.run(restarted.worker('restart'))).toBe('completed');
    const data = (await outputs()).map(r => typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload);
    expect(data.filter(o => o.metric.id === 'mysql.queries.per_second').some(o => o.value?.value === fixture.expected_rate)).toBe(true);
    expect(data.every(o => o.versions.config_revision === 1 && o.versions.transform_version === '1.0.0')).toBe(true);
    expect(await rows('SELECT logical_reads FROM metric_v2_schedule_events')).toEqual([{ logical_reads: 1 }, { logical_reads: 1 }]);
  });
  it('rejects invalid resolved configuration before scheduling or applied acknowledgement', async () => {
    const p = await create(); p.resolved.settings.interval_ms = 1;
    await expect(store.enqueue(p, now)).rejects.toThrow();
    expect(await rows('SELECT * FROM workflow_jobs')).toHaveLength(0);
    expect((await policies.binding(admin, ref)).application.applied_revision).toBeNull();
  });
  it('bounded retries and backoff do not form an immediate retry loop after dead letter', async () => {
    await create(); const s = setup(vi.fn(async () => { throw new AdapterError('timeout'); }));
    await enqueue(s.scheduler); const w = s.worker('retry');
    expect(await s.run(w)).toBe('retry');
    expect((await rows('SELECT attempts, state FROM workflow_jobs'))[0]).toMatchObject({ attempts: 1, state: 'retry' });
    await ready(); expect(await s.run(w)).toBe('retry');
    await ready(); expect(await s.run(w)).toBe('dead_letter');
    expect(s.collect).toHaveBeenCalledTimes(3); expect(await rows('SELECT id FROM metric_v2_attempts')).toHaveLength(3); expect(await s.scheduler.tick()).toBe(0);
    now += 59999; expect(await s.scheduler.tick()).toBe(0); now++;
    expect(await s.scheduler.tick()).toBe(1);
  });
  it('partial conversion failure commits healthy observations without retrying the batch', async () => {
    await create(); const partial = batch(); delete partial[0].fields.Queries;
    const s = setup(vi.fn(async () => partial)); await enqueue(s.scheduler);
    expect(await s.run(s.worker('partial'))).toBe('completed');
    expect((await rows('SELECT payload FROM metric_v2_attempts'))[0].payload.status).toBe('partial');
    expect((await outputs()).some(r => r.payload.metric.id === 'db.uptime_seconds')).toBe(true);
  });
  it('old owner cannot commit after lease expiry; held resource lock prevents overlapping requests on takeover', async () => {
    await create(); const gate = deferred<DecodedRow[]>(), entered = deferred<void>();
    const s = setup(vi.fn(async () => { entered.resolve(); return gate.promise; })); await enqueue(s.scheduler);
    const w1 = s.worker('old'), w2 = s.worker('new');
    const oldRun = s.run(w1); await entered.promise;
    await expire(); expect(await s.run(w2)).toBe('retry');
    expect(s.collect).toHaveBeenCalledTimes(1);
    gate.resolve(batch()); expect(await oldRun).toBe('retry');
    expect(await outputs()).toHaveLength(0);
    await ready(); expect(await s.run(w2)).toBe('completed');
    expect(s.collect).toHaveBeenCalledTimes(2); expect(await outputs()).toHaveLength(3);
    expect((await rows("SELECT code FROM metric_v2_schedule_events WHERE code = 'late_result_discarded'")).length).toBe(1);
  });
  it('timeout holds quarantine until an uncancellable request settles and discards its result', async () => {
    await create(); await policies.changeBinding(admin, ref, { expected_revision: 1, overrides: { timeout_ms: { mode: 'set', value: 250 } } }, true);
    const gate = deferred<DecodedRow[]>(), entered = deferred<void>();
    const s = setup(vi.fn(async () => { entered.resolve(); return gate.promise; })); await enqueue(s.scheduler);
    const w1 = s.worker('timeout'), w2 = s.worker('takeover');
    const running = s.run(w1); await entered.promise;
    // This wait tests the deadline only; lease expiry/takeover below is explicit SQL, never a sleep race.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await s.run(w1)).toBe('running');
    await expire(); expect(await s.run(w2)).toBe('retry'); expect(s.collect).toHaveBeenCalledTimes(1);
    gate.resolve(batch()); await running;
    expect(await outputs()).toHaveLength(0);
    expect((await rows("SELECT uncertain FROM metric_v2_schedule_events WHERE code = 'cancelled_result_uncertain'"))[0].uncertain).toBe(1);
  });
  it('rolls back outputs if the collection deadline expires during the storage transaction', async () => {
    await create(); await policies.changeBinding(admin, ref, { expected_revision: 1, overrides: { timeout_ms: { mode: 'set', value: 250 } } }, true);
    const entered = deferred<void>(), gate = deferred<void>();
    const original = MysqlMetricStorage.prototype.write;
    const write = vi.spyOn(MysqlMetricStorage.prototype, 'write').mockImplementation(async function (this: MysqlMetricStorage, input, definition) {
      entered.resolve(); await gate.promise; return original.call(this, input, definition);
    });
    const s = setup(); await enqueue(s.scheduler); const run = s.run(s.worker('commit-timeout'));
    try {
      await entered.promise;
      await vi.waitFor(async () => expect(await rows("SELECT id FROM metric_v2_schedule_events WHERE code = 'cancellation_requested'")).toHaveLength(1), { timeout: 2000 });
      gate.resolve(); expect(await run).toBe('retry'); expect(await outputs()).toHaveLength(0);
      expect((await rows("SELECT uncertain FROM metric_v2_schedule_events WHERE code = 'cancellation_requested'"))[0].uncertain).toBe(0);
    } finally { gate.resolve(); await run; write.mockRestore(); }
  });
  it('shutdown cancels cooperatively, drains noncooperative work, releases locks only after settlement', async () => {
    await create(); const gate = deferred<DecodedRow[]>(), entered = deferred<void>();
    const s = setup(vi.fn(async () => { entered.resolve(); return gate.promise; })); await enqueue(s.scheduler);
    const w = s.worker('shutdown'), running = s.run(w); await entered.promise;
    expect(await w.shutdown(5)).toBe(false);
    expect(await store.reserve(ref)).toBeNull();
    gate.resolve(batch()); expect(await running).toBe('cancelled'); expect(await w.shutdown()).toBe(true);
    expect(await outputs()).toHaveLength(0); const slot = await store.reserve(ref); expect(slot).not.toBeNull(); await slot!.release();
  });
  it('version/source switch keeps published/applied distinct and discards old results', async () => {
    await create(); const gate = deferred<DecodedRow[]>(), entered = deferred<void>();
    const s = setup(vi.fn(async () => { entered.resolve(); return gate.promise; })); await enqueue(s.scheduler);
    const running = s.run(s.worker('v1')); await entered.promise;
    const release = builtinReleases()[0]; release.package.version = '1.1.0';
    release.package.collectors[0].id = 'mysql-v2'; release.documentation[0].collector_id = 'mysql-v2';
    const next = packages.install(sealRelease(release));
    await policies.changeBinding(admin, ref, { expected_revision: 1, package: { id: next.package.id, version: next.package.version, digest: next.package.digest } }, true);
    expect((await policies.binding(admin, ref)).application).toMatchObject({ status: 'pending', applied_revision: 1 });
    gate.resolve(batch()); await running; expect(await outputs()).toHaveLength(0);
    expect(await enqueue(s.scheduler)).toBe(1); await ready(); expect(await s.run(s.worker('v2'))).toBe('completed');
    expect((await policies.binding(admin, ref)).application.applied_revision).toBe(2);
    expect((await outputs()).every(r => r.payload.versions.package_version === '1.1.0' && r.payload.versions.config_revision === 2)).toBe(true);
  });
  it('enforces shared global concurrency slots across store instances without resource-wide source exclusivity', async () => {
    const held = [];
    for (let id = 1; id <= GLOBAL_CONCURRENCY; id++) held.push((await store.reserve({ ...ref, id }))!);
    const other = new MysqlScheduleStore(pool, packages);
    expect(await other.reserve({ ...ref, id: 99 })).toBeNull(); expect(await other.reserve(ref)).toBeNull();
    await held.pop()!.release(); const next = await other.reserve({ ...ref, id: 99 }); expect(next).not.toBeNull();
    await next!.release(); for (const r of held) await r.release();
  });
  it('measures four concurrent collectors across five workers without exceeding the shared budget', async () => {
    for (let id = 1; id <= 5; id++) await create(id);
    const gate = deferred<DecodedRow[]>(), entered = Array.from({ length: 4 }, () => deferred<void>()); let active = 0, peak = 0;
    const s = setup(vi.fn(async () => {
      active++; peak = Math.max(peak, active); entered[active - 1].resolve();
      try { return await gate.promise; } finally { active--; }
    }));
    expect(await enqueue(s.scheduler)).toBe(5);
    const runs = [];
    // Order claims deterministically; collectors remain simultaneously in flight.
    for (let id = 1; id <= 4; id++) {
      const run = s.run(s.worker(`parallel-${id}`)); runs.push(run);
      await Promise.race([entered[id - 1].promise, run.then(value => { throw new Error(`collector did not enter: ${value}`); })]);
    }
    expect(await s.run(s.worker('parallel-5'))).toBe('retry');
    now += 15; gate.resolve(batch()); expect(await Promise.all(runs)).toEqual(Array(4).fill('completed'));
    expect(peak).toBe(fixture.global_concurrency); expect(s.collect).toHaveBeenCalledTimes(4);
    const events = await rows('SELECT duration_ms, logical_reads FROM metric_v2_schedule_events');
    expect(events).toEqual(Array(4).fill({ duration_ms: 15, logical_reads: 1 }));
  });
  it('disabled revision is applied without resolving any credential or issuing a request', async () => {
    await create(); await policies.changeBinding(admin, ref, { expected_revision: 1, overrides: { enabled: 'disable' } }, true);
    const resolve = vi.fn(access.resolve), s = setup(vi.fn(async () => batch()), { resolve });
    await enqueue(s.scheduler); expect(await s.run(s.worker('disabled'))).toBe('completed');
    expect(resolve).not.toHaveBeenCalled(); expect(s.collect).not.toHaveBeenCalled();
    expect((await policies.binding(admin, ref)).application.applied_revision).toBe(2);
  });
  it('instantiates discovered dimension identities through binding validation', async () => {
    const r = builtinReleases()[2], p = { id: r.package.id, version: r.package.version, digest: r.package.digest };
    const network = { type: 'network_device' as const, id: 3 };
    const inventory = { type: network.type, id: '3', attributes: { 'snmp.version': { value: 3, source: 'fixture', observed_at: new Date(now).toISOString() } } };
    const networkPolicy = new PolicyService(new MysqlPolicyStore(() => pool), packages, { exists: async () => true, inventory: async () => inventory }, () => new Date(now).toISOString());
    await networkPolicy.changeBinding(admin, network, { expected_revision: 0, package: p }, true);
    const networkAccess: CollectorAccess = { resolve: async ref => ({ resource: inventory, credential_ref: `credential:resource-${ref.id}`, evidence: {}, resolve: async () => ({ method: 'snmp', table: async () => [] }) }) };
    const collect = vi.fn(async (): Promise<DecodedRow[]> => [1, 2].map(i => ({ dimensions: { if_index: String(i), interface_epoch: 'generation-1' }, fields: { ifOperStatus: { encoding: 'float64', value: 1 } } })));
    const s = setup(collect, networkAccess); await enqueue(s.scheduler); expect(await s.run(s.worker('dimensions'))).toBe('completed');
    const data = (await outputs()).map(r => r.payload); expect(data).toHaveLength(2);
    expect(new Set(data.map(o => o.source.metric_binding_id)).size).toBe(2);
    expect(data.map(o => o.dimensions.if_index).sort()).toEqual(['1', '2']);
  });
  it('rejects a forged queue payload before credential resolution when it does not own the schedule', async () => {
    await create(); const resolve = vi.fn(access.resolve), s = setup(vi.fn(async () => batch()), { resolve });
    await queue.enqueue({ id: 'forged', type: 'metrics.collect', schemaVersion: 1, payload: { resource: ref, revision: 1 }, idempotencyKey: 'forged', availableAt: new Date(now) });
    expect(await s.run(s.worker('forged-worker'))).toBe('retry');
    expect(resolve).not.toHaveBeenCalled(); expect(s.collect).not.toHaveBeenCalled();
  });
  it('keeps independent slow and fast resource cadences after shared-query execution', async () => {
    await create(1, 120000); await create(2, 10000); const s = setup();
    await enqueue(s.scheduler); const w = s.worker('cadence');
    expect(await s.run(w)).toBe('completed'); expect(await s.run(w)).toBe('completed');
    now += 10000; expect(await s.scheduler.tick()).toBe(1); await ready(); expect(await s.run(w)).toBe('completed');
    const events = await rows('SELECT resource_key FROM metric_v2_schedule_events');
    expect(events.filter(e => e.resource_key === 'instance:1')).toHaveLength(1);
    expect(events.filter(e => e.resource_key === 'instance:2')).toHaveLength(2);
  });
  it('scopes credential resolution to the published resource and rejects mismatched inventory', async () => {
    await create(); const wrong: CollectorAccess = { resolve: async () => ({ ...await access.resolve(ref), resource: resource(999) }) };
    const s = setup(vi.fn(async () => batch()), wrong); await enqueue(s.scheduler);
    expect(await s.run(s.worker('wrong'))).toBe('retry'); expect(s.collect).not.toHaveBeenCalled(); expect(await outputs()).toHaveLength(0);
  });
});
