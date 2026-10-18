/** Synthetic exclusive schema; real SQL + production scheduler/formalization.
 * No VM, shared database, model, evidence enrichment or action. */
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import { MysqlWorkflowStore } from '../../workflows/worker-runtime.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { MetricScheduler } from '../../metrics/scheduler/service.js';
import { MysqlScheduleStore } from '../../metrics/scheduler/store.js';
import { MetricFormalization } from '../../metrics/rollout/formalization.js';
import { MysqlFormalMetricStore } from '../../metrics/rollout/formal-store.js';
import { createConfigurationRegistry } from '../../metrics/config/registry.js';
import { PolicyService } from '../../metrics/policy/service.js';
import { MysqlPolicyStore } from '../../metrics/policy/store.js';
import { admin } from '../../metrics/policy/test-support.js';
import { MYSQL_STATUS_SQL } from '../../metrics/packages/adapters.js';
import { SourceControl, claimSourceJob } from './control.js';
import { sourceTestConfig } from './config.fixture.js';

const port = Number(process.env.V23_SOURCE_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('V23 foreground source control on isolated MySQL', () => {
  const database = `slide_v23_source_${randomBytes(8).toString('hex')}`;
  let root: Pool, pool: Pool;
  const rows = async (sql: string, values: any[] = []) => (await pool.execute<RowDataPacket[]>(sql, values))[0];
  const control = () => new SourceControl(pool, { ...sourceTestConfig(), database });
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', timezone: 'Z' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, timezone: 'Z', connectionLimit: 16 });
    pool.on('connection', c => c.query("SET time_zone='+00:00'"));
    await new MigrationRunner(pool).run(); await new MigrationRunner(pool).run();
  }, 120000);
  afterAll(async () => {
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE ${database}`); await root.end(); }
  });
  beforeEach(async () => { await pool.query('DELETE FROM workflow_jobs'); await pool.query('DELETE FROM worker_leases'); });
  it('serializes schema ownership and retains completed operation IDs against resends', async () => {
    const a = control(), b = control();
    try {
      await a.open(); await expect(b.open()).rejects.toThrow('LOCK_BUSY');
      await a.close(true);
      const again = new SourceControl(pool, a.config);
      try { await expect(again.open()).rejects.toThrow('OPERATION_ALREADY_RECORDED'); }
      finally { await again.close(); }
      expect((await rows("SELECT state FROM workflow_jobs WHERE job_type='qualification.source'"))[0].state).toBe('completed');
    } finally { await a.close(); await b.close(); }
  });
  it('does not reclaim already sent, failed or expired jobs and excludes unrelated queue work', async () => {
    const queue = new MysqlWorkflowStore(() => pool as never), id = randomUUID();
    await queue.enqueue({ id, type: 'metrics.collect', schemaVersion: 1, payload: {}, idempotencyKey: id });
    const [a, b] = await Promise.allSettled([claimSourceJob(pool, id, 'metrics.collect', 'a'), claimSourceJob(pool, id, 'metrics.collect', 'b')]);
    expect([a, b].filter(x => x.status === 'fulfilled')).toHaveLength(1);
    await pool.query("UPDATE workflow_jobs SET lease_expires_at=DATE_SUB(NOW(),INTERVAL 1 MINUTE) WHERE id=?", [id]);
    await expect(claimSourceJob(pool, id, 'metrics.collect', 'c')).rejects.toThrow('JOB_NOT_UNSENT');
    const c = control();
    try { await expect(c.open()).rejects.toThrow('PRIOR_WORK_REQUIRES_AUDIT'); }
    finally { await c.close(); }
  });
  it('stops after lease loss and quarantines a thrown handler instead of retrying', async () => {
    const c = control(), registry = new JobRegistry(); let calls = 0;
    registry.register('metrics.collect', async () => { calls++; throw Error('lost response'); });
    try {
      await c.open(); const id = randomUUID();
      await new MysqlWorkflowStore(() => pool as never).enqueue({ id, type: 'metrics.collect', schemaVersion: 1, payload: {}, idempotencyKey: id });
      await expect(c.execute(id, 'metrics.collect', registry, () => {})).rejects.toThrow('RESULT_UNCERTAIN');
      await expect(c.execute(id, 'metrics.collect', registry, () => {})).rejects.toThrow('JOB_NOT_UNSENT');
      expect(calls).toBe(1);
      expect((await rows('SELECT state FROM workflow_jobs WHERE id=?', [id]))[0].state).toBe('dead_letter');
      await pool.query("UPDATE worker_leases SET expires_at=DATE_SUB(NOW(),INTERVAL 1 MINUTE)");
      await expect(c.assertActive()).rejects.toThrow('LEASE_LOST');
    } finally { await c.close(); }
    const next = control();
    try { await expect(next.open()).rejects.toThrow('PRIOR_WORK_REQUIRES_AUDIT'); }
    finally { await next.close(); }
  });
  it('uses exact claims to run production collection, raw lineage, formal acceptance and publication (actual local SQL)', async () => {
    const c = control(), packages = createConfigurationRegistry(), ref = { type: 'instance' as const, id: 101 };
    const inventory = () => ({ type: 'instance' as const, id: '101', attributes: {
      'db.engine': { value: 'mysql', observed_at: new Date().toISOString(), source: 'synthetic_local_sql' },
      'db.version': { value: '9.6.0', observed_at: new Date().toISOString(), source: 'synthetic_local_sql' } } });
    await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,db_type,status) VALUES(101,'local only','127.0.0.1',?,'root','unused','mysql','active')", [port]);
    const policies = new PolicyService(new MysqlPolicyStore(() => pool), packages, { exists: async () => true, inventory: async () => inventory() });
    const pin = packages.list().find(r => r.package.id === 'mysql-basic' && r.package.version === '2.0.0')!.package;
    await policies.changeBinding(admin, ref, { expected_revision: 0, package: { id: pin.id, version: pin.version, digest: pin.digest },
      overrides: { interval_ms: { mode: 'set', value: 1000 }, timeout_ms: { mode: 'set', value: 1000 } } }, true);
    let reads = 0;
    const scheduler = new MetricScheduler(new MysqlScheduleStore(pool, packages, 'production'), packages, {
      resolve: async () => ({ resource: inventory(), credential_ref: 'credential:local-only', evidence: {},
        resolve: async () => ({ method: 'sql', pool: { query: async options => {
          expect(options.sql).toBe(MYSQL_STATUS_SQL); reads++; return root.query(options);
        } } }) }) }, Date.now, undefined, new MetricFormalization(pool, packages));
    const registry = new JobRegistry(); scheduler.register(registry);
    try {
      await c.open();
      while (reads < 4) {
        await c.assertActive(); await scheduler.tick();
        const jobs = await rows("SELECT id FROM workflow_jobs WHERE job_type='metrics.collect' AND state='queued'");
        for (const job of jobs) await c.execute(job.id, 'metrics.collect', registry, j => {
          expect(j.payload).toMatchObject({ resource: ref, revision: 1 });
        });
        await delay(200, undefined, { signal: c.signal });
      }
      expect(await new MysqlFormalMetricStore(pool).sourceState(ref)).toBe('semantic');
      expect((await rows('SELECT observation_id FROM metric_publications')).length).toBeGreaterThan(0);
      expect((await rows('SELECT evidence FROM metric_source_acceptance')).length).toBe(1);
      expect((await rows("SELECT id FROM metric_observations WHERE stage='raw'")).length).toBeGreaterThan(0);
      expect(await rows("SELECT id FROM workflow_jobs WHERE job_type LIKE 'action.%' OR state='dead_letter'")).toHaveLength(0);
      await c.close(true);
    } finally { await c.close(); }
  }, 30000);
});
