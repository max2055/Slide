import {registerEventReadRoutes} from '../src/alert-event-access.js';
/** Isolated MAX239 acceptance fixture. Controlled scalar transport; real registered package, trial target, formal writer and event services. No production worker or external delivery. */
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createVerifyToken } from '../src/auth-middleware.js';
import jwt from 'jsonwebtoken';
import { registerMetricConfigurationRoutes } from '../src/metrics/config/routes.js';
import { registerMetricPolicyRoutes } from '../src/metrics/policy/routes.js';
import { registerNotificationHandlers } from '../src/workflows/notification-handlers.js';
import { notificationDatabaseService } from '../src/notification-database-service.js';
import { notificationService } from '../src/notification-service.js';
import { registerTemplateTriggerRoutes } from '../src/metrics/triggers/routes.js';
import { alertEventService } from '../src/alert-event-service.js';
import { evaluateTemplateClock } from '../src/metrics/triggers/runtime.js';
import type { ActorContext } from '../src/auth/actor-context.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import type { MigrationPool } from '../src/migrations/types.js';
import { dbConnection, encryptData } from '../src/db-connection.js';
import { databaseService } from '../src/database-service.js';
import { actorContextService } from '../src/auth/actor-context.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { createAssetCollectorAccess } from '../src/metrics/config/access.js';
import { MySqlTemplateRepository } from '../src/metrics/templates/mysql-repository.js';
import { MetricTemplateService } from '../src/metrics/templates/service.js';
import { TemplateBindingService } from '../src/metrics/templates/binding-service.js';
import { CollectNowService, createCollectNowAuthorizer } from '../src/metrics/templates/collect-now.js';
import { registerMetricTemplateRoutes } from '../src/metrics/templates/routes.js';
import { MysqlScheduleStore, COLLECT_NOW_JOB_TYPE } from '../src/metrics/scheduler/store.js';
import { MetricScheduler } from '../src/metrics/scheduler/service.js';
import { JobRegistry } from '../src/workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../src/workflows/worker-runtime.js';
import {
  createOwnedDatabase,
  dropOwnedDatabase,
  generateRunNonce,
  type OwnedDatabase,
} from '../src/testing/owned-fixture.js';

const PORT = Number(process.env.MAX238_TEST_MYSQL_PORT);
if (!PORT || PORT === 3306) throw Error('exclusive non3306 required');
const PASSWORD = process.env.MAX238_TEST_MYSQL_PASSWORD ?? '';
const TARGET_PASSWORD = process.env.MAX238_TARGET_PASSWORD!;
const NONCE = process.env.MAX239_RUN_NONCE!;
const HANDLE_DIR = process.env.MAX239_HANDLE_DIR!;
const META = process.env.MAX239_META!;
const TARGET_USER = `max238_ro_${createHash('sha256').update(NONCE).digest('hex').slice(0, 16)}`;
const registry = createConfigurationRegistry();
let pool: Pool,
  platform: OwnedDatabase,
  target: OwnedDatabase,
  instanceId = 0,
  unboundId = 0,
  templateId = '',
  templateVersion = 0,
  contentHash = '';
