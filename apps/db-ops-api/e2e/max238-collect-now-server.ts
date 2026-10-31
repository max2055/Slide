/**
 * MAX-238 / NATIVE-COLLECT-NOW browser evidence backend.
 *
 * A real Fastify server on a disposable schema inside the run's own MySQL
 * container (never 3306). It creates a real read-only target schema and user,
 * builds one native template and establishes its binding through the real
 * probe → preview → trial → apply routes, then runs the same WorkerRuntime and
 * JobRegistry the product uses. Nothing here fakes a sample: the test reads the
 * task row and the formal observation row back over HTTP.
 *
 * Test-only control surface:
 *   GET /__health                 readiness for Playwright's webServer
 *   GET /__test/handle            this run's exact container and owner nonce
 *   GET /__test/task?key=…        the task row, its samples and the formal rows
 */
import Fastify from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dbConnection, encryptData } from '../src/db-connection.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import type { MigrationPool } from '../src/migrations/types.js';
import type { ActorContext } from '../src/auth/actor-context.js';
import { actorContextService } from '../src/auth/actor-context.js';
import { databaseService } from '../src/database-service.js';
import { MetricConfigurationService } from '../src/metrics/config/service.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { createAssetCollectorAccess } from '../src/metrics/config/access.js';
import { createTrialStore, registerMetricConfigurationRoutes } from '../src/metrics/config/routes.js';
import { configurationReader } from '../src/metrics/config/status-store.js';
import { trialAccess } from '../src/metrics/config/access.js';
import { policyService } from '../src/metrics/policy/service.js';
import { registerMetricPolicyRoutes } from '../src/metrics/policy/routes.js';
import { MySqlTemplateRepository } from '../src/metrics/templates/mysql-repository.js';
import { MetricTemplateService } from '../src/metrics/templates/service.js';
import { TemplateBindingService } from '../src/metrics/templates/binding-service.js';
import { CollectNowService, createCollectNowAuthorizer } from '../src/metrics/templates/collect-now.js';
import { registerMetricTemplateRoutes } from '../src/metrics/templates/routes.js';
import { MysqlScheduleStore } from '../src/metrics/scheduler/store.js';
import { MetricScheduler } from '../src/metrics/scheduler/service.js';
import { JobRegistry } from '../src/workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../src/workflows/worker-runtime.js';
import { refKey } from '../src/metrics/policy/model.js';
import { createOwnedDatabase } from '../src/testing/owned-fixture.js';
import { join } from 'node:path';

const mysqlPort = Number(process.env.MAX238_TEST_MYSQL_PORT);
const apiPort = Number(process.env.MAX238_API_PORT ?? 51839);
if (!mysqlPort) { console.error('MAX238_TEST_MYSQL_PORT is required'); process.exit(2); }
const nonce = process.env.MAX238_E2E_NONCE ?? randomUUID().replaceAll('-', '').slice(0, 16);
const schemaNonce = createHash('sha256').update(nonce).digest('hex').slice(0, 24);
const targetUser = `max238cn_ro_${createHash('sha256').update(nonce).digest('hex').slice(0, 16)}`;
const targetPassword = randomBytes(12).toString('hex');
const instanceId = 1;
const actor = {
  userId: 1, username: 'max238-collect-now', roles: ['admin'], permissions: ['*'],
  sessionVersion: 1, instanceScopes: { [instanceId]: 'admin', 2: 'admin' }, requestId: 'max238-collect-now',
} as unknown as ActorContext;

