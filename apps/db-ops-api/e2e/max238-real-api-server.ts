/**
 * MAX238-APPLY-IDEMPOTENCY-R2 browser evidence backend.
 *
 * A real Fastify HTTP server exposing the real metric-configuration routes and
 * the real MySQL operation journal on a disposable schema (MAX238_TEST_MYSQL_PORT,
 * never 3306). The trial boundary is a controlled fixture: it returns a fixed
 * result after an optional gate. No target is connected, no collector runs, no
 * worker starts, and nothing here is a production deployment.
 *
 * Test-only control surface:
 *   GET  /__health                 readiness for Playwright's webServer
 *   POST /__test/trial/gate        the next trial waits until released
 *   POST /__test/trial/release     release a gated trial
 *   GET  /__test/state?key=...     journal state, trial count and revision
 */
import Fastify from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dbConnection } from '../src/db-connection.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import type { MigrationPool } from '../src/migrations/types.js';
import type { ActorContext } from '../src/auth/actor-context.js';
import { MetricConfigurationService } from '../src/metrics/config/service.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { createTrialStore, registerMetricConfigurationRoutes } from '../src/metrics/config/routes.js';
import { configurationReader } from '../src/metrics/config/status-store.js';
import { trialAccess } from '../src/metrics/config/access.js';
import { policyService } from '../src/metrics/policy/service.js';
import { registerMetricPolicyRoutes } from '../src/metrics/policy/routes.js';
import { refKey } from '../src/metrics/policy/model.js';

const mysqlPort = Number(process.env.MAX238_TEST_MYSQL_PORT);
const apiPort = Number(process.env.MAX238_API_PORT ?? 51839);
if (!mysqlPort) { console.error('MAX238_TEST_MYSQL_PORT is required'); process.exit(2); }

const database = `max238_e2e_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const admin: ActorContext = { userId: 1, username: 'e2e-fixture', roles: [], permissions: ['*'],
  instanceScopes: {}, sessionVersion: 1, requestId: 'max238-e2e' };
const state = { trials: 0, gate: null as Promise<void> | null, release: null as (() => void) | null };
const trialResult = { trial: true, persisted: false, decision: 'attempted',
  attempts: [{ id: 'e2e-attempt', collector_id: 'e2e-fixture', status: 'succeeded' }], capabilities: [],
  applicability: [], lifecycle_evidence: 'available',
  samples: [{ metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, value: 60,
    quality: { status: 'good' }, unit: 's' }] };

async function main() {
  const root = mysql.createPool({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: '' });
  await root.query(`CREATE DATABASE ${database}`);
  const pool: Pool = mysql.createPool({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: '',
    database, connectionLimit: 10, timezone: 'Z' });
  await new MigrationRunner(pool as unknown as MigrationPool).run();
  await pool.execute(`INSERT INTO database_instances
    (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
    VALUES (1,'e2e-max238','production','mysql','127.0.0.1',3306,'fixture','','fixture','8.0.46','active','available')`);

  process.env.DB_HOST = '127.0.0.1'; process.env.DB_PORT = String(mysqlPort);
  process.env.DB_USER = 'root'; process.env.DB_PASSWORD = ''; process.env.DB_NAME = database;
  process.env.METRICS_COLLECTION_ENABLED = 'true';
  const connected = await dbConnection.initialize();
  if (!connected) throw new Error('the disposable platform database did not accept the fixture pool');

  const registry = createConfigurationRegistry();
  const service = new MetricConfigurationService(policyService, registry,
    createTrialStore(() => pool, registry), trialAccess, configurationReader(() => pool), async seed => seed);
  service.trial = async () => {
    state.trials++;
    if (state.gate) { const gate = state.gate; state.gate = null; await gate; }
    return trialResult as never;
  };

  const app = Fastify({ logger: false });
  app.get('/__health', async () => ({ ok: true }));
  app.post('/__test/trial/gate', async () => {
    state.gate = new Promise<void>(resolve => { state.release = resolve; });
    return { gated: true };
  });
  app.post('/__test/trial/release', async () => { state.release?.(); state.release = null; return { released: true }; });
  app.get('/__test/state', async request => {
    const key = (request.query as { key?: string }).key ?? '';
    const [operations] = await pool.query<RowDataPacket[]>(
      'SELECT state, target_revision, committed_at FROM metric_policy_apply_operations WHERE operation_key = ?', [key]);
    const [bindings] = await pool.query<RowDataPacket[]>(
      `SELECT payload FROM metric_policy_bindings WHERE resource_key = ?`, [refKey({ type: 'instance', id: 1 })]);
    const payload = bindings[0]?.payload;
    return { trials: state.trials, journal: operations[0] ?? null,
      revision: payload === undefined ? null : Number((typeof payload === 'string' ? JSON.parse(payload) : payload).binding.revision) };
  });
  await registerMetricConfigurationRoutes(app, async request => {
    (request as unknown as { user?: ActorContext }).user = admin;
  }, service);
  await registerMetricPolicyRoutes(app, async request => {
    (request as unknown as { user?: ActorContext }).user = admin;
  }, policyService);
  await app.listen({ host: '127.0.0.1', port: apiPort });
  console.log(`MAX238 e2e API on 127.0.0.1:${apiPort}, disposable schema ${database}`);

  const shutdown = async () => {
    await app.close().catch(() => undefined);
    // The launcher's own trap may never run when a test runner kills the group;
    // stop the disposable container from whichever process receives the signal.
    if (process.env.MAX238_E2E_CONTAINER) {
      try { execFileSync('docker', ['rm', '-f', process.env.MAX238_E2E_CONTAINER], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
    await pool.query(`DROP DATABASE IF EXISTS ${database}`).catch(() => undefined);
    await pool.end().catch(() => undefined); await root.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

await main();