const actor = {
  userId: 1,
  username: 'max239-isolated',
  roles: ['admin'],
  permissions: ['*'],
  sessionVersion: 1,
  instanceScopes: {},
  requestId: 'max239-isolated',
} as ActorContext;
if (process.argv.includes('--cleanup-handles')) {
  const root = await mysql.createConnection({
    host: '127.0.0.1',
    port: PORT,
    user: 'root',
    password: PASSWORD,
  });
  try {
    const userHandle = join(HANDLE_DIR, `user-${NONCE}.json`);
    if (existsSync(userHandle)) {
      const u = JSON.parse(await readFile(userHandle, 'utf8'));
      assert.equal(u.nonce, NONCE);
      assert.equal(u.user, TARGET_USER);
      await root.query(`DROP USER '${TARGET_USER}'@'%'`);
      await unlink(userHandle);
    }
    for (const purpose of ['collecttarget', 'collect']) {
      if (existsSync(join(HANDLE_DIR, `max238-${purpose}-${NONCE}.json`)))
        await dropOwnedDatabase(root, { nonce: NONCE, purpose, handleDir: HANDLE_DIR });
    }
  } finally {
    await root.end();
  }
  process.exit(0);
}
const expect = (v: any) => ({ toBe: (w: any) => assert.equal(v, w) });
if (process.argv.includes('--bootstrap')) {
  const root = await mysql.createConnection({
    host: '127.0.0.1',
    port: PORT,
    user: 'root',
    password: PASSWORD,
  });
  try {
    platform = await createOwnedDatabase(root, { nonce: NONCE, purpose: 'collect', handleDir: HANDLE_DIR });
    target = await createOwnedDatabase(root, {
      nonce: NONCE,
      purpose: 'collecttarget',
      handleDir: HANDLE_DIR,
    });
    await root.query(`CREATE TABLE \`${target.database}\`.probe (id INT PRIMARY KEY)`);
    await root.query(`INSERT INTO \`${target.database}\`.probe VALUES (1)`);
    await root.query(`CREATE USER '${TARGET_USER}'@'%' IDENTIFIED BY ?`, [TARGET_PASSWORD]);
    await writeFile(
      join(HANDLE_DIR, `user-${NONCE}.json`),
      JSON.stringify({ nonce: NONCE, user: TARGET_USER }),
    );
    await root.query(`GRANT SELECT ON \`${target.database}\`.* TO '${TARGET_USER}'@'%'`);
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
    return Number(
      (await pool.query<RowDataPacket[]>('SELECT id FROM database_instances WHERE name = ?', [name]))[0][0]
        .id,
    );
  };
  instanceId = await insertInstance('max238-collect-bound');
  unboundId = await insertInstance('max238-collect-unbound');
  const targetConfig = {
    host: '127.0.0.1',
    port: PORT,
    user: TARGET_USER,
    password: TARGET_PASSWORD,
    database: target.database,
    db_type: 'mysql' as const,
  };
  expect(await databaseService.addConnection(instanceId, 'max238-collect-bound', targetConfig)).toBe(true);
  expect(await databaseService.addConnection(unboundId, 'max238-collect-unbound', targetConfig)).toBe(true);
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

  await pool.execute(
    "INSERT INTO notification_channels(name,type,config,enabled,delivery_start_at) VALUES('MAX239 controlled local receipt','webhook',?,1,NOW())",
    [JSON.stringify({ webhook_url: 'http://127.0.0.1:1/controlled-only', severity: 'warning' })],
  );
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

  await writeFile(
    META,
    JSON.stringify({
      platform,
      target,
      instanceId,
      unboundId,
      templateId,
      templateVersion,
      contentHash,
      nonce: NONCE,
    }),
  );
  await pool.end();
  process.exit(0);
}
const meta = JSON.parse(await readFile(META, 'utf8'));
assert.equal(meta.nonce, NONCE);
({ platform, target, instanceId, unboundId, templateId, templateVersion, contentHash } = meta);
if (process.argv.includes('--cleanup')) {
  const root = await mysql.createConnection({
    host: '127.0.0.1',
    port: PORT,
    user: 'root',
    password: PASSWORD,
  });
  try {
    await root.query(`DROP USER '${TARGET_USER}'@'%'`);
    await dropOwnedDatabase(root, { nonce: NONCE, purpose: 'collecttarget', handleDir: HANDLE_DIR });
    await dropOwnedDatabase(root, { nonce: NONCE, purpose: 'collect', handleDir: HANDLE_DIR });
  } finally {
    await root.end();
  }
  process.exit(0);
}
await dbConnection.initialize({
  host: '127.0.0.1',
  port: PORT,
  user: 'root',
  password: PASSWORD,
  database: platform.database,
});
pool = dbConnection.getPool()!;
const config = {
  host: '127.0.0.1',
  port: PORT,
  user: TARGET_USER,
  password: TARGET_PASSWORD,
  database: target.database,
  db_type: 'mysql' as const,
};
await databaseService.addConnection(instanceId, 'max239-controlled', config);
const reload = (a: ActorContext) => actorContextService.revalidateActor(a, a.requestId);
const reloadOn = (a: ActorContext, c: any) => actorContextService.revalidateActorOn(c, a, a.requestId, true);
const service = new TemplateBindingService({
  pool: () => pool,
  registry,
  access: createAssetCollectorAccess(),
  reload,
  reloadOn,
});
const collectService = new CollectNowService({ pool: () => pool, registry, reload, reloadOn });
const app = Fastify();
const auth = createVerifyToken(process.env.MAX239_JWT_SECRET!, actorContextService);
await registerMetricTemplateRoutes(app, auth, service, collectService);
await registerTemplateTriggerRoutes(app, auth, () => pool);
await registerMetricConfigurationRoutes(app, auth);
await registerMetricPolicyRoutes(app, auth);
let value: number | null = 95,
  clockOffset = 0;