async function main() {
  const root = mysql.createPool({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: '' });
  const handleDir = join(process.cwd(), '.max238-handles');
  const platform = await createOwnedDatabase(root, { nonce: schemaNonce, purpose: 'cnplatform', handleDir });
  const target = await createOwnedDatabase(root, { nonce: schemaNonce, purpose: 'cntarget', handleDir });
  const platformDb = platform.database, targetDb = target.database;
  await root.query(`CREATE TABLE \`${targetDb}\`.probe (id INT PRIMARY KEY)`);
  await root.query(`INSERT INTO \`${targetDb}\`.probe VALUES (1)`);
  await root.query(`CREATE USER '${targetUser}'@'%' IDENTIFIED BY ?`, [targetPassword]);
  await root.query(`GRANT SELECT ON \`${targetDb}\`.* TO '${targetUser}'@'%'`);
  await root.query(`GRANT PROCESS ON *.* TO '${targetUser}'@'%'`);

  const pool: Pool = mysql.createPool({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: '',
    database: platformDb, connectionLimit: 10, timezone: 'Z' });
  await new MigrationRunner(pool as unknown as MigrationPool).run();

  process.env.DB_HOST = '127.0.0.1'; process.env.DB_PORT = String(mysqlPort);
  process.env.DB_USER = 'root'; process.env.DB_PASSWORD = ''; process.env.DB_NAME = platformDb;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.METRICS_COLLECTION_ENABLED = 'true';
  if (!await dbConnection.initialize()) throw new Error('the disposable platform database did not accept the fixture pool');

  await pool.execute('UPDATE users SET session_version = 1 WHERE id = 1');
  await pool.execute("INSERT IGNORE INTO roles (id, name) VALUES (1, 'admin')");
  await pool.execute("INSERT IGNORE INTO permissions (id, code) VALUES (1, 'instance:manage')");
  await pool.execute('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (1, 1)');
  await pool.execute('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (1, 1)');
  await pool.execute("INSERT IGNORE INTO instance_permissions (user_id, instance_id, access_level) VALUES (1, ?, 'admin')", [instanceId]);
  const now = new Date().toISOString();
  await pool.execute(`INSERT INTO database_instances
    (id, name, environment, db_type, db_version, host, port, username, password_encrypted, database_name, status,
     lifecycle_state, max_connections, connection_timeout_ms, created_by, created_at, updated_at)
    VALUES (?, 'max238-collect-now', 'testing', 'mysql', '8.4', '127.0.0.1', ?, ?, ?, ?, 'active', 'available', 10, 5000, 1, ?, ?)`,
  [instanceId, mysqlPort, targetUser, encryptData(targetPassword), targetDb,
    now.replace('T', ' ').replace('Z', ''), now.replace('T', ' ').replace('Z', '')]);
  await pool.execute(`INSERT INTO database_instances
    (id, name, environment, db_type, db_version, host, port, username, password_encrypted, database_name, status,
     lifecycle_state, max_connections, connection_timeout_ms, created_by, created_at, updated_at)
    SELECT 2, 'max238-collect-now-second', environment, db_type, db_version, host, port, username,
      password_encrypted, database_name, status, lifecycle_state, max_connections, connection_timeout_ms,
      created_by, created_at, updated_at FROM database_instances WHERE id = ?`, [instanceId]);
  await pool.execute("INSERT IGNORE INTO instance_permissions (user_id, instance_id, access_level) VALUES (1, 2, 'admin')");
  if (!await databaseService.addConnection(instanceId, 'max238-collect-now', {
    host: '127.0.0.1', port: mysqlPort, user: targetUser, password: targetPassword, database: targetDb, db_type: 'mysql',
  })) throw new Error('the real read-only target connection was not saved');

  const registry = createConfigurationRegistry();
  const repository = new MySqlTemplateRepository(pool as never);
  const templates = new MetricTemplateService(repository, registry);
  const template = await templates.create(actor as never, { name: 'MAX238 collect now' });
  const release = registry.list().map(entry => entry.package)
    .find(pkg => pkg.id === 'mysql-representative' && pkg.version === '1.0.0')!;
  const packagePin = { id: release.id, version: release.version, digest: release.digest };
  const selected = await templates.selectMetric(actor as never, template.template_id,
    { package: packagePin, metric: { id: 'mysql.processlist.count', semantic_version: '1.0.0' } });
  const draft = await repository.getDraft(template.template_id);
  const aggregate = structuredClone(draft!.aggregate) as Record<string, unknown>;
  aggregate.items = [{ item_id: selected.item.item_id, version: selected.item.version }];
  await repository.updateDraft(template.template_id, draft!.revision, { aggregate: aggregate as never, updated_by: 1, updated_at: now });
  const afterDraft = await repository.getDraft(template.template_id);
  const published = await templates.publish(actor as never, template.template_id,
    { expected_draft_revision: afterDraft!.revision, expected_revision: template.revision });
  const record = await repository.getTemplate(template.template_id);
  await repository.updateTemplate(template.template_id, record!.revision,
    { status: 'active', updated_at: new Date(Date.parse(now) + 1000).toISOString() });
  const version = await repository.getVersion(template.template_id, published.version);

  const bindingService = new TemplateBindingService({
    pool: () => pool, registry, access: createAssetCollectorAccess(),
    reload: async () => actor, inventory: undefined,
  });
  const collectService = new CollectNowService({
    pool: () => pool, registry,
    reload: current => actorContextService.revalidateActor(current, current.requestId),
    reloadOn: (current, executor) => actorContextService.revalidateActorOn(executor as never, current, current.requestId, true),
  });
  const scheduler = new MetricScheduler(new MysqlScheduleStore(pool, registry, 'production'), registry,
    createAssetCollectorAccess(), Date.now, undefined, undefined, createCollectNowAuthorizer({
      loadActor: (userId, sessionVersion) => actorContextService.loadActiveActor(userId, sessionVersion),
      loadActorOn: (executor, userId, sessionVersion) =>
        actorContextService.loadActiveActorOn(executor as never, userId, sessionVersion, undefined, true),
    }));
  const jobs = new JobRegistry();
  scheduler.register(jobs);
  const worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as never), `max238cn-${process.pid}`, 30);
  let draining = false;
  let workerError: unknown;
  const timer = setInterval(() => {
    if (draining) return;
    draining = true;
    worker.runOnce((job, context) => jobs.execute(job, context)).catch(error => { workerError = error; }).finally(() => { draining = false; });
  }, 250);
  timer.unref();

  const configService = new MetricConfigurationService(policyService, registry,
    createTrialStore(() => pool, registry), trialAccess, configurationReader(() => pool), async seed => seed);
  const app = Fastify({ logger: false });
  let shutdown: () => Promise<void>;
  const auth = async (request: unknown) => { (request as { user?: ActorContext }).user = actor; };
  app.get('/__health', async () => ({ ok: true }));
  app.post('/__test/shutdown', async () => {
    setTimeout(() => { void shutdown(); }, 50);
    return { stopping: true };
  });
  app.get('/__test/handle', async () => ({ container: process.env.MAX238_E2E_CONTAINER ?? null,
    nonce: process.env.MAX238_E2E_NONCE ?? null, pid: process.pid, port: apiPort, cwd: process.cwd() }));
  const taskView = async (row: RowDataPacket) => {
    const samples = typeof row.samples === 'string' ? JSON.parse(row.samples) : row.samples ?? [];
    const ids = samples.map((sample: { id: string }) => sample.id);
    const formal = ids.length ? ((await pool.query<RowDataPacket[]>(
      `SELECT id, payload FROM metric_observations WHERE stage = 'normalized' AND id IN (${ids.map(() => '?').join(',')})`, ids))[0])
      .map(entry => ({ id: entry.id, observation: typeof entry.payload === 'string' ? JSON.parse(entry.payload) : entry.payload })) : [];
    return { task: { ...row, samples, attempts: typeof row.attempts === 'string' ? JSON.parse(row.attempts) : row.attempts },
      formal, binding: (await pool.query<RowDataPacket[]>('SELECT resource_key, payload FROM metric_policy_bindings WHERE resource_key = ?',
        [refKey({ type: 'instance', id: instanceId })]))[0][0] ?? null };
  };
  app.get('/__test/task', async request => {
    const key = (request.query as { key?: string }).key ?? '';
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT resource_key, caller_key, revision, state, outcome, error_code, samples, attempts, created_at, started_at, finished_at FROM metric_collect_requests WHERE caller_key = ?', [key]);
    return rows[0] ? taskView(rows[0]) : { task: null, formal: [] };
  });
  app.get('/__test/latest', async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT resource_key, caller_key, revision, state, outcome, error_code, samples, attempts, created_at, started_at, finished_at FROM metric_collect_requests ORDER BY created_at DESC LIMIT 1');
    return rows[0] ? taskView(rows[0]) : { task: null, formal: [] };
  });
  await registerMetricConfigurationRoutes(app, auth, configService);
  await registerMetricPolicyRoutes(app, auth, policyService, async seed => seed);
  await registerMetricTemplateRoutes(app, auth, bindingService, collectService);

  // Establish the binding through the real routes (real read-only probe/trial).
  const bindingBody = {
    expected_revision: 0,
    template_pins: [{ template_id: template.template_id, version: published.version, content_hash: version!.content_hash }],
    overrides: { enabled: 'enable', interval_ms: { mode: 'set', value: 30000 }, max_rows: { mode: 'set', value: 50 } },
  };
  const probe = await app.inject({ method: 'POST', url: `/api/metrics/template-bindings/instance/${instanceId}/probe`, payload: bindingBody });
  if (probe.statusCode !== 200) throw new Error(`probe failed: ${probe.body}`);
  const trial = await app.inject({ method: 'POST', url: `/api/metrics/template-bindings/instance/${instanceId}/trial`,
    payload: { ...bindingBody, receipt_id: `collect-now-trial-${process.pid}` } });
  if (trial.statusCode !== 200) throw new Error(`trial failed: ${trial.body}`);
  const applied = await app.inject({ method: 'POST', url: `/api/metrics/template-bindings/instance/${instanceId}/apply`,
    payload: { ...bindingBody, receipt_id: `collect-now-trial-${process.pid}`, caller_key: `collect-now-apply-${process.pid}` } });
  if (applied.statusCode !== 200) throw new Error(`apply failed: ${applied.body}`);

  await app.listen({ host: '127.0.0.1', port: apiPort });
  console.log(`MAX238 collect-now API on 127.0.0.1:${apiPort}; platform ${platformDb}; target ${targetDb}`);

  shutdown = async () => {
    clearInterval(timer);
    try {
      await app.close();
      await worker.shutdown(2000);
      if (draining || workerError) throw workerError ?? new Error('worker still draining');
      await databaseService.removeConnection(instanceId);
      await dbConnection.close();
      await pool.end();
      await root.query(`DROP USER '${targetUser}'@'%'`);
      await target.drop();
      await platform.drop();
      await root.end();
    } catch (error) {
      console.error('MAX238 fixture shutdown failed; retain container and schema handles:', error);
      process.exit(1);
    }
    let cleanupCode = 0;
    const container = process.env.MAX238_E2E_CONTAINER, ownerNonce = process.env.MAX238_E2E_NONCE;
    if (container && ownerNonce) {
      const harness = process.env.MAX238_HARNESS_PATH;
      if (!harness) { console.error('MAX238 fixture: MAX238_HARNESS_PATH is missing'); cleanupCode = 1; }
      else {
        try { execFileSync('bash', [harness, '--cleanup', container, ownerNonce], { stdio: 'inherit', timeout: 60_000 }); }
        catch {
          console.error(`MAX238 fixture: cleanup of ${container} failed; verify with: bash ${harness} --cleanup ${container} ${ownerNonce}`);
          cleanupCode = 1;
        }
      }
    }
    process.exit(cleanupCode);
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

await main();
