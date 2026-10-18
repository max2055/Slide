/** Synthetic exclusive schema; real SQL + production scheduler/formalization.
 * No VM, shared database, model, evidence enrichment or action. */
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { auditFixture } from './audit.fixture.js';
import { sourceIntentHash } from './audit.js';

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
  it('commits derived content while its exact job and external lease remain live', async () => {
    const c = control(), registry = new JobRegistry(), id = randomUUID();
    registry.register('investigation.execute', async () => {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction(); await c.assertCommitFence(connection);
        await connection.execute("UPDATE workflow_jobs SET payload=JSON_OBJECT('committed',true) WHERE id=?", [id]);
        await c.assertCommitFence(connection); await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    });
    try {
      await c.open();
      await new MysqlWorkflowStore(() => pool as never).enqueue({ id, type: 'investigation.execute', schemaVersion: 1, payload: {}, idempotencyKey: id });
      await c.execute(id, 'investigation.execute', registry, () => {});
      expect((await rows('SELECT payload FROM workflow_jobs WHERE id=?', [id]))[0].payload).toEqual({ committed: true });
      await c.close(true);
    } finally { await c.close(); }
  });
  it.each(['worker', 'job'])('rolls back derived content when the %s commit fence expires', async kind => {
    const c = control(), registry = new JobRegistry(), id = randomUUID(); let calls = 0;
    registry.register('investigation.execute', async () => {
      calls++;
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute("UPDATE workflow_jobs SET payload=JSON_OBJECT('uncommitted',true) WHERE id=?", [id]);
        if (kind === 'worker') await connection.query("UPDATE worker_leases SET expires_at=DATE_SUB(NOW(),INTERVAL 1 MINUTE)");
        else await connection.execute("UPDATE workflow_jobs SET lease_expires_at=DATE_SUB(NOW(),INTERVAL 1 MINUTE) WHERE id=?", [id]);
        await c.assertCommitFence(connection);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    });
    try {
      await c.open();
      await new MysqlWorkflowStore(() => pool as never).enqueue({ id, type: 'investigation.execute', schemaVersion: 1, payload: {}, idempotencyKey: id });
      await expect(c.execute(id, 'investigation.execute', registry, () => {})).rejects.toThrow('RESULT_UNCERTAIN');
      await expect(c.execute(id, 'investigation.execute', registry, () => {})).rejects.toThrow('JOB_NOT_UNSENT');
      expect(calls).toBe(1);
      expect((await rows('SELECT payload FROM workflow_jobs WHERE id=?', [id]))[0].payload).toEqual({});
    } finally { await c.close(); }
  });
  async function failedAudit() {
    const original = control(); await original.open(); await original.close();
    const [row] = await rows("SELECT * FROM workflow_jobs WHERE job_type='qualification.source'");
    const fixture = auditFixture(); fixture.config.database = database;
    fixture.receipt.predecessor = { ...fixture.receipt.predecessor, intentId: row.id,
      operationId: row.payload.operationId, jobHash: sourceIntentHash(row) };
    fixture.binding.databasePort = port;
    const [identity] = await rows('SELECT @@server_uuid AS uuid');
    fixture.receipt.successor = { ...fixture.receipt.successor, database, databasePort: port, databaseServerUuid: identity.uuid };
    return { ...fixture, oldRow: row };
  }
  it('atomically consumes one signed audit, preserves every old field, and permits later phases without replay', async () => {
    const f = await failedAudit(), auth = f.authorize();
    const next = new SourceControl(pool, f.config, undefined, auth);
    try { await next.open(); await next.close(true); } finally { await next.close(); }
    expect((await rows('SELECT * FROM workflow_jobs WHERE id=?', [f.oldRow.id]))[0]).toEqual(f.oldRow);
    const audit = await rows("SELECT * FROM workflow_jobs WHERE job_type='qualification.source.audit'");
    expect(audit).toHaveLength(1); expect(audit[0].state).toBe('completed');
    const replay = new SourceControl(pool, f.config, undefined, auth);
    try { await expect(replay.open()).rejects.toThrow('OPERATION_ALREADY_RECORDED'); } finally { await replay.close(); }
    const anotherConfig = { ...f.config, operationId: randomUUID() };
    const rebound = f.authorize({ ...f.receipt, successor: { ...f.receipt.successor, operationId: anotherConfig.operationId } });
    const reuse = new SourceControl(pool, anotherConfig, undefined, rebound);
    try { await expect(reuse.open()).rejects.toThrow('AUDIT_ALREADY_USED_OR_UNKNOWN'); } finally { await reuse.close(); }
    const later = control(); try { await later.open(); await later.close(true); } finally { await later.close(); }
    expect((await rows('SELECT * FROM workflow_jobs WHERE id=?', [f.oldRow.id]))[0]).toEqual(f.oldRow);
  });
  it.each(['hash', 'unknown', 'running', 'completed', 'attempts', 'lease', 'otherDeadLetter', 'metrics', 'completedMetric', 'identity', 'expired', 'signature'])('rejects audited continuation on %s and leaves no consumed receipt/new intent', async kind => {
    const f = await failedAudit();
    if (kind === 'hash') f.receipt.predecessor.jobHash = 'f'.repeat(64);
    if (kind === 'unknown') f.receipt.predecessor.intentId = randomUUID();
    if (kind === 'identity') f.receipt.successor.databaseServerUuid = randomUUID();
    if (kind === 'completed') await pool.execute("UPDATE workflow_jobs SET state='completed' WHERE id=?", [f.oldRow.id]);
    if (kind === 'otherDeadLetter') { const id = randomUUID(); await pool.execute("INSERT INTO workflow_jobs(id,job_type,schema_version,payload,idempotency_key,state) VALUES(?,'qualification.source',1,'{}',?,'dead_letter')", [id,id]); }
    if (kind === 'running') await pool.execute("UPDATE workflow_jobs SET state='running' WHERE id=?", [f.oldRow.id]);
    if (kind === 'attempts') await pool.execute('UPDATE workflow_jobs SET attempts=2 WHERE id=?', [f.oldRow.id]);
    if (kind === 'lease') await pool.execute('UPDATE workflow_jobs SET lease_owner=? WHERE id=?', [randomUUID(), f.oldRow.id]);
    if (kind === 'metrics') { const id = randomUUID(); await new MysqlWorkflowStore(() => pool as never).enqueue({ id, type: 'metrics.collect', schemaVersion: 1, payload: {}, idempotencyKey: id }); }
    // A completed metric job is also proof of execution, even without observations.
    if (kind === 'completedMetric') { const id = randomUUID(); await new MysqlWorkflowStore(() => pool as never).enqueue({ id, type: 'metrics.collect', schemaVersion: 1, payload: {}, idempotencyKey: id }); await pool.execute("UPDATE workflow_jobs SET state='completed' WHERE id=?", [id]); }
    if (kind === 'expired') f.receipt.expiresAt = new Date(0).toISOString();
    const auth = f.authorize(); if (kind === 'signature') auth.envelope[20] ^= 1;
    const before = await rows('SELECT * FROM workflow_jobs ORDER BY id');
    const next = new SourceControl(pool, f.config, undefined, auth);
    try { await expect(next.open()).rejects.toThrow(); } finally { await next.close(); }
    expect(await rows('SELECT * FROM workflow_jobs ORDER BY id')).toEqual(before);
  });
  it('rolls back receipt consumption and new intent when expiry occurs during a SQL row-lock wait', async () => {
    const f = await failedAudit(), blocker = await pool.getConnection();
    f.config.deadline = new Date(Date.now() + 500).toISOString();
    f.receipt.successor.deadline = f.config.deadline; f.receipt.expiresAt = f.config.deadline;
    const next = new SourceControl(pool, f.config, undefined, f.authorize());
    const before = await rows('SELECT * FROM workflow_jobs ORDER BY id');
    try {
      await blocker.beginTransaction(); await blocker.execute('SELECT id FROM workflow_jobs WHERE id=? FOR UPDATE', [f.oldRow.id]);
      const attempt = next.open().then(() => null, error => error);
      await delay(650); await blocker.rollback();
      expect(await attempt).toBeInstanceOf(Error);
      expect(await rows('SELECT * FROM workflow_jobs ORDER BY id')).toEqual(before);
    } finally { await blocker.rollback(); blocker.release(); await next.close(); }
  });
  it('serializes concurrent audit consumers with exactly one successor and one immutable predecessor', async () => {
    const f = await failedAudit(), auth = f.authorize();
    const a = new SourceControl(pool, f.config, undefined, auth), b = new SourceControl(pool, f.config, undefined, auth);
    try {
      const results = await Promise.allSettled([a.open(), b.open()]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(await rows("SELECT id FROM workflow_jobs WHERE job_type='qualification.source.audit'")).toHaveLength(1);
      expect(await rows('SELECT id FROM workflow_jobs WHERE idempotency_key=?', [`v23-source:${f.config.operationId}`])).toHaveLength(1);
      expect((await rows('SELECT * FROM workflow_jobs WHERE id=?', [f.oldRow.id]))[0]).toEqual(f.oldRow);
    } finally { await a.close(); await b.close(); }
  });
  it.each(['deadline', 'lease', 'signature', 'cancel', 'valid'])('rechecks %s after the final worker lease row-lock wait', async kind => {
    const f = await failedAudit(), blocker = await pool.getConnection(), cancel = new AbortController();
    const expiry = Date.now() + 2000;
    if (kind === 'deadline') {
      f.config.deadline = new Date(expiry).toISOString();
      f.receipt.successor.deadline = f.config.deadline; f.receipt.expiresAt = f.config.deadline;
    }
    const auth = f.authorize(), next = new SourceControl(pool, f.config, cancel.signal, auth);
    const before = await rows('SELECT * FROM workflow_jobs ORDER BY id');
    // Run the real enqueue unchanged, then take a second-connection row lock.
    // This places contention after lease.acquire(), at recordIntent's final
    // lease SELECT, without replacing a query, result, clock or production API.
    const enqueue = MysqlWorkflowStore.prototype.enqueue;
    const hook = vi.spyOn(MysqlWorkflowStore.prototype, 'enqueue').mockImplementation(async function(job) {
      const result = await enqueue.call(this, job);
      if (job.idempotencyKey === `v23-source:${f.config.operationId}`) {
        await blocker.beginTransaction();
        await blocker.query("SELECT lease_name FROM worker_leases WHERE lease_name='slide-singleton-workers' FOR UPDATE");
        if (kind === 'lease') await blocker.execute('UPDATE worker_leases SET expires_at=?', [new Date(expiry)]);
      }
      return result;
    });
    const attempt = next.open().then(() => null, error => error);
    try {
      let waits: RowDataPacket[] = [];
      const waitDeadline = Date.now() + 1500;
      do {
        waits = await rows(`SELECT w.REQUESTING_ENGINE_TRANSACTION_ID AS requester, w.BLOCKING_ENGINE_TRANSACTION_ID AS blocker,
          l.OBJECT_NAME AS tableName, l.LOCK_TYPE AS lockType, l.LOCK_STATUS AS lockStatus
          FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l
          ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
          WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='worker_leases'`, [database]);
        if (waits.length) break;
        await delay(10);
      } while (Date.now() < waitDeadline);
      expect(waits).toHaveLength(1);
      expect(waits[0]).toMatchObject({ tableName: 'worker_leases', lockType: 'RECORD', lockStatus: 'WAITING' });
      if (kind === 'signature') auth.envelope[20] ^= 1;
      if (kind === 'cancel') cancel.abort(new Error('test cancelled during final lease wait'));
      if (kind === 'deadline' || kind === 'lease') await delay(Math.max(0, expiry - Date.now() + 100));
      const releasedAt = new Date().toISOString();
      await blocker.commit();
      const error = await attempt;
      if (kind === 'valid') {
        expect(error).toBeNull(); await next.close(true);
        expect(await rows("SELECT id FROM workflow_jobs WHERE job_type='qualification.source.audit'")).toHaveLength(1);
        expect(await rows('SELECT id FROM workflow_jobs WHERE idempotency_key=?', [`v23-source:${f.config.operationId}`])).toHaveLength(1);
      } else {
        expect(error).toBeInstanceOf(Error);
        // Includes the complete immutable predecessor and absence of both the
        // receipt consumption and successor, even if open() later rejects.
        expect(await rows('SELECT * FROM workflow_jobs ORDER BY id')).toEqual(before);
      }
      expect((await rows('SELECT * FROM workflow_jobs WHERE id=?', [f.oldRow.id]))[0]).toEqual(f.oldRow);
      console.info(JSON.stringify({ case: kind, waits, expiresAt: new Date(expiry).toISOString(), releasedAt,
        result: error?.message ?? 'committed_once', rollbackVerified: kind !== 'valid' }));
    } finally {
      await blocker.rollback(); blocker.release(); hook.mockRestore(); await attempt; await next.close();
    }
  }, 10000);
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