const clock = () => Date.now() + clockOffset;
const store = new MysqlScheduleStore(pool, registry, 'production');
const scheduler = new MetricScheduler(
  store,
  registry,
  createAssetCollectorAccess(),
  clock,
  async () => [
    {
      dimensions: {},
      fields: { connections: value === null ? null : { encoding: 'uint64', value: String(value) } },
    },
  ],
  undefined,
  createCollectNowAuthorizer({
    loadActor: (id, v) => actorContextService.loadActiveActor(id, v),
    loadActorOn: (c, id, v) => actorContextService.loadActiveActorOn(c as never, id, v, undefined, true),
  }),
);
const jobs = new JobRegistry();
scheduler.register(jobs);
let receiptCount = 0;
app.post('/__test/receipt', async () => {
  receiptCount++;
  return { accepted: true };
});
// Test transport only: a fixed, owned loopback receiver. This is not an external production notification.
registerNotificationHandlers(
  jobs,
  notificationDatabaseService,
  {
    buildMessage: (...args) => notificationService.buildMessage(...args),
    send: async (_channel, message) => {
      const r = await fetch(`http://127.0.0.1:${process.env.MAX239_API_PORT}/__test/receipt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      return { success: r.ok };
    },
  },
  { getReportById: async () => null },
);
const worker = new WorkerRuntime(
  new MysqlWorkflowStore(() => pool as never),
  `max239-foreground-${process.pid}`,
  30,
);
app.get('/__health', async () => ({ ok: true, pid: process.pid }));
app.get('/__test/meta', async () => ({
  ...meta,
  pid: process.pid,
  token: jwt.sign({ userId: 1, sessionVersion: 1 }, process.env.MAX239_JWT_SECRET!, { expiresIn: '1h' }),
}));
app.post('/__test/value', async (req) => {
  const b = req.body as any;
  value = b.value;
  clockOffset = b.offset ?? 0;
  return { value, clock: clock() };
});
app.post('/__test/drain', async () => {
  await pool.execute(
    "UPDATE workflow_jobs SET available_at=NOW() WHERE job_type IN ('metrics.collect_now','notification.deliver') AND state IN ('queued','retry')",
  );
  for (let i = 0; i < 10; i++) {
    const state = await worker.runOnce((j, c) => jobs.execute(j, c), Date.now());
    if (state === 'idle') break;
  }
  return { ok: true };
});
app.post('/__test/clock', async (req) => {
  clockOffset = Number((req.body as any).offset);
  await evaluateTemplateClock(pool, clock());
  return { ok: true };
});
app.get('/__test/facts', async () => {
  const [episodes] = await pool.query<RowDataPacket[]>(
    'SELECT event_id,alert_id,payload,snapshot FROM metric_trigger_episodes',
  );
  const [recovered] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM alert_event_logs WHERE action='resolved'",
  );
  const [outbox] = await pool.query<RowDataPacket[]>(
    "SELECT id,state,idempotency_key FROM workflow_jobs WHERE job_type='notification.deliver'",
  );
  return { episodes, recovered, outbox, controlledHttpReceipts: receiptCount };
});
app.post('/__test/revoke', async (req) => {
  await pool.execute('UPDATE users SET session_version=? WHERE id=1', [(req.body as any).revoked ? 2 : 1]);
  return { ok: true };
});
await registerEventReadRoutes(app,auth);
await app.listen({ host: '127.0.0.1', port: Number(process.env.MAX239_API_PORT) });
process.on('SIGTERM', () => {
  void app
    .close()
    .then(() => dbConnection.close())
    .then(() => process.exit(0));
});
