import { historicalTemplatePayload } from './configuration-history.fixture.js';
import { decodeBindingPayload } from '../bindings/persistence-codec.js';
import { runPackage } from '../packages/runner.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MetricScheduler } from '../scheduler/service.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
/** Real isolated MySQL + public handler. No remote target or model calls. */
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import Fastify from 'fastify';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../../testing/owned-fixture.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { actorContextService } from '../../auth/actor-context.js';
import { dbConnection } from '../../db-connection.js';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { PolicyService } from './service.js';
import { MysqlPolicyStore } from './store.js';
import { admin, at, pin, resource } from './test-support.js';
import { TemplateBindingService } from '../templates/binding-service.js';
import { registerMetricTemplateRoutes } from '../templates/routes.js';
import { configurationHistoryRecord, appendConfigurationHistory } from './configuration-history.js';
import { ConfigurationAtSchema } from '../../contracts/metrics/configuration-history.js';

const port = Number(process.env.MAX238_HISTORY_MYSQL_PORT);
const ref = { type: 'instance' as const, id: 1 };
describe.skipIf(!port)('configuration history on owned MySQL', () => {
  let pool: Pool, root: mysql.Connection, owned: OwnedDatabase, policies: PolicyService, store: MysqlPolicyStore;
  let app: ReturnType<typeof Fastify>;
  const registry = createBuiltinRegistry();
  const read = (revision: number, id = 1) => app.inject({ method: 'GET', url: `/api/metrics/configuration-history/instance/${id}/${revision}` });
  const rows = async (sql: string, args: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, args))[0];
  beforeAll(async () => {
    if (!Number.isSafeInteger(port) || port === 3306) throw new Error('isolated non3306 required');
    root = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' });
    owned = await createOwnedDatabase(root, { nonce: generateRunNonce(), purpose: 'confighistory', handleDir: join(process.cwd(), '.max238-history-handles') });
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database: owned.database, connectionLimit: 10 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    await pool.execute('UPDATE users SET session_version = 1 WHERE id = 1');
    await pool.execute("INSERT IGNORE INTO roles (id, name) VALUES (1,'admin')");
    await pool.execute("INSERT IGNORE INTO permissions (id, code) VALUES (1,'instance:manage')");
    await pool.execute('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (1,1)');
    await pool.execute('INSERT IGNORE INTO user_roles (user_id,role_id) VALUES (1,1)');
    await pool.execute(`INSERT INTO database_instances (id,name,environment,db_type,host,port,username,password_encrypted,status,lifecycle_state)
      VALUES (1,'history-fixture','testing','mysql','fixture.invalid',1,'fixture','','active','available')`);
    store = new MysqlPolicyStore(() => pool);
    policies = new PolicyService(store, registry, { exists: async () => true, inventory: async r => resource(r.id) }, () => at);
    const service = new TemplateBindingService({ pool: () => pool, registry,
      access: { resolve: async () => { throw new Error('history must not collect'); } } as never,
      reload: a => actorContextService.revalidateActor(a),
      reloadOn: (a, c) => actorContextService.revalidateActorOn(c, a),
      reloadOnLocked: (a, c) => actorContextService.revalidateActorOn(c, a, a.requestId, true) });
    app = Fastify();
    await registerMetricTemplateRoutes(app, async req => { (req as unknown as { user: typeof admin }).user = admin; }, service);
    await app.ready();
  }, 180000);
  afterAll(async () => {
    await app?.close(); vi.restoreAllMocks();
    await pool?.end(); if (owned) await owned.drop(); await root?.end();
  }, 60000);

  it('publishes, records application, changes cadence, and preserves the prior effective settings after failed application', async () => {
    await policies.changeBinding(admin, ref, { expected_revision: 0, package: pin,
      overrides: { interval_ms: { mode: 'set', value: 60000 }, stale_after_ms: { mode: 'set', value: 180000 } } }, true);
    let old = (await read(1)).json(); expect(old.state).toBe('published'); expect(old.evidence).toEqual([]);
    await store.reportApplied(ref, 1, at, 'applied');
    old = (await read(1)).json(); expect(old.state).toBe('effective'); expect(old.settings.interval_ms).toBe(60000);
    expect(old.evidence[0].basis).toBe('application_report'); ConfigurationAtSchema.parse(old);
    await policies.changeBinding(admin, ref, { expected_revision: 1, overrides: { interval_ms: { mode: 'set', value: 120000 } } }, true);
    await store.reportApplied(ref, 2, at, 'failed');
    expect((await read(1)).json()).toEqual(old);
    const current = (await read(2)).json(); expect(current.state).toBe('published'); expect(current.settings.interval_ms).toBe(120000);
    expect((await policies.binding(admin, ref)).application.applied_revision).toBe(1);
  });
  it('CAS permits one concurrent revision; failed transaction creates no snapshot and retains previous effective version', async () => {
    const attempts = await Promise.allSettled([90000, 180000].map(value => policies.changeBinding(admin, ref,
      { expected_revision: 2, overrides: { interval_ms: { mode: 'set', value } } }, true)));
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    expect((await read(3)).json().state).toBe('published');
    const before = await rows('SELECT * FROM metric_policy_bindings');
    await expect(store.transaction(async tx => { const value = (await tx.binding(ref))!; value.binding.revision = 4; value.resolved.plan.binding.config_revision = 4;
      await tx.saveBinding(value, false); throw new Error('controlled post-insert failure'); })).rejects.toThrow('controlled post-insert failure');
    expect(await rows('SELECT * FROM metric_policy_bindings')).toEqual(before);
    expect((await read(4)).json().state).toBe('unknown'); expect((await read(1)).json().settings.interval_ms).toBe(60000);
  });
  it('records a real leased handler activation for a disabled plan without remote IO or samples', async () => {
    await pool.execute(`INSERT INTO database_instances (id,name,environment,db_type,host,port,username,password_encrypted,status,lifecycle_state)
      VALUES (2,'disabled-fixture','testing','mysql','fixture.invalid',1,'fixture','','active','available')`);
    const disabled = { ...ref, id: 2 };
    await policies.changeBinding(admin, disabled, { expected_revision: 0, package: pin, overrides: { enabled: 'disable' } }, true);
    const schedule = new MysqlScheduleStore(pool, registry);
    let now = Date.now();
    const scheduler = new MetricScheduler(schedule, registry, { resolve: async () => { throw new Error('no remote IO'); } }, () => now);
    const jobs = new JobRegistry(); scheduler.register(jobs);
    const queue = new MysqlWorkflowStore(() => pool as never);
    const worker = new WorkerRuntime(queue, 'history-fixture', 30);
    const published = await policies.binding(admin, disabled);
    await schedule.enqueue(published, now); now += 10000; await schedule.enqueue(published, now);
    await pool.query("UPDATE workflow_jobs SET available_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE state = 'queued'");
    await worker.runOnce((job, ctx) => jobs.execute(job, ctx), now);
    const result = (await read(1, 2)).json();
    expect(result.state).toBe('effective'); expect(result.settings.enabled).toBe(false);
    expect(result.evidence.some((e: { basis: string }) => e.basis === 'scheduler_activation')).toBe(true);
    expect(await rows('SELECT * FROM metric_observations')).toHaveLength(0);
  });
  it('missing, corrupt hash, wrong resource and conflicting settings are unknown or refused; reads do not write', async () => {
    const before = await rows('SELECT * FROM metric_policy_audit');
    expect((await read(999)).json().state).toBe('unknown');
    expect((await read(1, 999)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/metrics/configuration-history/instance/1/1x' })).statusCode).toBe(400);
    expect(await rows('SELECT * FROM metric_policy_audit')).toEqual(before);
    const current = (await policies.binding(admin, ref));
    const broken = configurationHistoryRecord(current, 'publication', at); broken.configuration_history.digest = `sha256:${'0'.repeat(64)}`;
    const [insert] = await pool.execute<mysql.ResultSetHeader>('INSERT INTO metric_policy_audit(target,payload) VALUES (?,?)', ['instance:1', JSON.stringify(broken)]);
    expect((await read(3)).statusCode).toBe(409);
    await pool.execute('DELETE FROM metric_policy_audit WHERE id = ?', [insert.insertId]);
    const conflicting = structuredClone(current); conflicting.resolved.settings.interval_ms = 60000;
    conflicting.resolved.plan.policy.interval_ms = 60000;
    const c = await pool.getConnection();
    try { await c.beginTransaction(); await appendConfigurationHistory(c, conflicting, 'publication', at); await c.commit(); }
    finally { c.release(); }
    expect((await read(3)).statusCode).toBe(409);
    expect((await read(1)).json().settings.interval_ms).toBe(60000);
    expect((await rows("SELECT COUNT(*) n FROM workflow_jobs WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resource.id')) = '1'"))[0].n).toBe(0);
    expect(await rows('SELECT * FROM metric_observations')).toHaveLength(0);
  });
  it('the real formal writer atomically preserves settings and exact fixture sample IDs; rollback leaves neither', async () => {
    // Controlled collector output only. This directly tests the shared writer storage hook,
    // not a remote collection, a public template admission or a template lease fence.
    const writer = new MysqlScheduleStore(pool, registry);
    const write = async (revision: number, rollback: boolean) => {
      const decoded = decodeBindingPayload(historicalTemplatePayload(60000, revision));
      if (decoded.kind !== 'template_pending') throw new Error('fixture');
      const result = await runPackage(registry, { package: pin, credential_ref: 'credential:fixture', overrides: {} }, {
        resource: resource(), binding_id: 'instance:1', attempt_id: `history-${revision}`, config_revision: revision,
        observed_at: '2026-11-01T00:00:01.000Z', clock: () => '2026-11-01T00:00:01.000Z', evidence: {},
        collect: async () => [{ dimensions: {}, fields: { Uptime: { encoding: 'float64', value: 10 } } }],
        resolve: async () => ({ method: 'sql', pool: { query: async () => { throw new Error('remote IO forbidden'); } } }),
      });
      const c = await pool.getConnection();
      try {
        await c.beginTransaction(); await c.query('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
        const [original] = await c.query<mysql.RowDataPacket[]>("SELECT payload FROM metric_policy_bindings WHERE resource_key='instance:1'");
        // The formal writer now requires the matching live template revision.
        await c.execute("UPDATE metric_policy_bindings SET payload=? WHERE resource_key='instance:1'", [JSON.stringify(decoded.payload)]);
        const written = await writer['writeTemplateResults'](c, { decoded, plan: decoded.pending.plan, states: new Map(), tickets: new Map() },
          [{ release: pin, result }], Date.parse('2026-11-01T00:00:01.000Z'));
        expect(written.samples.length).toBeGreaterThan(0);
        await c.execute("UPDATE metric_policy_bindings SET payload=? WHERE resource_key='instance:1'", [typeof original[0].payload === 'string' ? original[0].payload : JSON.stringify(original[0].payload)]);
        if (rollback) await c.rollback(); else await c.commit();
        return written;
      } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
    };
    const written = await write(10, false);
    const result = (await read(10)).json();
    expect(result).toMatchObject({ state: 'effective', settings: { interval_ms: 60000 } });
    expect(result.evidence[0].sample_ids).toEqual(written.samples.map(s => s.id));
    for (const sample of written.samples) expect(await rows('SELECT id FROM metric_observations WHERE id = ?', [sample.id])).toHaveLength(1);
    const rolledBack = await write(11, true);
    for (const sample of rolledBack.samples) expect(await rows('SELECT id FROM metric_observations WHERE id = ?', [sample.id])).toHaveLength(0);
    expect((await read(11)).json().state).toBe('unknown');
  });
  it('revocation during real policy lock wait denies before returning any history', async () => {
    const lock = await pool.getConnection(); await lock.beginTransaction();
    await lock.query('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
    const pending = read(1).then(r => r);
    const publish = policies.changeBinding(admin, ref, { expected_revision: 3 }, true, undefined, false,
      () => actorContextService.revalidateActor(admin)).then(() => 'published', () => 'denied');
    let waits = 0;
    for (let i = 0; i < 100; i++) {
      waits = Number((await rows('SELECT COUNT(*) n FROM performance_schema.data_lock_waits'))[0].n);
      if (waits) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waits).toBeGreaterThan(0);
    await pool.execute('UPDATE users SET session_version = 2 WHERE id = 1');
    await lock.commit(); lock.release();
    expect(await publish).toBe('denied');
    expect((await rows("SELECT JSON_EXTRACT(payload, '$.binding.revision') r FROM metric_policy_bindings WHERE resource_key = 'instance:1'"))[0].r).toBe(3);
    const result = await pending; expect(result.statusCode).toBe(401); expect(result.json().settings).toBeUndefined();
    await pool.execute('UPDATE users SET session_version = 1 WHERE id = 1');
  });
});
