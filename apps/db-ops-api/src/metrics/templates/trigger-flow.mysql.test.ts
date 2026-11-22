/**
 * MAX-239 / TEMPLATE-TRIGGER-TO-EVENT-FLOW — one real user action, one durable task, the
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
 *   MAX239_FLOW=1 MAX238_TEST_MYSQL_PORT=… MAX238_TEST_MYSQL_PASSWORD=… \
 *   MAX238_TARGET_PASSWORD=… pnpm --filter slide-api exec vitest run \
 *   src/metrics/templates/trigger-flow.mysql.test.ts
 */
import { alertDatabaseService } from '../../alert-database-service.js';
import { alertEventService } from '../../alert-event-service.js';
import { registerTemplateTriggerRoutes } from '../triggers/routes.js';
import { metricPublicSchemas } from '../../contracts/metrics/public-api.js';
import { evaluateTemplateClock, evaluateTemplateSamples } from '../triggers/runtime.js';
import { decodeBindingPayload } from '../bindings/persistence-codec.js';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
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
  createOwnedDatabase,
  dropOwnedDatabase,
  generateRunNonce,
  type OwnedDatabase,
} from '../../testing/owned-fixture.js';

const enabled = process.env.MAX239_FLOW === '1';
const PORT = Number(process.env.MAX238_TEST_MYSQL_PORT);
const PASSWORD = process.env.MAX238_TEST_MYSQL_PASSWORD ?? '';
const TARGET_PASSWORD = process.env.MAX238_TARGET_PASSWORD ?? '';
const NONCE = process.env.MAX238_RUN_NONCE ?? generateRunNonce();
const TARGET_USER = `max238_ro_${createHash('sha256').update(NONCE).digest('hex').slice(0, 16)}`;
const HANDLE_DIR = process.env.MAX238_HANDLE_DIR ?? join(process.cwd(), '.max238-handles');

const actor = {
  userId: 0,
  username: 'max238-collect-now',
  roles: ['admin'],
  permissions: ['*'],
  sessionVersion: 1,
  instanceScopes: {} as Record<number, 'admin'>,
  requestId: 'max238-collect-now',
} as unknown as ActorContext;

