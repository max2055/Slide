/**
 * MAX-238 / NATIVE-COLLECT-NOW — one real user action, one durable task, the
 * exact formal samples it committed, and the recovery semantics around it.
 *
 * The platform database and the target database are disposable MySQL 8.4
 * schemas created by this run's own nonce (never 3306); the target account is a
 * nonce-named read-only user. The binding is established through the real
 * routes (probe → preview → trial → apply) against that target, then each
 * collection is admitted through the real service and executed by the existing
 * WorkerRuntime + JobRegistry + formal writer.
 *
 * Skipped unless explicitly enabled:
 *   MAX238_COLLECT_NOW=1 MAX238_TEST_MYSQL_PORT=… MAX238_TEST_MYSQL_PASSWORD=… \
 *   MAX238_TARGET_PASSWORD=… pnpm --filter slide-api exec vitest run \
 *   src/metrics/templates/collect-now.mysql.test.ts
 */
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection, encryptData } from '../../db-connection.js';
import { databaseService } from '../../database-service.js';
import { actorContextService } from '../../auth/actor-context.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { createAssetCollectorAccess } from '../config/access.js';
import { MySqlTemplateRepository } from './mysql-repository.js';
import { MetricTemplateService } from './service.js';
import { TemplateBindingService } from './binding-service.js';
import { CollectNowService, createCollectNowAuthorizer } from './collect-now.js';
import { registerMetricTemplateRoutes } from './routes.js';
import { MysqlScheduleStore, COLLECT_NOW_JOB_TYPE } from '../scheduler/store.js';
import { MetricScheduler } from '../scheduler/service.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import {
  createOwnedDatabase, dropOwnedDatabase, generateRunNonce, type OwnedDatabase,
} from '../../testing/owned-fixture.js';

const enabled = process.env.MAX238_COLLECT_NOW === '1';
const PORT = Number(process.env.MAX238_TEST_MYSQL_PORT);
const PASSWORD = process.env.MAX238_TEST_MYSQL_PASSWORD ?? '';
const TARGET_PASSWORD = process.env.MAX238_TARGET_PASSWORD ?? '';
const NONCE = process.env.MAX238_RUN_NONCE ?? generateRunNonce();
const TARGET_USER = `max238_ro_${createHash('sha256').update(NONCE).digest('hex').slice(0, 16)}`;
const HANDLE_DIR = process.env.MAX238_HANDLE_DIR ?? join(process.cwd(), '.max238-handles');

const actor = {
  userId: 0, username: 'max238-collect-now', roles: ['admin'], permissions: ['*'],
  sessionVersion: 1, instanceScopes: {} as Record<number, 'admin'>, requestId: 'max238-collect-now',
} as unknown as ActorContext;

