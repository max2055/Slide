import Fastify from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../../db-connection.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin, pin } from '../policy/test-support.js';
import { configurationInventory } from './inventory.js';
import { createConfigurationRegistry } from './registry.js';
import { createTrialStore, registerMetricConfigurationRoutes } from './routes.js';
import { MetricConfigurationService } from './service.js';
import { configurationReader } from './status-store.js';

const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const ref = { type: 'instance' as const, id: 1 };
const jobId = 'aaaaaaaa-0000-4000-8000-000000000001';

describe.skipIf(!port)('configuration status with mixed MySQL collations', () => {
  const database = `max189_status_${process.pid}`;
  let root: Pool, pool: Pool, app: ReturnType<typeof Fastify>, policy: PolicyService;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    // Build the real schema, then reproduce the existing deployment's mixed collations.
    await root.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    // Older metric tables may use unicode_ci while workflow_jobs inherits MySQL 8's 0900 default.
    // Deliberately keep them different: making both equal would conceal the production failure.
    await pool.query('ALTER TABLE metric_schedule MODIFY job_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL');
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    vi.stubEnv('METRICS_COLLECTION_ENABLED', 'true');
    await pool.execute(`INSERT INTO database_instances(id,name,host,port,username,password_encrypted,db_type,db_version,status)
      VALUES(1,'status fixture','127.0.0.1',3306,'fixture','','mysql','8.0.46','active')`);
    const registry = createConfigurationRegistry();
    policy = new PolicyService(new MysqlPolicyStore(() => pool), registry,
      { exists: async r => r.id === 1, inventory: configurationInventory });
    const service = new MetricConfigurationService(policy, registry, createTrialStore(() => pool, registry),
      { resolve: async () => { throw new Error('status must not collect'); } }, configurationReader(() => pool));
    app = Fastify();
    await registerMetricConfigurationRoutes(app, async request => {
      (request as any).user = request.headers.authorization === 'Bearer denied'
        ? { ...admin, permissions: [], instanceScopes: {} } : admin;
    }, service);
  }, 120000);
  afterAll(async () => {
    await app?.close(); poolSpy?.mockRestore(); vi.unstubAllEnvs(); await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });
  beforeEach(async () => {
    for (const table of ['metric_schedule', 'workflow_jobs', 'metric_policy_bindings', 'metric_policy_audit']) {
      await pool.query(`DELETE FROM ${table}`);
    }
  });
  const status = () => app.inject('/api/metrics/config/resources/instance/1/status');
  const seed = async (key = 'instance:1', revision = 1, scheduledId: string | null = jobId, state = 'running') => {
    await policy.changeBinding(admin, ref, { expected_revision: 0, package: pin }, true);
    await pool.execute(`INSERT INTO workflow_jobs(id,job_type,schema_version,payload,idempotency_key,state)
      VALUES(?,'metrics.collect',1,'{}',?,?)`, [jobId, jobId, state]);
    await pool.execute(`INSERT INTO metric_schedule(resource_key,revision,next_due_ms,job_id,states)
      VALUES(?,?,0,?,'{}')`, [key, revision, scheduledId]);
  };

  it('reads empty scheduling tables and returns unbound HTTP 200 without hiding SQL errors', async () => {
    const [columns] = await pool.execute<RowDataPacket[]>(`SELECT TABLE_NAME, COLLATION_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND ((TABLE_NAME = 'metric_schedule' AND COLUMN_NAME = 'job_id')
        OR (TABLE_NAME = 'workflow_jobs' AND COLUMN_NAME = 'id')) ORDER BY TABLE_NAME`, [database]);
    expect(columns.map(c => [c.TABLE_NAME, c.COLLATION_NAME])).toEqual([
      ['metric_schedule', 'utf8mb4_unicode_ci'], ['workflow_jobs', 'utf8mb4_0900_ai_ci'],
    ]);
    expect(await configurationReader(() => pool).evidence(ref, null)).toMatchObject({ in_flight: false,
      formal: { state: 'pending', last_observed_at: null, generation: null } });
    const response = await status();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ binding: { state: 'unbound' }, collection: { in_flight: false },
      formal_visibility: { state: 'unbound', last_observed_at: null } });
  });

  it('reports the exact current running job while formal observations remain pending', async () => {
    await seed();
    const response = await status();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ binding: { state: 'bound', published_revision: 1 },
      collection: { state: 'running', in_flight: true, last_success_at: null },
      formal_visibility: { state: 'pending', last_observed_at: null, freshness: 'unknown' } });
  });

  it.each([
    ['other resource', 'instance:2', 1, jobId, 'running'],
    ['old revision', 'instance:1', 2, jobId, 'running'],
    ['case mismatch', 'instance:1', 1, jobId.toUpperCase(), 'running'],
    ['trailing space', 'instance:1', 1, `${jobId} `, 'running'],
    ['missing job', 'instance:1', 1, 'missing-job', 'running'],
    ['no job', 'instance:1', 1, null, 'running'],
    ['queued', 'instance:1', 1, jobId, 'queued'],
    ['completed', 'instance:1', 1, jobId, 'completed'],
    ['cancelled', 'instance:1', 1, jobId, 'cancelled'],
  ])('does not mark %s as in flight', async (_name, key, revision, id, state) => {
    await seed(key as string, revision as number, id as string | null, state as string);
    const response = await status();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ binding: { state: 'bound' },
      collection: { state: 'pending', in_flight: false, last_success_at: null },
      formal_visibility: { state: 'pending', last_observed_at: null } });
  });

  it('keeps resource permission denial before evidence access', async () => {
    const response = await app.inject({ url: '/api/metrics/config/resources/instance/1/status',
      headers: { authorization: 'Bearer denied' } });
    expect(response.statusCode).toBe(403);
  });
});