describe.skipIf(!enabled)('immediate collection on a real platform, queue and read-only target', () => {
  let pool: Pool;
  let app: ReturnType<typeof Fastify>;
  let platform: OwnedDatabase;
  const targets: OwnedDatabase[] = [];
  const targetConnections: number[] = [];
  let instanceId = 0;
  let unboundId = 0;
  let insertInstance: (name:string)=>Promise<number>;
  let templateId = '';
  let templateVersion = 0;
  let contentHash = '';
  let worker: WorkerRuntime;
  let jobs: JobRegistry;
  let scheduleStore: MysqlScheduleStore;
  let controlledValue: number|null = 95;
  let controlledCapacity: number|null = 50;
  const sourceTimes = new Map<string, string>();
  let clock = Date.now();
  let accessCheckHook: (() => Promise<void>) | undefined;
  const registry = createConfigurationRegistry();
  const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const response = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body }) });
    return { status: response.statusCode, data: response.json() as Record<string, unknown> };
  };
  const body = () => ({
    expected_revision: 0,
    template_pins: [{ template_id: templateId, version: templateVersion, content_hash: contentHash }],
    overrides: {
      enabled: 'enable',
      interval_ms: { mode: 'set', value: 30000 },
      max_rows: { mode: 'set', value: 50 },
    },
  });
  const observations = async (id: string) =>
    (
      await pool.query<RowDataPacket[]>(
        "SELECT payload FROM metric_observations WHERE stage = 'normalized' AND id = ?",
        [id],
      )
    )[0].map(
      (row) =>
        (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>,
    );
  const counts = async () => ({
    jobs: Number(
      (
        await pool.query<RowDataPacket[]>(
          "SELECT COUNT(*) c FROM workflow_jobs WHERE job_type = 'metrics.collect_now'",
        )
      )[0][0].c,
    ),
    requests: Number(
      (await pool.query<RowDataPacket[]>('SELECT COUNT(*) c FROM metric_collect_requests'))[0][0].c,
    ),
    observations: Number(
      (await pool.query<RowDataPacket[]>('SELECT COUNT(*) c FROM metric_observations'))[0][0].c,
    ),
    operations: Number(
      (await pool.query<RowDataPacket[]>('SELECT COUNT(*) c FROM metric_policy_operations'))[0][0].c,
    ),
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
    const root = await mysql.createConnection({
      host: '127.0.0.1',
      port: PORT,
      user: 'root',
      password: PASSWORD,
    });
    try {
      platform = await createOwnedDatabase(root, { nonce: NONCE, purpose: 'collect', handleDir: HANDLE_DIR });
      await root.query(`CREATE USER '${TARGET_USER}'@'%' IDENTIFIED BY ?`, [TARGET_PASSWORD]);
      await root.query(`GRANT PROCESS ON *.* TO '${TARGET_USER}'@'%'`);
    } catch (error) {
      await root.end();
      throw error;
    }
    await root.end();

    pool = mysql.createPool({
      host: '127.0.0.1',
      port: PORT,
      user: 'root',
      password: PASSWORD,
      database: platform.database,
      timezone: 'Z',
      connectionLimit: 12,
    });
    pool.on('connection', (connection) => connection.query("SET time_zone='+00:00'"));
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
    insertInstance = async (name: string): Promise<number> => {
      // Each available instance must occupy its own physical database address.
      const target = await createOwnedDatabase(pool, { nonce: NONCE, purpose: `collecttarget${targets.length}`, handleDir: HANDLE_DIR });
      targets.push(target);
      await pool.query(`CREATE TABLE \`${target.database}\`.probe (id INT PRIMARY KEY)`);
      await pool.query(`INSERT INTO \`${target.database}\`.probe VALUES (1)`);
      await pool.query(`GRANT SELECT ON \`${target.database}\`.* TO '${TARGET_USER}'@'%'`);
      await pool.execute(
        `INSERT INTO database_instances
        (name, environment, db_type, db_version, host, port, username, password_encrypted, database_name, status,
         lifecycle_state, max_connections, connection_timeout_ms, created_by, created_at, updated_at)
        VALUES (?, 'testing', 'mysql', '8.4', '127.0.0.1', ?, ?, ?, ?, 'active', 'available', 10, 5000, 1, ?, ?)`,
        [
          name,
          PORT,
          TARGET_USER,
          encryptData(TARGET_PASSWORD),
          target.database,
          now.replace('T', ' ').replace('Z', ''),
          now.replace('T', ' ').replace('Z', ''),
        ],
      );
      const id = Number(
        (await pool.query<RowDataPacket[]>('SELECT id FROM database_instances WHERE name = ?', [name]))[0][0]
          .id,
      );
      targetConnections.push(id);
      expect(await databaseService.addConnection(id, name, {
        host: '127.0.0.1', port: PORT, user: TARGET_USER, password: TARGET_PASSWORD, database: target.database, db_type: 'mysql',
      })).toBe(true);
      return id;
    };
    instanceId = await insertInstance('max238-collect-bound');
    unboundId = await insertInstance('max238-collect-unbound');
    await pool.execute(
      "INSERT IGNORE INTO instance_permissions (user_id, instance_id, access_level) VALUES (1, ?, 'admin')",
      [instanceId],
    );
    await pool.execute(
      "INSERT IGNORE INTO instance_permissions (user_id, instance_id, access_level) VALUES (1, ?, 'admin')",
      [unboundId],
    );
    (actor as unknown as { instanceScopes: Record<number, string> }).instanceScopes = {
      [instanceId]: 'admin',
      [unboundId]: 'admin',
    };

    // One real immutable template with the metric the accepted probe can read.
    const repository = new MySqlTemplateRepository(pool as never);
    const templates = new MetricTemplateService(repository, registry);
    const template = await templates.create(actor as never, { name: `MAX238 collect now ${process.pid}` });
    const release = registry
      .list()
      .map((entry) => entry.package)
      .find((pkg) => pkg.id === 'mysql-representative' && pkg.version === '1.0.0')!;
    const packagePin = { id: release.id, version: release.version, digest: release.digest };
    const selected = await templates.selectMetric(actor as never, template.template_id, {
      package: packagePin,
      metric: { id: 'mysql.processlist.count', semantic_version: '1.0.0' },
    });
    const draft = await repository.getDraft(template.template_id);
    const aggregate = structuredClone(draft!.aggregate) as Record<string, unknown>;
    aggregate.items = [{ item_id: selected.item.item_id, version: selected.item.version }];
    await repository.updateDraft(template.template_id, draft!.revision, {
      aggregate: aggregate as never,
      updated_by: 1,
      updated_at: now,
    });
    const afterDraft = await repository.getDraft(template.template_id);
    const published = await templates.publish(actor as never, template.template_id, {
      expected_draft_revision: afterDraft!.revision,
      expected_revision: template.revision,
    });
    const record = await repository.getTemplate(template.template_id);
    await repository.updateTemplate(template.template_id, record!.revision, {
      status: 'active',
      updated_at: new Date(Date.parse(now) + 1000).toISOString(),
    });
    const version = await repository.getVersion(template.template_id, published.version);
    templateId = template.template_id;
    templateVersion = published.version;
    contentHash = version!.content_hash;

    const service = new TemplateBindingService({
      pool: () => pool,
      registry,
      access: createAssetCollectorAccess(),
      reload: async () => actor,
      inventory: undefined,
    });
    const collectService = new CollectNowService({
      pool: () => pool,
      registry,
      reload: (current) => actorContextService.revalidateActor(current, current.requestId),
      reloadOn: (current, executor) =>
        actorContextService.revalidateActorOn(executor as never, current, current.requestId, true),
    });
    app = Fastify();
    const auth = async (request: unknown) => {
      (request as { user?: ActorContext }).user = actor;
    };
    await registerMetricTemplateRoutes(app, auth, service, collectService);
    await registerTemplateTriggerRoutes(app, auth, () => pool);
    await app.ready();
    const detail = await repository.getVersion(templateId, templateVersion);
    const publish = await call('POST', `/api/metrics/templates/${templateId}/triggers`, {
      expected_version: templateVersion,
      expected_content_hash: contentHash,
      item_id: detail!.items[0].item_id,
      parameters: {
        schema: { high: { type: 'number' }, low: { type: 'number' } },
        defaults: { high: 90, low: 70 },
      },
      problem: {
        node: 'compare',
        select: { aggregation: 'last' },
        operator: '>',
        threshold: { kind: 'parameter', name: 'high' },
      },
      recovery: {
        node: 'compare',
        select: { aggregation: 'last' },
        operator: '<',
        threshold: { kind: 'parameter', name: 'low' },
      },
      quality: { accepted_quality: ['good'], min_coverage: 1, allow_estimated: false },
      clock: { stale_after_ms: 120000, nodata: { enabled: false } },
    });
    expect(publish.status, JSON.stringify(publish.data)).toBe(200);
    templateVersion = Number(publish.data.version);
    contentHash = String(publish.data.content_hash);

    // The real binding path against the real read-only target.
    const probed = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/probe`, body());
    expect(probed.status, JSON.stringify(probed.data)).toBe(200);
    const trial = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/trial`, {
      ...body(),
      receipt_id: `collect-trial-${process.pid}`,
    });
    expect(trial.status, JSON.stringify(trial.data)).toBe(200);
    const applied = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/apply`, {
      ...body(),
      receipt_id: `collect-trial-${process.pid}`,
      caller_key: `collect-apply-${process.pid}`,
    });
    expect(applied.status, JSON.stringify(applied.data)).toBe(200);
    expect(applied.data).toMatchObject({ kind: 'committed', revision: 1 });

    // The existing queue, worker and formal writer; the same access object the trial used.
    const store = (scheduleStore = new MysqlScheduleStore(pool, registry, 'production'));
    const authorizer = createCollectNowAuthorizer({
      loadActor: (userId, sessionVersion) => actorContextService.loadActiveActor(userId, sessionVersion),
      loadActorOn: (executor, userId, sessionVersion) =>
        actorContextService.loadActiveActorOn(executor as never, userId, sessionVersion, undefined, true),
    });
    const access = createAssetCollectorAccess();
    const scheduler = new MetricScheduler(
      store,
      registry,
      {
        async resolve(ref) {
          const resolved = await access.resolve(ref);
          return {
            ...resolved,
            assertCurrent: async () => {
              await resolved.assertCurrent?.();
              await accessCheckHook?.();
            },
          };
        },
      },
      () => clock,
      async (implementation) => [
        { dimensions: {}, observed_at: sourceTimes.get(implementation), fields: {
          connections: controlledValue === null ? null : { encoding: 'uint64', value: String(controlledValue) },
          capacity: controlledCapacity === null ? null : { encoding: 'uint64', value: String(controlledCapacity) },
        } },
      ],
      undefined,
      authorizer,
    );
    jobs = new JobRegistry();
    scheduler.register(jobs);
    // Record real outbox jobs without making test deliveries.
    jobs.register('notification.deliver', async () => {});
    worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as never), `collect-now-${process.pid}`, 30);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    const errors: unknown[] = [];
    for (const id of targetConnections) await databaseService.removeConnection(id).catch(error => errors.push(error));
    await pool?.end().catch(error => errors.push(error));
    const root = await mysql.createConnection({
      host: '127.0.0.1',
      port: PORT,
      user: 'root',
      password: PASSWORD,
    });
    try {
      await root.query(`DROP USER IF EXISTS '${TARGET_USER}'@'%'`).catch((error) => errors.push(error));
      for (const target of targets) {
        await dropOwnedDatabase(root, { nonce: NONCE, purpose: target.purpose, handleDir: HANDLE_DIR }).catch(
          (error) => errors.push(error),
        );
      }
      await dropOwnedDatabase(root, { nonce: NONCE, purpose: 'collect', handleDir: HANDLE_DIR }).catch(
        (error) => errors.push(error),
      );
    } finally {
      await root.end();
    }
    if (errors.length) throw errors[0];
  });

  const sample = async (value: number, key: string, observedAt?: number) => {
    controlledValue = value;
    clock = observedAt ?? Math.max(Date.now() + 1000, clock + 1000);
    const admitted = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`, {
      caller_key: key,
      expected_revision: 1,
    });
    expect(admitted.status, JSON.stringify(admitted.data)).toBe(200);
    await drain();
    const result = await call('GET', `/api/metrics/template-bindings/instance/${instanceId}/collect/${key}`);
    expect(result.data.state, JSON.stringify(result.data)).toBe('completed');
    return result.data;
  };
  it('normal formal writer promotes applied and produces one existing event through 95/85/60', async () => {
    await pool.execute(
      "INSERT INTO notification_channels(name,type,config,enabled,delivery_start_at) VALUES('MAX239 rollback only','webhook',?,1,NOW())",
      [JSON.stringify({ webhook_url: 'http://127.0.0.1:1/never-deliver', severity: 'warning' })],
    );
    const original = alertEventService.persistTemplateTransition.bind(alertEventService);
    vi.spyOn(alertEventService, 'persistTemplateTransition').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw Error('controlled transaction interruption');
    });
    controlledValue = 95;
    clock = Date.now() + 1000;
    const interrupted = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`, {
      caller_key: 'flow-interrupted',
      expected_revision: 1,
    });
    expect(interrupted.status).toBe(200);
    await drain();
    for (const table of [
      'metric_observations',
      'metric_trigger_episodes',
      'metric_trigger_heads',
      'alert_events',
      'alerts',
    ]) {
      expect(
        Number((await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n),
        table,
      ).toBe(0);
    }
    expect(
      Number(
        (
          await pool.query<RowDataPacket[]>(
            "SELECT COUNT(*) n FROM workflow_jobs WHERE job_type='notification.deliver'",
          )
        )[0][0].n,
      ),
    ).toBe(0);
    await pool.execute('UPDATE notification_channels SET enabled=0');
    const first = await sample(95, 'flow-95');
    const [bindings] = await pool.query<RowDataPacket[]>(
      'SELECT payload FROM metric_policy_bindings WHERE resource_key=?',
      [`instance:${instanceId}`],
    );
    const decoded = decodeBindingPayload(bindings[0].payload);
    expect(decoded.kind).toBe('template_pending');
    if (decoded.kind !== 'template_pending') throw Error('binding');
    expect(decoded.application).toMatchObject({ status: 'applied', applied_revision: 1 });
    const [events] = await pool.query<RowDataPacket[]>(
      'SELECT event_id,alert_id,payload,snapshot FROM metric_trigger_episodes',
    );
    expect(events).toHaveLength(1);
    const id = Number(events[0].event_id);
    expect((await alertEventService.deleteEvent(id)).success).toBe(false);
    expect((await alertDatabaseService.deleteAlert(Number(events[0].alert_id))).success).toBe(false);
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM alert_event_members WHERE event_id=?',[id]))[0]).toHaveLength(1);
    expect((await alertDatabaseService.resolveAlert(Number(events[0].alert_id), 1)).success).toBe(false);
    expect((await alertEventService.resolveEvent(id, 'manual must not recover', 1)).success).toBe(false);
    expect((await alertEventService.updateEvent(id, { source_type: 'manual' })).success).toBe(false);
    const read = () => call('GET', `/api/metrics/template-events/${id}`);
    let event = await read();
    expect(event.status, JSON.stringify(event.data)).toBe(200);
    expect(event.data.episode).toMatchObject({ state: 'open', opened: { value: 95 }, recovery_count: 0 });
    expect(metricPublicSchemas.TemplateEventEvidence.safeParse(event.data).success).toBe(true);
    expect(event.data.can_manual_close).toBe(false);
    expect(await call('POST', `/api/metrics/template-events/${id}/close`, {})).toMatchObject({
      status: 403, data: { error: 'TRIGGER_MANUAL_CLOSE_DISABLED' },
    });
    expect((event.data.snapshot as any).opening.sample_ids).toEqual(
      (first.samples as any[]).map((s) => s.id),
    );
    const [savedUser] = await pool.query<RowDataPacket[]>('SELECT username FROM users WHERE id=1');
    const [savedRoles] = await pool.query<RowDataPacket[]>('SELECT role_id FROM user_roles WHERE user_id=1');
    await pool.execute("UPDATE users SET username='max239_restricted' WHERE id=1");
    await pool.execute('DELETE FROM user_roles WHERE user_id=1');
    try {
      expect((await read()).status).toBe(403);
    } finally {
      await pool.execute('UPDATE users SET username=? WHERE id=1', [savedUser[0].username]);
      for (const role of savedRoles)
        await pool.execute('INSERT INTO user_roles(user_id,role_id) VALUES(1,?)', [role.role_id]);
    }
    const locker = await pool.getConnection();
    await locker.beginTransaction();
    await locker.execute('SELECT episode_id FROM metric_trigger_episodes WHERE event_id=? FOR UPDATE', [id]);
    const waiting = read();
    let waitSeen = false;
    for (let i = 0; i < 100; i++) {
      const [waits] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) n FROM performance_schema.data_lock_waits w
        JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
        WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='metric_trigger_episodes'`,
        [platform.database],
      );
      if (Number(waits[0].n) > 0) {
        waitSeen = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(waitSeen).toBe(true);
    await pool.execute('UPDATE users SET session_version=2 WHERE id=1');
    await locker.commit();
    locker.release();
    expect((await waiting).status).toBe(401);
    await pool.execute('UPDATE users SET session_version=1 WHERE id=1');
    await sample(85, 'flow-85');
    event = await read();
    expect(event.data.episode).toMatchObject({ state: 'open', opened: { value: 95 }, last: { value: 85 } });
    const watermark = clock;
    await sample(60, 'flow-late-60', clock - 1000);
    clock = watermark;
    event = await read();
    expect(event.data.episode).toMatchObject({ state: 'open', last: { value: 85 } });
    const ack = await call('POST', `/api/metrics/template-events/${id}/acknowledge`, {});
    expect(ack.status, JSON.stringify(ack.data)).toBe(200);
    expect(ack.data.episode).toMatchObject({ state: 'open' });
    await call('POST', `/api/metrics/template-events/${id}/acknowledge`, {});
    expect(
      Number(
        (
          await pool.query<RowDataPacket[]>(
            "SELECT COUNT(*) n FROM alert_event_logs WHERE JSON_UNQUOTE(JSON_EXTRACT(details,'$.action'))='trigger_acknowledged'",
          )
        )[0][0].n,
      ),
    ).toBe(1);
    await sample(70, 'flow-70');
    event = await read();
    expect(event.data.episode).toMatchObject({ state: 'open', last: { value: 70 } });
    clock += 120001;
    await evaluateTemplateClock(pool, clock);
    event = await read();
    expect(event.data.episode).toMatchObject({ state: 'open', last: { quality: 'unknown' } });
    await sample(60, 'flow-60');
    event = await read();
    expect(event.data.episode).toMatchObject({
      state: 'closed',
      recovery_count: 1,
      opened: { value: 95 },
      last: { value: 60 },
    });
    await drain();
    const replay = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/collect`, {
      caller_key: 'flow-60',
      expected_revision: 1,
    });
    expect(replay.data.state).toBe('completed');
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_trigger_episodes'))[0]).toHaveLength(1);
    expect(
      (await pool.query<RowDataPacket[]>("SELECT * FROM alert_event_logs WHERE action='resolved'"))[0],
    ).toHaveLength(1);
    const duplicateConnection = await pool.getConnection();
    try {
      await duplicateConnection.beginTransaction();
      // Reconsume the original committed 95 after recovery: no new occurrence.
      await evaluateTemplateSamples(
        duplicateConnection,
        decoded,
        (await observations(first.samples[0].id)) as any,
        clock + 1000,
      );
      await duplicateConnection.commit();
    } finally {
      duplicateConnection.release();
    }
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_trigger_episodes'))[0]).toHaveLength(1);
    await sample(90, 'flow-90');
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_trigger_episodes'))[0]).toHaveLength(1);
  }, 120000);
  it('drives explicit clock nodata and covered/gapped windows through a second normal applied binding', async () => {
    const repository = new MySqlTemplateRepository(pool as never);
    const current = await repository.getVersion(templateId, templateVersion);
    const rules = await call(
      'GET',
      `/api/metrics/templates/${templateId}/versions/${templateVersion}/triggers`,
    );
    const r = (rules.data.rules as any[])[0];
    const published = await call('POST', `/api/metrics/templates/${templateId}/triggers`, {
      expected_version: templateVersion,
      expected_content_hash: contentHash,
      item_id: current!.items[0].item_id,
      parameters: r.parameters,
      problem: {
        node: 'compare',
        select: { aggregation: 'avg', window_ms: 60000 },
        operator: '>=',
        threshold: { kind: 'constant', value: 80 },
      },
      recovery: {
        node: 'compare',
        select: { aggregation: 'avg', window_ms: 60000 },
        operator: '<',
        threshold: { kind: 'constant', value: 70 },
      },
      quality: r.quality,
      clock: { stale_after_ms: 120000, nodata: { enabled: true, after_ms: 180000 } },
    });
    expect(published.status, JSON.stringify(published.data)).toBe(200);
    templateVersion = Number(published.data.version);
    contentHash = String(published.data.content_hash);
    for (const action of ['probe', 'trial', 'apply']) {
      const result = await call('POST', `/api/metrics/template-bindings/instance/${unboundId}/${action}`, {
        ...body(),
        ...(action === 'probe' ? {} : { receipt_id: 'window-trial' }),
        ...(action === 'apply' ? { caller_key: 'window-apply' } : {}),
      });
      expect(result.status, JSON.stringify(result.data)).toBe(200);
    }
    const tick = async (value: number|null, at: number, key: string, expected = 'completed') => {
      controlledValue = value;
      clock = at;
      expect(
        (
          await call('POST', `/api/metrics/template-bindings/instance/${unboundId}/collect`, {
            caller_key: key,
            expected_revision: 1,
          })
        ).status,
      ).toBe(200);
      await drain();
      const result = await call('GET', `/api/metrics/template-bindings/instance/${unboundId}/collect/${key}`);
      expect(result.data.state, JSON.stringify(result.data)).toBe(expected);
    };
    const start = Date.now() + 1000;
    await tick(60, start, 'window-first');
    const rows = async () =>
      (
        await pool.query<RowDataPacket[]>(
          'SELECT payload FROM metric_trigger_episodes WHERE resource_key=?',
          [`instance:${unboundId}`],
        )
      )[0].map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
    expect(await rows()).toHaveLength(0);
    await evaluateTemplateClock(pool, start + 180001);
    let episodes = await rows();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ state: 'open', opened: { reason: 'nodata', value: null } });
    const t = start + 181000;
    await tick(95, t, 'window-a');
    await tick(95, t + 30000, 'window-b');
    await tick(95, t + 60000, 'window-c');
    episodes = await rows();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ state: 'open', last: { value: 95, quality: 'good' } });
    await tick(60,t+90000,'window-low-a');
    await tick(null,t+105000,'window-null');
    await tick(60,t+120000,'window-low-b');
    await tick(60,t+150000,'window-low-c');
    expect((await rows())[0]).toMatchObject({state:'open',last:{quality:'unknown'},recovery_count:0});
    await tick(60, t + 210000, 'window-gap');
    episodes = await rows();
    expect(episodes[0]).toMatchObject({ state: 'open', last: { quality: 'unknown' }, recovery_count: 0 });
    // Controlled malformed producer output enters the real normal writer. The
    // storage/quality fences must reject it atomically rather than recover.
    const normalWrite=(scheduleStore as any).writeTemplateResults.bind(scheduleStore);
    for(const boundary of ['unit','quality']) {
      vi.spyOn(scheduleStore as any,'writeTemplateResults').mockImplementationOnce(async(...args:any[])=>{
        for(const release of args[2])for(const item of release.result.observations) {
          if(boundary==='unit')item.observation.unit='%';
          else item.observation.quality={status:'invalid',reason:'source_error'};
        }
        return normalWrite(...args);
      });
      await tick(60,t+(boundary==='unit'?240000:270000),'window-invalid-'+boundary,'failed');
      expect((await rows())[0]).toMatchObject({state:'open',recovery_count:0});
    }
  }, 120000);
  it.each(['last','short','recovery-window'])('preserves the %s trigger with an incomplete window',async(mode)=>{
    const mixedId=await insertInstance('max239-mixed-'+mode);
    await pool.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(1,?,'admin')",[mixedId]);
    const current=await new MySqlTemplateRepository(pool as never).getVersion(templateId,templateVersion);
    const r=(await call('GET',`/api/metrics/templates/${templateId}/versions/${templateVersion}/triggers`)).data.rules[0];
    const compare=(aggregation:string,window_ms?:number)=>({node:'compare',select:{aggregation,...(window_ms?{window_ms}:{})},operator:'>',threshold:{kind:'constant',value:90}});
    const independentWindow = mode === 'recovery-window';
    const publication=await call('POST',`/api/metrics/templates/${templateId}/triggers`,{
      expected_version:templateVersion,expected_content_hash:contentHash,item_id:current!.items[0].item_id,
      parameters:r.parameters,
      problem: independentWindow
        ? {...compare('last'),threshold:{kind:'constant',value:100}}
        : {node:'any',children:[...(mode==='last'?[compare('last')]:[]),compare('avg',30000),compare('avg',60000)]},
      recovery: independentWindow
        ? {...compare('avg',60000),operator:'<',threshold:{kind:'constant',value:10}}
        : {node:'compare',select:{aggregation:'last'},operator:'<',threshold:{kind:'constant',value:70}},
      ...(independentWindow ? { recovery_mode: 'recovery_expression' } : {}),
      quality:r.quality,clock:{stale_after_ms:120000,nodata:{enabled:false}},
    });
    expect(publication.status,JSON.stringify(publication.data)).toBe(200);
    templateVersion=Number(publication.data.version);contentHash=String(publication.data.content_hash);
    for(const action of ['probe','trial','apply']){
      const response=await call('POST',`/api/metrics/template-bindings/instance/${mixedId}/${action}`,{
        ...body(),expected_revision:0,...(action==='probe'?{}:{receipt_id:'mixed-trial-'+mode}),...(action==='apply'?{caller_key:'mixed-apply-'+mode}:{})});
      expect(response.status,JSON.stringify(response.data)).toBe(200);
    }
    const start=Date.now()+1000;
    const tick=async(value:number|null,offset:number)=>{
      controlledValue=value;clock=start+offset;
      const key=`mixed-${mode}-${offset}`;
      expect((await call('POST',`/api/metrics/template-bindings/instance/${mixedId}/collect`,{caller_key:key,expected_revision:1})).status).toBe(200);
      await drain();
      expect((await call('GET',`/api/metrics/template-bindings/instance/${mixedId}/collect/${key}`)).data.state).toBe('completed');
    };
    const events=async()=> (await pool.query<RowDataPacket[]>('SELECT event_id,payload FROM metric_trigger_episodes WHERE resource_key=? AND config_revision=1',[`instance:${mixedId}`]))[0];
    const parse=(v:any)=>typeof v==='string'?JSON.parse(v):v;
    if (independentWindow) {
      await tick(101,0);
      const [opening] = await events();
      expect(parse(opening?.payload)).toMatchObject({state:'open',opened:{value:101},recovery_count:0});
      await tick(101,30000);
      expect(parse((await events())[0].payload)).toMatchObject({state:'open',last:{quality:'good',reason:'problem_retained'}});
      await tick(51,90000);
      expect(parse((await events())[0].payload)).toMatchObject({state:'open',last:{quality:'unknown',reason:'gap'},recovery_count:0});
      await tick(3,120000);
      await tick(3,150000);
      await tick(3,180000);
      const closing = await events();
      expect(closing).toHaveLength(1);
      expect(closing[0].event_id).toBe(opening.event_id);
      const history = await call('GET',`/api/metrics/template-events/${opening.event_id}`);
      expect(history.status).toBe(200);
      expect(history.data.episode).toMatchObject({state:'closed',opened:{value:101},last:{value:3},recovery_count:1});
      expect(history.data.snapshot).toMatchObject({ configuration: { rules: [{ recovery_mode: 'recovery_expression' }] } });
      return;
    }
    await tick(60,0);
    if(mode==='last'){await tick(60,30000);await tick(null,45000);}
    else {await tick(null,15000);await tick(95,30000);}
    await tick(95,60000);
    let rows=await events();expect(rows).toHaveLength(1);
    expect(parse(rows[0].payload)).toMatchObject({state:'open',opened:{value:95},recovery_count:0});
    await tick(85,90000);expect(parse((await events())[0].payload)).toMatchObject({state:'open'});
    await tick(60,120000);rows=await events();expect(rows).toHaveLength(1);
    expect(parse(rows[0].payload)).toMatchObject({state:'closed',recovery_count:1});
    const history=await call('GET',`/api/metrics/template-events/${rows[0].event_id}`);
    expect(history.status).toBe(200);expect((history.data.episode as any).opened.value).toBe(95);
  },120000);

  it.each([
    { mode: 'problem_expression', manual: false },
    { mode: 'none', manual: false },
    { mode: 'none', manual: true },
  ])('applies $mode recovery to the formal event and log with manual close $manual', async ({ mode, manual }) => {
    const fixture = `${mode}-${manual}`;
    const resource = await insertInstance(`max239-recovery-${fixture}`);
    await pool.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(1,?,'admin')", [resource]);
    const current = (await new MySqlTemplateRepository(pool as never).getVersion(templateId, templateVersion))!;
    const itemId = current.items[0].item_id;
    const publication = await call('POST', `/api/metrics/templates/${templateId}/triggers`, {
      expected_version: templateVersion, expected_content_hash: contentHash, item_id: itemId,
      parameters: { schema: {}, defaults: {} }, recovery_mode: mode,
      ...(manual ? { allow_manual_close: true } : {}),
      problem: { node: 'compare', select: { aggregation: 'last' }, operator: '>', threshold: { kind: 'constant', value: 90 } },
      quality: { accepted_quality: ['good'], min_coverage: 1, allow_estimated: false },
      clock: { stale_after_ms: 120000, nodata: manual ? { enabled: true, after_ms: 180000 } : { enabled: false } },
    });
    expect(publication.status, JSON.stringify(publication.data)).toBe(200);
    templateVersion = Number(publication.data.version);
    contentHash = String(publication.data.content_hash);
    const stored = await call('GET', `/api/metrics/templates/${templateId}/versions/${templateVersion}/triggers`);
    expect(stored.data.rules).toMatchObject([{ recovery_mode: mode }]);
    expect((stored.data.rules as Array<object>)[0]).not.toHaveProperty('recovery');

    const binding = `/api/metrics/template-bindings/instance/${resource}`;
    for (const action of ['probe', 'trial', 'apply']) {
      const response = await call('POST', `${binding}/${action}`, {
        ...body(), ...(action === 'probe' ? {} : { receipt_id: `recovery-trial-${fixture}` }),
        ...(action === 'apply' ? { caller_key: `recovery-apply-${fixture}` } : {}),
      });
      expect(response.status, JSON.stringify(response.data)).toBe(200);
    }
    const start = Math.max(Date.now() + 1000, clock + 1000);
    const collect = async (value: number | null, offset: number) => {
      clock = start + offset;
      controlledValue = value;
      const caller_key = `recovery-${fixture}-${offset}`;
      expect((await call('POST', `${binding}/collect`, { caller_key, expected_revision: 1 })).status).toBe(200);
      await drain();
      expect((await call('GET', `${binding}/collect/${caller_key}`)).data.state).toBe('completed');
    };
    const events = async () => (await pool.query<RowDataPacket[]>(
      'SELECT event_id FROM metric_trigger_episodes WHERE resource_key=?', [`instance:${resource}`],
    ))[0];
    const channelName = `Recovery fixture ${fixture}`;
    await pool.execute(
      "INSERT INTO notification_channels(name,type,config,enabled,delivery_start_at) VALUES(?,'webhook',?,1,NOW())",
      [channelName, JSON.stringify({ webhook_url: 'http://127.0.0.1:1/never-deliver', severity: 'warning' })],
    );
    await collect(95, 0);
    const [opened] = await events();
    const detail = async () => {
      const response = await call('GET', `/api/metrics/template-events/${opened.event_id}`);
      expect(response.status).toBe(200);
      return metricPublicSchemas.TemplateEventEvidence.parse(response.data);
    };
    const opening = await detail();
    expect(opening.can_manual_close).toBe(manual);
    expect(opening.snapshot.configuration.rules[0].allow_manual_close).toBe(manual || undefined);
    expect(opening.episode).toMatchObject({ state: 'open', opened: { value: 95 }, recovery_count: 0 });
    expect(opening.snapshot!.configuration.rules[0]).toMatchObject({ recovery_mode: mode });
    expect(opening.snapshot!.configuration.rules[0]).not.toHaveProperty('recovery');
    await collect(null, 30000);
    expect((await detail()).episode).toMatchObject({ state: 'open', last: { quality: 'unknown' }, recovery_count: 0 });

    const closes = mode === 'problem_expression';
    const expected = { state: closes ? 'closed' : 'open', recovery_count: closes ? 1 : 0 };
    await collect(85, 60000);
    expect((await detail()).episode).toMatchObject(expected);
    await collect(60, 90000);
    expect((await detail()).episode).toMatchObject(expected);
    expect(await events()).toEqual([opened]);
    const eventPath = `/api/metrics/template-events/${opened.event_id}`;
    const lateChannelName = `${channelName} late`;
    if (manual) {
      const [savedUser] = await pool.query<RowDataPacket[]>('SELECT username FROM users WHERE id=1');
      const [savedRoles] = await pool.query<RowDataPacket[]>('SELECT role_id FROM user_roles WHERE user_id=1');
      const [roleResult] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO roles(name) VALUES('trigger-close-restricted')");
      const roleId = roleResult.insertId;
      await pool.execute("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code IN ('alert:view','instance:manage')", [roleId]);
      await pool.execute("UPDATE users SET username='trigger_close_restricted' WHERE id=1");
      await pool.execute('DELETE FROM user_roles WHERE user_id=1');
      await pool.execute('INSERT INTO user_roles(user_id,role_id) VALUES(1,?)', [roleId]);
      try {
        expect((await detail()).can_manual_close).toBe(false);
        expect((await call('POST', `${eventPath}/close`, {})).status).toBe(403);
        await pool.execute("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code='alert:manage'", [roleId]);
        await pool.execute("UPDATE instance_permissions SET access_level='read-only' WHERE user_id=1 AND instance_id=?", [resource]);
        expect((await detail()).can_manual_close).toBe(false);
        expect((await call('POST', `${eventPath}/close`, {})).status).toBe(403);
      } finally {
        await pool.execute('UPDATE users SET username=? WHERE id=1', [savedUser[0].username]);
        await pool.execute("UPDATE instance_permissions SET access_level='admin' WHERE user_id=1 AND instance_id=?", [resource]);
        await pool.execute('DELETE FROM user_roles WHERE user_id=1');
        for (const role of savedRoles) await pool.execute('INSERT INTO user_roles(user_id,role_id) VALUES(1,?)', [role.role_id]);
      }
      await collect(null, 100000);
      const open = await detail();
      expect(open.episode.state).toBe('open');
      expect(open.episode.last.quality).toBe('unknown');
      expect((await call('POST', `${eventPath}/close`, { actor_id: 999 })).status).toBe(400);
      const locker = await pool.getConnection();
      await locker.beginTransaction();
      await locker.execute('SELECT identity_hash FROM metric_trigger_heads WHERE identity_hash=? FOR UPDATE',
        [open.episode.identity_hash]);
      const waiting = call('POST', `${eventPath}/close`, {});
      let blocked = false;
      let revoked = false;
      try {
        for (let i = 0; i < 100 && !blocked; i++) {
          const [waits] = await pool.query<RowDataPacket[]>(
            `SELECT COUNT(*) n FROM performance_schema.data_lock_waits w
             JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
             WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='metric_trigger_heads'`, [platform.database],
          );
          blocked = Number(waits[0].n) > 0;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await pool.execute('UPDATE users SET session_version=2 WHERE id=1');
        revoked = true;
      } finally {
        await locker.rollback();
        locker.release();
        try {
          if (revoked) expect((await waiting).status).toBe(401);
        } finally {
          if (revoked) await pool.execute('UPDATE users SET session_version=1 WHERE id=1');
        }
      }
      expect((await detail()).episode.state).toBe('open');
      await pool.execute(
        "INSERT INTO notification_channels(name,type,config,enabled,delivery_start_at) VALUES(?,'webhook',?,1,NOW())",
        [lateChannelName, JSON.stringify({ webhook_url: 'http://127.0.0.1:1/never-deliver', severity: 'warning' })],
      );
      const results = await Promise.all([call('POST', `${eventPath}/close`, {}), call('POST', `${eventPath}/close`, {})]);
      for (const result of results) {
        expect(result.status, JSON.stringify(result.data)).toBe(200);
        expect(result.data).toMatchObject({ can_manual_close: false, processing: { status: 'closed', acknowledged_at: null },
          episode: { state: 'closed', recovery_count: 0, manual_close: { actor_id: 1 }, last: open.episode.last } });
        expect(result.data.snapshot).toEqual(open.snapshot);
      }
      expect(results[0].data.episode).toEqual(results[1].data.episode);
      const closed = metricPublicSchemas.TemplateEventEvidence.parse(results[0].data).episode;
      expect(closed.unknown_segments.at(-1)?.to).toBe(closed.closed_at);
      const [audit] = await pool.query<RowDataPacket[]>(
        "SELECT actor_id, details->>'$.to' AS status FROM alert_event_logs WHERE event_id=? AND details->>'$.action'='trigger_manually_closed'",
        [opened.event_id],
      );
      expect(audit).toEqual([{ actor_id: 1, status: 'closed' }]);
      const auditSql = readFileSync(new URL('../../../sql/audits/max118-alert-events-dry-run.sql', import.meta.url), 'utf8');
      const [findings] = await pool.query<RowDataPacket[]>(auditSql);
      expect(findings.filter(finding => Number(finding.event_id) === Number(opened.event_id))).toEqual([]);
      const alerts = await alertDatabaseService.getAlerts({ instance_id: resource, status: 'closed', strict: true });
      expect(alerts.items).toMatchObject([{ id: opening.alert_id, status: 'closed', acknowledged: false }]);
      await collect(95, 120000);
      const occurrences = await events();
      expect(occurrences).toHaveLength(2);
      const second = occurrences.find(row => row.event_id !== opened.event_id)!;
      expect((await call('POST', `/api/metrics/template-events/${second.event_id}/close`, {})).status).toBe(200);
      await evaluateTemplateClock(pool, clock + 1000);
      expect(await events()).toHaveLength(2);
      expect((await detail()).episode).toEqual(results[0].data.episode);
      await evaluateTemplateClock(pool, clock + 180000);
      const withNodata = await events();
      expect(withNodata).toHaveLength(3);
      const latest = withNodata.find(row => !occurrences.some(known => known.event_id === row.event_id))!;
      const nodataPath = `/api/metrics/template-events/${latest.event_id}`;
      expect((await call('GET', nodataPath)).data.episode).toMatchObject({ state: 'open', opened: { reason: 'nodata' } });
      expect((await call('POST', `${nodataPath}/close`, {})).status).toBe(200);
      await evaluateTemplateClock(pool, clock + 181000);
      expect(await events()).toHaveLength(3);
    } else {
      expect((await call('POST', `${eventPath}/close`, {})).status).toBe(403);
    }
    await pool.execute('UPDATE notification_channels SET enabled=0 WHERE name IN (?,?)', [channelName, lateChannelName]);
    const [eventRows] = await pool.query<RowDataPacket[]>('SELECT status FROM alert_events WHERE id=?', [opened.event_id]);
    expect(eventRows[0].status).toBe(manual ? 'closed' : closes ? 'resolved' : 'open');
    const [logs] = await pool.query<RowDataPacket[]>(
      "SELECT action FROM alert_event_logs WHERE event_id=? AND action='resolved'", [opened.event_id],
    );
    expect(logs).toHaveLength(closes ? 1 : 0);
    const [jobs] = await pool.query<RowDataPacket[]>(
      `SELECT COALESCE(payload->>'$.transition.phase', 'problem') AS phase, payload->>'$.transition.cause' AS cause
       FROM workflow_jobs WHERE job_type='notification.deliver' AND payload->>'$.alertId'=?`,
      [String(opening.alert_id)],
    );
    expect(jobs.map(job => job.phase).sort()).toEqual(closes || manual ? ['problem', 'recovery'] : ['problem']);
    expect(jobs.find(job => job.phase === 'recovery')?.cause).toBe(manual ? 'manual' : closes ? null : undefined);
  }, 120000);

  it('uses both formal items in one event and recovers only when both are known low', async () => {
    const resource = await insertInstance('max239-cross-item');
    await pool.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(1,?,'admin')", [resource]);
    const repository = new MySqlTemplateRepository(pool as never);
    const templates = new MetricTemplateService(repository, registry);
    const template = await templates.create(actor, { name: 'Combination trigger fixture' });
    const release = registry.list().map(r => r.package).find(pkg => pkg.id === 'mysql-representative' && pkg.version === '1.0.0')!;
    const packagePin = { id: release.id, version: release.version, digest: release.digest };
    const metricIds = ['mysql.processlist.count', 'mysql.connections.limit'];
    const items = await Promise.all(metricIds.map(id => templates.selectMetric(actor, template.template_id,
      { package: packagePin, metric: { id, semantic_version: '1.0.0' } })));
    const draft = (await repository.getDraft(template.template_id))!;
    await repository.updateDraft(template.template_id, draft.revision, {
      aggregate: { ...draft.aggregate, items: items.map(({ item }, index) => ({
        item_id: item.item_id, version: item.version, interval_ms: index === 0 ? 60000 : 30000,
      }))
        .sort((a, b) => a.item_id.localeCompare(b.item_id)) },
      updated_by: 1, updated_at: new Date().toISOString(),
    });
    const latest = (await repository.getDraft(template.template_id))!;
    const version = await templates.publish(actor, template.template_id, { expected_draft_revision: latest.revision, expected_revision: template.revision });
    const record = (await repository.getTemplate(template.template_id))!;
    await repository.updateTemplate(template.template_id, record.revision, { status: 'active', updated_at: new Date().toISOString() });
    const detail = (await repository.getVersion(template.template_id, version.version))!;
    const [primary, secondary] = items.map(({ item }) => item.item_id);
    const leaf = (operator: '>' | '<', value: number, item_id?: string) => ({
      node: 'compare', select: { aggregation: 'last', ...(item_id ? { item_id } : {}) }, operator, threshold: { kind: 'constant', value },
    });
    const request = {
      expected_version: detail.version, expected_content_hash: detail.content_hash, item_id: primary,
      parameters: { schema: {}, defaults: {} },
      problem: { node: 'all', children: [leaf('>', 50), leaf('>', 49, secondary)] },
      recovery: { node: 'all', children: [{ ...leaf('<', 10), select: { aggregation: 'avg', window_ms: 30000 } }, leaf('<', 10, secondary)] },
      quality: { accepted_quality: ['good'], min_coverage: 1, allow_estimated: false },
      clock: { stale_after_ms: 120000, nodata: { enabled: false } },
    };
    const triggerRoute = `/api/metrics/templates/${template.template_id}/triggers`;
    const wrong = await call('POST', triggerRoute, { ...request, problem: leaf('>', 49, 'outside-template') });
    expect(wrong).toMatchObject({ status: 422, data: { error: 'TRIGGER_ITEM_UNKNOWN' } });
    const published = await call('POST', triggerRoute, request);
    expect(published.status, JSON.stringify(published.data)).toBe(200);
    const binding = { ...body(), template_pins: [{ template_id: template.template_id, version: published.data.version, content_hash: published.data.content_hash }] };
    for (const action of ['probe', 'trial', 'apply']) {
      const response = await call('POST', `/api/metrics/template-bindings/instance/${resource}/${action}`, {
        ...binding, ...(action === 'probe' ? {} : { receipt_id: 'combo-trial' }), ...(action === 'apply' ? { caller_key: 'combo-apply' } : {}),
      });
      expect(response.status, JSON.stringify(response.data)).toBe(200);
    }
    const implementations = metricIds.map(id => release.collectors.find(c => c.mappings.some(mapping => mapping.metric.id === id))!.implementation_ref);
    const start = Date.now() + 1000;
    const tick = async (offset: number, left: number, right: number|null, leftAt = offset, rightAt = offset, scheduled = false) => {
      clock = start + offset;
      controlledValue = left;
      controlledCapacity = right;
      sourceTimes.set(implementations[0], new Date(start + leftAt).toISOString());
      sourceTimes.set(implementations[1], new Date(start + rightAt).toISOString());
      if (scheduled) {
        const entry = (await scheduleStore.scan()).templates.find(item => item.resource_key === `instance:${resource}`)!;
        expect(await scheduleStore.enqueueTemplate(entry, clock)).toBe(true);
        await drain();
        return;
      }
      const caller_key = `combo-${offset}`;
      expect((await call('POST', `/api/metrics/template-bindings/instance/${resource}/collect`, { caller_key, expected_revision: 1 })).status).toBe(200);
      await drain();
      const result = await call('GET', `/api/metrics/template-bindings/instance/${resource}/collect/${caller_key}`);
      expect(result.data.state, JSON.stringify(result.data)).toBe('completed');
    };
    const events = async () => (await pool.query<RowDataPacket[]>(
      'SELECT event_id,payload FROM metric_trigger_episodes WHERE resource_key=?', [`instance:${resource}`]))[0];
    const parse = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
    try {
      // Start with staggered deadlines to exercise a real pending-to-applied handover across jobs.
      await pool.execute(
        `INSERT INTO metric_schedule(resource_key,revision,next_due_ms,states,cadence)
         VALUES(?,1,?,'{}',?) ON DUPLICATE KEY UPDATE next_due_ms=VALUES(next_due_ms),cadence=VALUES(cadence)`,
        [`instance:${resource}`, start, JSON.stringify({ next: { 60000: start, 30000: start + 40000 }, through: null })],
      );
      await tick(0, 51, null, 0, -1000, true);
      expect(await events()).toHaveLength(0);
      await tick(40000, 0, 50, 40000, -500, true);
      const [opened] = await events();
      expect(parse(opened?.payload)).toMatchObject({ state: 'open', opened: { value: 51 }, recovery_count: 0 });
      const openedDetail = await call('GET', `/api/metrics/template-events/${opened.event_id}`);
      expect(openedDetail.status).toBe(200);
      expect(metricPublicSchemas.TemplateEventEvidence.safeParse(openedDetail.data).success).toBe(true);
      expect((openedDetail.data.snapshot as any).opening.samples.map((sample: any) => sample.metric.id).sort()).toEqual([...metricIds].sort());
      await tick(70000, 1, null);
      expect(parse((await events())[0].payload)).toMatchObject({ state: 'open', last: { quality: 'unknown' }, recovery_count: 0 });
      await tick(100000, 1, 2, 70000);
      expect(parse((await events())[0].payload)).toMatchObject({ state: 'open', recovery_count: 0 });
      await tick(130000, 1, 2);
      await tick(160000, 1, 2);
      await tick(190000, 1, 2);
      const closed = await events();
      expect(closed).toHaveLength(1);
      expect(closed[0].event_id).toBe(opened.event_id);
      expect(parse(closed[0].payload)).toMatchObject({ state: 'closed', recovery_count: 1 });
      const [cache] = await pool.query<RowDataPacket[]>(
        `SELECT i.payload->>'$.metric.id' AS metric, COUNT(*) AS entries FROM metric_trigger_inputs i
         JOIN metric_trigger_heads h USING(identity_hash) WHERE h.resource_key=? GROUP BY metric`, [`instance:${resource}`]);
      expect(Number(cache.find(row => row.metric === metricIds[1])?.entries)).toBe(1);
      expect(Number(cache.find(row => row.metric === metricIds[0])?.entries)).toBeGreaterThan(1);
      await evaluateTemplateClock(pool, start + 350000);
      const watermarks = async () => parse((await pool.query<RowDataPacket[]>(
        'SELECT source_watermarks FROM metric_trigger_heads WHERE resource_key=?', [`instance:${resource}`]))[0][0].source_watermarks);
      const expectedWatermarks = Object.fromEntries(metricIds.map(id => [`${id}@1.0.0`, new Date(start + 190000).toISOString()]));
      expect(await watermarks()).toEqual(expectedWatermarks);
      await tick(360000, 51, 50, 130000, 130000);
      expect(await watermarks()).toEqual(expectedWatermarks);
      expect(await events()).toHaveLength(1);

      const previousDraft = (await repository.getDraft(template.template_id))!;
      const edited = await repository.updateDraft(template.template_id, previousDraft.revision, {
        aggregate: { ...previousDraft.aggregate, items: previousDraft.aggregate.items.filter(item => item.item_id !== secondary) },
        updated_by: 1, updated_at: new Date().toISOString(),
      });
      const previousVersion = (await repository.getTemplate(template.template_id))!;
      await expect(templates.publish(actor, template.template_id, { expected_draft_revision: edited.revision, expected_revision: previousVersion.revision }))
        .rejects.toMatchObject({ code: 'TEMPLATE_TRIGGER_ITEM_REFERENCED' });
    } finally {
      sourceTimes.clear();
    }
  }, 120000);
});
