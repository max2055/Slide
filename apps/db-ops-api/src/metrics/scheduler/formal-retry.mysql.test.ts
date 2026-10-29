import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection, decryptData, encryptData } from '../../db-connection.js';
import { databaseService } from '../../database-service.js';
import sshSessionPool from '../../ssh-session-pool.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { configurationInventory } from '../config/inventory.js';
import { createAssetCollectorAccess } from '../config/access.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';
import { JOB_TYPE, MysqlScheduleStore } from './store.js';
import { MetricScheduler } from './service.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import { JobRegistry } from '../../workflows/job-registry.js';

/**
 * MAX-238 formal-retry package. On a disposable schema (METRICS_TEST_MYSQL_PORT) fed by the
 * existing MetricScheduler -> WorkerRuntime path, two real targets (instance 1 mysql3306 and
 * server 3 192.168.49.130:22) each get exactly one formal job. The package then proves, using
 * existing columns only, that a repeated request cannot execute a job twice:
 *
 *   1. a second tick while both jobs are still pending inserts no job;
 *   2. an immediate tick after both jobs complete inserts no job and keeps one job id,
 *      one fencing token and one observation set per resource;
 *   3. re-enqueuing a completed job's existing idempotency_key with a new id adds no row.
 *
 * The source application database is read with SELECT only; credentials are decrypted from
 * the existing rows and re-encrypted into the disposable copy. Live binding, schedule,
 * observation and asset rows are never written.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const envFile = process.env.SLIDE_DEBUG_ENV_FILE;
const database = `max238_formal_retry_${process.pid}`;
const instanceRef = { type: 'instance' as const, id: 1 };
const serverRef = { type: 'server' as const, id: 3 };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!port || !envFile)('MAX-238 repeated requests never execute a job twice', () => {
  let root: Pool, pool: Pool, source: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let scheduler: MetricScheduler, jobs: JobRegistry, worker: WorkerRuntime, queue: MysqlWorkflowStore;
  let configured: Record<string, string>;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  let startedAt: string;
  const evidence: Record<string, unknown> = {};
  const query = async (target: Pool, sql: string, values: unknown[] = []) =>
    (await target.query<RowDataPacket[]>(sql, values as never))[0];
  const rows = (sql: string, values: unknown[] = []) => query(pool, sql, values);
  const one = async (sql: string, values: unknown[] = []) => (await rows(sql, values))[0];

  /** Read-only snapshot of exactly the facts this package must not change on the source. */
  const liveSnapshot = async () => {
    const instances = await query(source, 'SELECT COUNT(*) AS n FROM database_instances');
    const servers = await query(source, 'SELECT COUNT(*) AS n FROM servers');
    const server3 = await query(source, 'SELECT id, collection_enabled, host, port FROM servers WHERE id = 3');
    const bindings = await query(source,
      "SELECT resource_key, JSON_EXTRACT(payload,'$.binding.revision') AS revision FROM metric_policy_bindings WHERE resource_key IN ('instance:1','server:3') ORDER BY resource_key");
    return {
      database_instances: Number(instances[0].n),
      servers: Number(servers[0].n),
      server3: { id: Number(server3[0]?.id ?? 0), collection_enabled: Number(server3[0]?.collection_enabled ?? -1),
        host: String(server3[0]?.host ?? ''), port: Number(server3[0]?.port ?? 0) },
      bindings: bindings.map(row => ({ resource_key: String(row.resource_key), revision: Number(row.revision) })),
    };
  };

  const resourceOf = (job: RowDataPacket) => {
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    return `${payload.resource.type}:${payload.resource.id}`;
  };

  /** Observations attributable to one completed job through its existing attempt_id prefix. */
  const observationCount = async (jobId: string, fencingToken: number) => Number((await one(
    `SELECT COUNT(*) AS n FROM metric_observations WHERE stage = 'normalized'
     AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.source.attempt_id')) LIKE ?`, [`${jobId}:${fencingToken}:%`]))!.n);

  beforeAll(async () => {
    configured = parse(readFileSync(envFile!));
    vi.stubEnv('ENCRYPTION_KEY', configured.ENCRYPTION_KEY);
    // READ-ONLY source connection: every statement issued through it below is a SELECT.
    source = mysql.createPool({ host: configured.DB_HOST || '127.0.0.1', port: Number(configured.DB_PORT || 3306),
      user: configured.DB_USER || 'root', password: configured.DB_PASSWORD || '', database: configured.DB_NAME, connectionLimit: 4 });
    const [instance] = await query(source,
      'SELECT id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state FROM database_instances WHERE id = 1');
    const [server] = await query(source,
      'SELECT id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,status,collection_enabled FROM servers WHERE id = 3');
    // Pin the authorized targets, including ports, before any copy or collection request.
    expect(instance).toMatchObject({ id: 1, name: 'mysql3306', port: 3306 });
    expect(server).toMatchObject({ id: 3, host: '192.168.49.130', port: 22 });
    const instancePassword = decryptData(String(instance.password_encrypted), configured.ENCRYPTION_KEY);
    const serverCredentials = JSON.parse(decryptData(String(server.credential_encrypted), configured.ENCRYPTION_KEY)) as { username: string; password?: string; privateKey?: string };
    expect(serverCredentials.username).toBeTruthy();
    expect(serverCredentials.password || serverCredentials.privateKey).toBeTruthy();

    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);

    await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (?,?,?,?,?,?,?,?,?,?,'active','available')`, [1, instance.name, instance.environment, instance.db_type,
      instance.host, instance.port, instance.username, encryptData(instancePassword, configured.ENCRYPTION_KEY),
      instance.database_name, instance.db_version]);
    expect(await databaseService.addConnection(1, String(instance.name), { host: String(instance.host), port: Number(instance.port),
      user: String(instance.username), password: instancePassword, database: instance.database_name || 'mysql', db_type: 'mysql' })).toBe(true);
    await pool.execute(`INSERT INTO servers
      (id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,status,collection_enabled)
      VALUES (?,?,?,?,?,?,?,?,'online',?)`, [3, server.host, server.port, server.label, server.os_type, server.credential_type,
      encryptData(JSON.stringify(serverCredentials), configured.ENCRYPTION_KEY), server.host_key_fingerprint, server.collection_enabled]);

    packages = createConfigurationRegistry();
    const policies = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: configurationInventory });
    const pinOf = (id: string) => {
      const release = packages.list().find(r => r.package.id === id && r.package.version === '1.1.0');
      expect(release, `${id}@1.1.0 must be installed`).toBeTruthy();
      return { id: release!.package.id, version: release!.package.version, digest: release!.package.digest };
    };
    await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: pinOf('mysql-diagnostics'), overrides: {} }, true);
    await policies.changeBinding(admin, serverRef, { expected_revision: 0, package: pinOf('linux-host'), overrides: {} }, true);

    scheduler = new MetricScheduler(new MysqlScheduleStore(pool, packages), packages, createAssetCollectorAccess(true));
    jobs = new JobRegistry();
    scheduler.register(jobs);
    queue = new MysqlWorkflowStore(() => pool as never);
    worker = new WorkerRuntime(queue, 'max238-formal-retry', 60);
    startedAt = new Date().toISOString();
  }, 180000);

  afterAll(async () => {
    await databaseService.removeConnection(1).catch(() => undefined);
    sshSessionPool.closeAll();
    poolSpy?.mockRestore();
    await source?.end();
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
    vi.unstubAllEnvs();
  }, 60000);

  it('proves a pending, completed and replayed job is never executed twice', async () => {
    const before = await liveSnapshot();
    // The authorized source baseline this package must leave untouched.
    expect(before).toEqual({ database_instances: 5, servers: 1,
      server3: { id: 3, collection_enabled: 1, host: '192.168.49.130', port: 22 },
      bindings: [{ resource_key: 'instance:1', revision: 4 }, { resource_key: 'server:3', revision: 3 }] });

    // Both jobs must be due before the first assertion; the per-resource jitter is real,
    // so scan until both rows are queued instead of rewriting the persisted schedule.
    let queued = await scheduler.tick();
    const deadline = Date.now() + 15000;
    while (queued < 2 && Date.now() < deadline) {
      await sleep(250);
      queued += await scheduler.tick();
    }
    expect(queued).toBe(2);

    const firstSchedules = await rows('SELECT resource_key, job_id, revision, next_due_ms FROM metric_schedule ORDER BY resource_key');
    expect(firstSchedules.map(row => row.resource_key)).toEqual(['instance:1', 'server:3']);
    const firstJobIds = Object.fromEntries(firstSchedules.map(row => [String(row.resource_key), String(row.job_id)]));
    expect(firstJobIds['instance:1']).toBeTruthy();
    expect(firstJobIds['server:3']).toBeTruthy();
    expect(firstJobIds['instance:1']).not.toBe(firstJobIds['server:3']);
    const pendingJobs = await rows('SELECT id, job_type, state, fencing_token, idempotency_key, payload FROM workflow_jobs ORDER BY id');
    expect(pendingJobs).toHaveLength(2);
    expect(pendingJobs.map(job => String(job.state))).toEqual(['queued', 'queued']);
    expect(pendingJobs.map(job => String(job.id)).sort()).toEqual(Object.values(firstJobIds).sort());

    // 1. Both jobs are already in workflow_jobs and no worker has run: a repeated tick
    //    sees two non-terminal jobs and must not insert another job for either resource.
    const tickWhilePending = await scheduler.tick();
    expect(tickWhilePending).toBe(0);
    const schedulesWhilePending = await rows('SELECT resource_key, job_id FROM metric_schedule ORDER BY resource_key');
    expect(schedulesWhilePending.map(row => ({ resource_key: String(row.resource_key), job_id: String(row.job_id) })))
      .toEqual(Object.keys(firstJobIds).sort().map(key => ({ resource_key: key, job_id: firstJobIds[key] })));
    const jobsWhilePending = await rows('SELECT id, state, fencing_token FROM workflow_jobs ORDER BY id');
    expect(jobsWhilePending).toHaveLength(2);
    expect(jobsWhilePending.map(job => String(job.id)).sort()).toEqual(Object.values(firstJobIds).sort());
    expect(jobsWhilePending.map(job => String(job.state))).toEqual(['queued', 'queued']);

    // Both real targets run once each through the existing worker.
    const outcomes: string[] = [];
    for (let run = 0; run < 2; run++) outcomes.push(await worker.runOnce((claimed, context) => jobs.execute(claimed, context), Date.now()));
    expect(outcomes).toEqual(['completed', 'completed']);

    const completedJobs = await rows('SELECT id, state, attempts, fencing_token, idempotency_key, payload FROM workflow_jobs ORDER BY id');
    expect(completedJobs).toHaveLength(2);
    expect(completedJobs.map(job => String(job.state))).toEqual(['completed', 'completed']);
    const byResource = Object.fromEntries(completedJobs.map(job => [resourceOf(job), job]));
    expect(Object.keys(byResource).sort()).toEqual(['instance:1', 'server:3']);
    const completed: Record<string, { job_id: string; fencing_token: number; attempts: number; idempotency_key: string; payload: unknown; observations: number }> = {};
    for (const key of ['instance:1', 'server:3']) {
      const job = byResource[key];
      expect(String(job.id)).toBe(firstJobIds[key]);
      expect(Number(job.fencing_token)).toBe(1);
      expect(String(job.idempotency_key)).toBe(`metric:${key}:${job.id}`);
      const observations = await observationCount(String(job.id), Number(job.fencing_token));
      expect(observations, `${key} observations`).toBeGreaterThan(0);
      completed[key] = { job_id: String(job.id), fencing_token: Number(job.fencing_token), attempts: Number(job.attempts),
        idempotency_key: String(job.idempotency_key), payload: typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload,
        observations };
    }
    // commit already advanced next_due_ms past the interval and cleared the pending job.
    const schedulesCompleted = await rows('SELECT resource_key, job_id, next_due_ms FROM metric_schedule ORDER BY resource_key');
    expect(schedulesCompleted.map(row => String(row.resource_key))).toEqual(['instance:1', 'server:3']);
    expect(schedulesCompleted.map(row => row.job_id)).toEqual([null, null]);
    expect(schedulesCompleted.every(row => Number(row.next_due_ms) > Date.now())).toBe(true);

    // 2. An immediate tick after both completions is not the next normal collection:
    //    it must not enqueue, must keep the two job rows, one fencing token and one
    //    unchanged observation set per resource.
    const tickAfterCompletion = await scheduler.tick();
    expect(tickAfterCompletion).toBe(0);
    const jobsAfterTick = await rows('SELECT id, state, fencing_token FROM workflow_jobs ORDER BY id');
    expect(jobsAfterTick).toHaveLength(2);
    expect(jobsAfterTick.map(job => String(job.id)).sort()).toEqual(Object.values(firstJobIds).sort());
    expect(jobsAfterTick.map(job => Number(job.fencing_token))).toEqual([1, 1]);
    const schedulesAfterTick = await rows('SELECT resource_key, job_id FROM metric_schedule ORDER BY resource_key');
    expect(schedulesAfterTick.map(row => row.job_id)).toEqual([null, null]);
    const observationsAfterTick: Record<string, number> = {};
    for (const key of ['instance:1', 'server:3']) {
      const observations = await observationCount(completed[key].job_id, completed[key].fencing_token);
      expect(observations, `${key} observations after repeated tick`).toBe(completed[key].observations);
      observationsAfterTick[key] = observations;
    }

    // 3. Replaying a completed job's existing idempotency_key with a different id is
    //    absorbed by uq_workflow_job_idempotency and adds no row.
    const replays = [];
    for (const key of ['instance:1', 'server:3']) {
      const original = completed[key];
      const attemptedId = randomUUID();
      expect(attemptedId).not.toBe(original.job_id);
      await queue.enqueue({ id: attemptedId, type: JOB_TYPE, schemaVersion: 1, payload: original.payload as Record<string, unknown>,
        idempotencyKey: original.idempotency_key, maxAttempts: 3, availableAt: new Date(Date.now() - 1000) });
      const matching = await rows('SELECT id, state, fencing_token FROM workflow_jobs WHERE idempotency_key = ?', [original.idempotency_key]);
      expect(matching, `${key} rows for idempotency key`).toHaveLength(1);
      expect(String(matching[0].id)).toBe(original.job_id);
      expect(String(matching[0].state)).toBe('completed');
      expect(await rows('SELECT id FROM workflow_jobs WHERE id = ?', [attemptedId])).toHaveLength(0);
      const total = await one('SELECT COUNT(*) AS n FROM workflow_jobs');
      expect(Number(total!.n)).toBe(2);
      const observations = await observationCount(original.job_id, original.fencing_token);
      expect(observations, `${key} observations after replay`).toBe(original.observations);
      replays.push({ resource_key: key, original_job_id: original.job_id, attempted_job_id: attemptedId,
        idempotency_key: original.idempotency_key, rows_for_key: matching.length, state: String(matching[0].state),
        observations_before: original.observations, observations_after: observations });
    }

    // Only the disposable schema received jobs and observations; the source stays identical.
    const after = await liveSnapshot();
    expect(after).toEqual(before);
    evidence.readonly = { pre: before, post: after, unchanged: true };
    evidence.schedule = { first: firstSchedules.map(row => ({ resource_key: String(row.resource_key), job_id: String(row.job_id),
      revision: Number(row.revision), next_due_ms: Number(row.next_due_ms) })),
    completed: schedulesCompleted.map(row => ({ resource_key: String(row.resource_key), job_id: row.job_id, next_due_ms: Number(row.next_due_ms) })) };
    evidence.in_progress_retick = { started_at: startedAt, tick_result: tickWhilePending, jobs: jobsWhilePending.map(job => ({
      job_id: String(job.id), state: String(job.state), fencing_token: Number(job.fencing_token) })),
    schedule_job_ids: schedulesWhilePending.map(row => ({ resource_key: String(row.resource_key), job_id: String(row.job_id) })) };
    evidence.completed = { outcomes, jobs: Object.entries(completed).map(([resource_key, job]) => ({ resource_key,
      job_id: job.job_id, fencing_token: job.fencing_token, attempts: job.attempts, idempotency_key: job.idempotency_key, observations: job.observations })) };
    evidence.post_completion_retick = { tick_result: tickAfterCompletion, workflow_job_rows: jobsAfterTick.length,
      fencing_tokens: jobsAfterTick.map(job => Number(job.fencing_token)), schedule_job_ids: schedulesAfterTick.map(row => row.job_id),
      observations: observationsAfterTick };
    evidence.duplicate_idempotency = replays;
    evidence.run = { branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), test: 'formal-retry.mysql.test.ts',
      disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll` };
    evidence.targets = { instance: { id: 1, name: 'mysql3306', host: 'localhost', port: 3306 },
      server: { id: 3, host: '192.168.49.130', port: 22 } };
    writeFileSync(new URL('../../../../../docs/slide/development/MAX-238/formal-retry-20261027.json', import.meta.url),
      JSON.stringify(evidence, null, 2) + '\n');
  }, 180000);
});