describe.skipIf(!enabled)('immediate collection on a real platform, queue and read-only target', () => {
  let pool: Pool;
  let app: ReturnType<typeof Fastify>;
  let platform: OwnedDatabase;
  let target: OwnedDatabase;
  let instanceId = 0;
  let unboundId = 0;
  let templateId = '';
  let templateVersion = 0;
  let contentHash = '';
  let worker: WorkerRuntime;
  let jobs: JobRegistry;
  let scheduleStore: MysqlScheduleStore;
  let accessCheckHook: (() => Promise<void>) | undefined;
  const registry = createConfigurationRegistry();
  const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const response = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body }) });
    return { status: response.statusCode, data: response.json() as Record<string, unknown> };
  };
  const body = () => ({
    expected_revision: 0,
    template_pins: [{ template_id: templateId, version: templateVersion, content_hash: contentHash }],
    overrides: { enabled: 'enable', interval_ms: { mode: 'set', value: 30000 }, max_rows: { mode: 'set', value: 50 } },
  });
  const observations = async (id: string) => (await pool.query<RowDataPacket[]>(
    "SELECT payload FROM metric_observations WHERE stage = 'normalized' AND id = ?", [id]))[0]
    .map(row => (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>);
  const counts = async () => ({
    jobs: Number((await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) c FROM workflow_jobs WHERE job_type = 'metrics.collect_now'"))[0][0].c),
    requests: Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) c FROM metric_collect_requests'))[0][0].c),
    observations: Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) c FROM metric_observations'))[0][0].c),
    operations: Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) c FROM metric_policy_operations'))[0][0].c),
    audits: Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) c FROM metric_policy_audit'))[0][0].c),
  });
  /** Drain every runnable job so one scenario never leaves work for the next. */
  const drain = async () => {
    await pool.query("UPDATE workflow_jobs SET available_at = NOW() WHERE state IN ('queued','retry')");
    for (let index = 0; index < 10; index++) {
      const result = await worker.runOnce((job, context) => jobs.execute(job, context), Date.now());
      if (result === 'idle') return;
      await pool.query("UPDATE workflow_jobs SET available_at = NOW() WHERE state IN ('queued','retry')");
    }
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
    const root = await mysql.createConnection({ host: '127.0.0.1', port: PORT, user: 'root', password: PASSWORD });
    try {
      platform = await createOwnedDatabase(root, { nonce: NONCE, purpose: 'collect', handleDir: HANDLE_DIR });
      target = await createOwnedDatabase(root, { nonce: NONCE, purpose: 'collecttarget', handleDir: HANDLE_DIR });
      await root.query(`CREATE TABLE \`${target.database}\`.probe (id INT PRIMARY KEY)`);
      await root.query(`INSERT INTO \`${target.database}\`.probe VALUES (1)`);
      await root.query(`CREATE USER '${TARGET_USER}'@'%' IDENTIFIED BY ?`, [TARGET_PASSWORD]);
      await root.query(`GRANT SELECT ON \`${target.database}\`.* TO '${TARGET_USER}'@'%'`);
      await root.query(`GRANT PROCESS ON *.* TO '${TARGET_USER}'@'%'`);
    } catch (error) { await root.end(); throw error; }
    await root.end();

    pool = mysql.createPool({ host: '127.0.0.1', port: PORT, user: 'root', password: PASSWORD,
      database: platform.database, timezone: 'Z', connectionLimit: 12 });
    pool.on('connection', connection => connection.query("SET time_zone='+00:00'"));
    const runner = new MigrationRunner(pool as unknown as MigrationPool);
    await runner.run();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);

    // A real principal whose live session and resource grant the worker re-reads.
    // The baseline migration seeds user 1; this adds the exact permission shape.
    await pool.execute('UPDATE users SET session_version = 1 WHERE id = 1');
    await pool.execute("INSERT IGNORE INTO roles (id, name) VALUES (1, 'admin')");
    await pool.execute("INSERT IGNORE INTO permissions (id, code) VALUES (1, 'instance:manage')");
    await pool.execute('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (1, 1)');
    await pool.execute('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (1, 1)');
    (actor as unknown as { userId: number }).userId = 1;

    const now = new Date().toISOString();
    const insertInstance = async (name: string): Promise<number> => {
      await pool.execute(`INSERT INTO database_instances
        (name, environment, db_type, db_version, host, port, username, password_encrypted, database_name, status,
         lifecycle_state, max_connections, connection_timeout_ms, created_by, created_at, updated_at)
        VALUES (?, 'testing', 'mysql', '8.4', '127.0.0.1', ?, ?, ?, ?, 'active', 'available', 10, 5000, 1, ?, ?)`,
      [name, PORT, TARGET_USER, encryptData(TARGET_PASSWORD), target.database,
        now.replace('T', ' ').replace('Z', ''), now.replace('T', ' ').replace('Z', '')]);
      return Number((await pool.query<RowDataPacket[]>('SELECT id FROM database_instances WHERE name = ?', [name]))[0][0].id);
    };
    instanceId = await insertInstance('max238-collect-bound');
    unboundId = await insertInstance('max238-collect-unbound');
    const targetConfig = { host: '127.0.0.1', port: PORT, user: TARGET_USER, password: TARGET_PASSWORD,
      database: target.database, db_type: 'mysql' as const };
    expect(await databaseService.addConnection(instanceId, 'max238-collect-bound', targetConfig)).toBe(true);
    expect(await databaseService.addConnection(unboundId, 'max238-collect-unbound', targetConfig)).toBe(true);
    await pool.execute("INSERT IGNORE INTO instance_permissions (user_id, instance_id, access_level) VALUES (1, ?, 'admin')", [instanceId]);
    await pool.execute("INSERT IGNORE INTO instance_permissions (user_id, instance_id, access_level) VALUES (1, ?, 'admin')", [unboundId]);
    (actor as unknown as { instanceScopes: Record<number, string> }).instanceScopes = {
      [instanceId]: 'admin', [unboundId]: 'admin',
    };

    // One real immutable template with the metric the accepted probe can read.
    const repository = new MySqlTemplateRepository(pool as never);
    const templates = new MetricTemplateService(repository, registry);
    const template = await templates.create(actor as never, { name: `MAX238 collect now ${process.pid}` });
    const release = registry.list().map(entry => entry.package)
      .find(pkg => pkg.id === 'mysql-representative' && pkg.version === '1.0.0')!;
    const packagePin = { id: release.id, version: release.version, digest: release.digest };
    const selected = await templates.selectMetric(actor as never, template.template_id,
      { package: packagePin, metric: { id: 'mysql.processlist.count', semantic_version: '1.0.0' } });
    const draft = await repository.getDraft(template.template_id);
    const aggregate = structuredClone(draft!.aggregate) as Record<string, unknown>;
    aggregate.items = [{ item_id: selected.item.item_id, version: selected.item.version }];
    await repository.updateDraft(template.template_id, draft!.revision,
      { aggregate: aggregate as never, updated_by: 1, updated_at: now });
    const afterDraft = await repository.getDraft(template.template_id);
    const published = await templates.publish(actor as never, template.template_id,
      { expected_draft_revision: afterDraft!.revision, expected_revision: template.revision });
    const record = await repository.getTemplate(template.template_id);
    await repository.updateTemplate(template.template_id, record!.revision,
      { status: 'active', updated_at: new Date(Date.parse(now) + 1000).toISOString() });
    const version = await repository.getVersion(template.template_id, published.version);
    templateId = template.template_id;
    templateVersion = published.version;
    contentHash = version!.content_hash;

    const service = new TemplateBindingService({
      pool: () => pool, registry, access: createAssetCollectorAccess(),
      reload: async () => actor, inventory: undefined,
    });
    const collectService = new CollectNowService({
      pool: () => pool, registry,
      reload: current => actorContextService.revalidateActor(current, current.requestId),
      reloadOn: (current, executor) => actorContextService.revalidateActorOn(executor as never, current, current.requestId, true),
    });
    app = Fastify();
    const auth = async (request: unknown) => {
      (request as { user?: ActorContext }).user = actor;
    };
    await registerMetricTemplateRoutes(app, auth, service, collectService);
    await app.ready();

    // The real binding path against the real read-only target.
    const probed = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/probe`, body());
    expect(probed.status, JSON.stringify(probed.data)).toBe(200);
    const trial = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/trial`,
      { ...body(), receipt_id: `collect-trial-${process.pid}` });
    expect(trial.status, JSON.stringify(trial.data)).toBe(200);
    const applied = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/apply`,
      { ...body(), receipt_id: `collect-trial-${process.pid}`, caller_key: `collect-apply-${process.pid}` });
    expect(applied.status, JSON.stringify(applied.data)).toBe(200);
    expect(applied.data).toMatchObject({ kind: 'committed', revision: 1 });

    // The existing queue, worker and formal writer; the same access object the trial used.
    const store = scheduleStore = new MysqlScheduleStore(pool, registry, 'production');
    const authorizer = createCollectNowAuthorizer({
      loadActor: (userId, sessionVersion) => actorContextService.loadActiveActor(userId, sessionVersion),
      loadActorOn: (executor, userId, sessionVersion) =>
        actorContextService.loadActiveActorOn(executor as never, userId, sessionVersion, undefined, true),
    });
    const access = createAssetCollectorAccess();
    const scheduler = new MetricScheduler(store, registry, { async resolve(ref) {
      const resolved = await access.resolve(ref);
      return { ...resolved, assertCurrent: async () => { await resolved.assertCurrent?.(); await accessCheckHook?.(); } };
    } },
      Date.now, undefined, undefined, authorizer);
    jobs = new JobRegistry(); scheduler.register(jobs);
    worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as never), `collect-now-${process.pid}`, 30);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    const root = await mysql.createConnection({ host: '127.0.0.1', port: PORT, user: 'root', password: PASSWORD });
    const errors: unknown[] = [];
    try {
      await root.query(`DROP USER IF EXISTS '${TARGET_USER}'@'%'`).catch(error => errors.push(error));
      await dropOwnedDatabase(root, { nonce: NONCE, purpose: 'collecttarget', handleDir: HANDLE_DIR }).catch(error => errors.push(error));
      await dropOwnedDatabase(root, { nonce: NONCE, purpose: 'collect', handleDir: HANDLE_DIR }).catch(error => errors.push(error));
    } finally { await root.end(); }
    if (errors.length) throw errors[0];
  });

  it('admits exactly one queryable task and commits the samples of that task alone', async () => {
    const before = await counts();
    const request = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`,
      { caller_key: `collect-one-${process.pid}`, expected_revision: 1 });
    expect(request.status, JSON.stringify(request.data)).toBe(200);
    expect(request.data).toMatchObject({ collect: true, state: 'accepted' });
    const task = request.data.task as { id: string; job_id: string; revision: number };
    expect(task.revision).toBe(1);
    expect(request.data.samples).toEqual([]);

    // A task exists before any execution; the cadence row was not changed.
    expect((await counts()).jobs - before.jobs).toBe(1);
    expect((await counts()).requests - before.requests).toBe(1);
    const schedule = (await pool.query<RowDataPacket[]>('SELECT job_id, revision FROM metric_schedule WHERE resource_key = ?',
      [`instance:${instanceId}`]))[0];
    expect(schedule[0]?.job_id ?? null).toBeNull();

    await drain();
    const answer = await call('GET', `/api/metrics/template-bindings/instance/${instanceId}/collect/collect-one-${process.pid}`);
    expect(answer.status, JSON.stringify(answer.data)).toBe(200);
    expect(answer.data).toMatchObject({ state: 'completed', task: { id: task.id, job_id: task.job_id, outcome: 'sampled' } });
    const samples = answer.data.samples as Array<{ id: string; metric: { id: string }; unit: string; value: unknown; observed_at: string }>;
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every(sample => sample.metric.id === 'mysql.processlist.count')).toBe(true);

    // Each returned identity is the row this job committed, with the same value,
    // unit and time; the revision's sample snapshot names exactly these ids.
    for (const sample of samples) {
      const [row] = await observations(sample.id);
      expect(row, sample.id).toBeDefined();
      expect(row.metric).toEqual(sample.metric);
      expect(row.value).toEqual(sample.value);
      expect(row.unit).toBe(sample.unit);
      expect(row.observed_at).toBe(sample.observed_at);
      expect(row.source).toMatchObject({ binding_id: `instance:${instanceId}` });
    }
    const snapshot = (await pool.query<RowDataPacket[]>('SELECT payload FROM metric_source_checks WHERE resource_key = ? AND revision = ?',
      [`instance:${instanceId}`, 1]))[0][0];
    const ids = (typeof snapshot.payload === 'string' ? JSON.parse(snapshot.payload) : snapshot.payload).sample_ids as string[];
    expect([...ids].sort()).toEqual(samples.map(sample => sample.id).sort());

    // Collection is not a configuration publication.
    const after = await counts();
    expect(after.operations).toBe(before.operations);
    expect(after.audits).toBe(before.audits);
  }, 120_000);

  it('replays the same key without a second job, request or sample', async () => {
    const key = `collect-one-${process.pid}`;
    const before = await counts();
    const replay = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`,
      { caller_key: key, expected_revision: 1 });
    expect(replay.status, JSON.stringify(replay.data)).toBe(200);
    expect(replay.data.state).toBe('completed');
    const queried = await call('GET', `/api/metrics/template-bindings/instance/${instanceId}/collect/${key}`);
    expect((replay.data.task as { id: string }).id).toBe((queried.data.task as { id: string }).id);
    const after = await counts();
    expect(after.jobs).toBe(before.jobs);
    expect(after.requests).toBe(before.requests);
    expect(after.observations).toBe(before.observations);
  }, 60_000);

  it('refuses a stale revision, an unbound resource and a key reused by another principal', async () => {
    const before = await counts();
    const stale = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`,
      { caller_key: `collect-stale-${process.pid}`, expected_revision: 2 });
    expect(stale.status).toBe(409);
    expect(stale.data.error).toBe('COLLECT_REVISION_CONFLICT');
    const unbound = await call('POST', `/api/metrics/template-bindings/instance/${unboundId}/collect`,
      { caller_key: `collect-unbound-${process.pid}`, expected_revision: 1 });
    expect(unbound.status).toBe(409);
    expect(unbound.data.error).toBe('COLLECT_BINDING_NOT_TEMPLATE');
    // The same key under a different signed principal must not replay this task.
    const conflict = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`,
      { caller_key: `collect-one-${process.pid}`, expected_revision: 1 });
    expect(conflict.status).toBe(200); // same principal in this route fixture: a replay
    const store = new MysqlScheduleStore(pool, registry);
    await expect(store.admitCollectNow({
      ref: { type: 'instance', id: instanceId }, actorId: 2, sessionVersion: 1,
      callerKey: `collect-one-${process.pid}`, expectedRevision: 1,
    }, async () => undefined)).rejects.toMatchObject({ code: 'COLLECT_INTENT_CONFLICT' });
    const after = await counts();
    expect(after.jobs).toBe(before.jobs);
    expect(after.requests).toBe(before.requests);
  }, 60_000);

  it('two concurrent same-key admissions produce one task and one job', async () => {
    const before = await counts();
    const key = `collect-concurrent-${process.pid}`;
    const [left, right] = await Promise.all([
      call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`, { caller_key: key, expected_revision: 1 }),
      call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`, { caller_key: key, expected_revision: 1 }),
    ]);
    expect(left.status, JSON.stringify(left.data)).toBe(200);
    expect(right.status, JSON.stringify(right.data)).toBe(200);
    expect((left.data.task as { id: string }).id).toBe((right.data.task as { id: string }).id);
    const after = await counts();
    expect(after.jobs - before.jobs).toBe(1);
    expect(after.requests - before.requests).toBe(1);
    // Leave no queued work behind for the next case.
    await drain();
  }, 60_000);

  it('a revoked live session refuses the task before any read and writes no sample', async () => {
    const before = await counts();
    const key = `collect-revoked-${process.pid}`;
    const admitted = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`,
      { caller_key: key, expected_revision: 1 });
    expect(admitted.status, JSON.stringify(admitted.data)).toBe(200);
    // The live principal changes after admission: the worker must not read or write.
    await pool.execute('UPDATE users SET session_version = 2 WHERE id = 1');
    try {
      await drain();
      const answer = await call('GET', `/api/metrics/template-bindings/instance/${instanceId}/collect/${key}`);
      // The query re-reads the live session too, so the route refuses it.
      expect(answer.status).toBe(401);
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT state, samples FROM metric_collect_requests WHERE caller_key = ?", [key]);
      expect(rows[0].state).toBe('unknown');
      expect(JSON.parse(rows[0].samples ?? '[]')).toEqual([]);
      expect((await counts()).observations).toBe(before.observations);
    } finally {
      await pool.execute('UPDATE users SET session_version = 1 WHERE id = 1');
    }
  }, 60_000);

  it('rechecks the live grant after waiting for the policy lock before remote SQL', async () => {
    const key = `collect-wait-revoke-${process.pid}`;
    const before = await counts();
    const admitted = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`,
      { caller_key: key, expected_revision: 1 });
    expect(admitted.status).toBe(200);
    const original = scheduleStore.assertCollectNow.bind(scheduleStore);
    let checks = 0, revoked = false, remoteAfter = 0;
    const create = mysql.createConnection.bind(mysql);
    const connectionSpy = vi.spyOn(mysql, 'createConnection').mockImplementation((async (...args: Parameters<typeof mysql.createConnection>) => {
      if (revoked) remoteAfter++;
      return create(...args);
    }) as typeof mysql.createConnection);
    const guard = vi.spyOn(scheduleStore, 'assertCollectNow').mockImplementation(async (...args) => {
      checks++;
      if (checks !== 6) return original(...args);
      const lock = await pool.getConnection();
      await lock.beginTransaction();
      await lock.query('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
      const waiting = original(...args);
      try {
        await new Promise(resolve => setTimeout(resolve, 80));
        await pool.execute('UPDATE users SET session_version = 2 WHERE id = 1');
        revoked = true;
      } finally { await lock.commit(); lock.release(); }
      return waiting;
    });
    try {
      await drain();
      expect(checks).toBeGreaterThanOrEqual(6);
      expect(remoteAfter).toBe(0);
      expect((await counts()).observations).toBe(before.observations);
    } finally {
      guard.mockRestore(); connectionSpy.mockRestore();
      await pool.execute('UPDATE users SET session_version = 1 WHERE id = 1');
    }
  }, 60_000);

  it('rechecks authorization after a delayed target identity check', async () => {
    const before = await counts();
    const admitted = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`,
      { caller_key: `collect-access-wait-${process.pid}`, expected_revision: 1 });
    expect(admitted.status).toBe(200);
    let checks = 0, revoked = false, remoteAfter = 0;
    const create = mysql.createConnection.bind(mysql);
    const spy = vi.spyOn(mysql, 'createConnection').mockImplementation((async (...args: Parameters<typeof mysql.createConnection>) => {
      if (revoked) remoteAfter++;
      return create(...args);
    }) as typeof mysql.createConnection);
    accessCheckHook = async () => {
      if (++checks === 5) {
        await pool.execute('UPDATE users SET session_version = 2 WHERE id = 1');
        revoked = true;
      }
    };
    try {
      await drain();
      expect(checks).toBeGreaterThanOrEqual(5);
      expect(remoteAfter).toBe(0);
      expect((await counts()).observations).toBe(before.observations);
    } finally {
      accessCheckHook = undefined;
      spy.mockRestore();
      await pool.execute('UPDATE users SET session_version = 1 WHERE id = 1');
    }
  }, 60_000);

  it('rejects a task when its admitted target changes before execution', async () => {
    const key = `collect-target-change-${process.pid}`;
    const before = await counts();
    const admitted = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`,
      { caller_key: key, expected_revision: 1 });
    expect(admitted.status).toBe(200);
    await pool.execute('UPDATE database_instances SET database_name = ? WHERE id = ?', ['information_schema', instanceId]);
    try {
      expect(await databaseService.addConnection(instanceId, 'max238-collect-bound', {
        host: '127.0.0.1', port: PORT, user: TARGET_USER, password: TARGET_PASSWORD,
        database: 'information_schema', db_type: 'mysql',
      })).toBe(true);
      await drain();
      const answer = await call('GET', `/api/metrics/template-bindings/instance/${instanceId}/collect/${key}`);
      expect(answer.data.state).not.toBe('completed');
      const after = await counts();
      expect(after.observations).toBe(before.observations);
      expect(after.operations).toBe(before.operations);
      expect(after.audits).toBe(before.audits);
    } finally {
      await pool.execute('UPDATE database_instances SET database_name = ? WHERE id = ?', [target.database, instanceId]);
      expect(await databaseService.addConnection(instanceId, 'max238-collect-bound', {
        host: '127.0.0.1', port: PORT, user: TARGET_USER, password: TARGET_PASSWORD,
        database: target.database, db_type: 'mysql',
      })).toBe(true);
    }
  }, 60_000);

  it('rejects a task when its credential changes after admission', async () => {
    const key = `collect-credential-change-${process.pid}`;
    const before = await counts();
    const admitted = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`,
      { caller_key: key, expected_revision: 1 });
    expect(admitted.status).toBe(200);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT password_encrypted FROM database_instances WHERE id = ?', [instanceId]);
    const originalCredential = rows[0].password_encrypted;
    await pool.execute('UPDATE database_instances SET password_encrypted = ? WHERE id = ?', [encryptData('rotated'), instanceId]);
    try {
      await drain();
      const answer = await call('GET', `/api/metrics/template-bindings/instance/${instanceId}/collect/${key}`);
      expect(answer.data.state).not.toBe('completed');
      expect((await counts()).observations).toBe(before.observations);
    } finally { await pool.execute('UPDATE database_instances SET password_encrypted = ? WHERE id = ?', [originalCredential, instanceId]); }
  }, 60_000);

  it('holds the live session grant through the transaction commit', async () => {
    const connection = await pool.getConnection();
    let update: Promise<unknown> | undefined;
    try {
      await connection.beginTransaction();
      await actorContextService.loadActiveActorOn(connection as never, 1, 1, undefined, true);
      let finished = false;
      update = pool.execute('UPDATE users SET session_version = 2 WHERE id = 1').then(() => { finished = true; });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(finished).toBe(false);
    } finally {
      await connection.commit();
      connection.release();
      await update;
      await pool.execute('UPDATE users SET session_version = 1 WHERE id = 1');
    }
  }, 60_000);

  it('serializes a session rotation against the real writer journal commit', async () => {
    const key = `collect-commit-lock-${process.pid}`;
    const admitted = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`,
      { caller_key: key, expected_revision: 1 });
    expect(admitted.status).toBe(200);
    const original = pool.getConnection.bind(pool);
    let rotation: Promise<unknown> | undefined;
    let completedBeforeJournal = false;
    let intercepted = false;
    const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
      const connection = await original();
      const execute = connection.execute.bind(connection);
      connection.execute = (async (sql: string, values?: unknown[]) => {
        if (!intercepted && sql.includes("UPDATE metric_collect_requests SET state = 'completed'")) {
          intercepted = true;
          let finished = false;
          rotation = pool.execute('UPDATE users SET session_version = 2 WHERE id = 1').then(() => { finished = true; });
          await new Promise(resolve => setTimeout(resolve, 150));
          completedBeforeJournal = finished;
        }
        return execute(sql, values as never);
      }) as typeof connection.execute;
      return connection;
    });
    try {
      await drain();
      expect(intercepted).toBe(true);
      expect(completedBeforeJournal).toBe(false);
      await rotation;
      const [rows] = await pool.query<RowDataPacket[]>('SELECT state, samples FROM metric_collect_requests WHERE caller_key = ?', [key]);
      expect(rows[0].state).toBe('completed');
      const samples = typeof rows[0].samples === 'string' ? JSON.parse(rows[0].samples) : rows[0].samples;
      expect(samples.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      await rotation;
      await pool.execute('UPDATE users SET session_version = 1 WHERE id = 1');
    }
  }, 60_000);

  it('the query refuses a revoked session instead of returning stale task facts', async () => {
    const key = `collect-one-${process.pid}`;
    await pool.execute('UPDATE users SET session_version = 2 WHERE id = 1');
    try {
      const denied = await call('GET', `/api/metrics/template-bindings/instance/${instanceId}/collect/${key}`);
      expect(denied.status).toBe(401);
    } finally { await pool.execute('UPDATE users SET session_version = 1 WHERE id = 1'); }
  }, 60_000);

  it('rejects a collection job whose payload does not match its persisted task', async () => {
    const admitted = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`,
      { caller_key: `collect-identity-${process.pid}`, expected_revision: 1 });
    expect(admitted.status).toBe(200);
    const job = admitted.data.task as { id: string; job_id: string };
    await expect(jobs.execute({
      id: job.job_id, type: COLLECT_NOW_JOB_TYPE, payload: { resource: { type: 'instance', id: instanceId },
        revision: 999, request_id: job.id }, attempts: 1, maxAttempts: 1, fencingToken: 1,
    }, { signal: new AbortController().signal, workerId: 'fixture', fencingToken: 1 }))
      .rejects.toMatchObject({ code: 'COLLECT_TASK_IDENTITY' });
  }, 60_000);
});
