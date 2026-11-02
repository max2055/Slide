import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
 * MAX-238 formal-timeout package. The disposable schema (METRICS_TEST_MYSQL_PORT) is fed by the
 * existing MetricScheduler -> WorkerRuntime path for two real targets (instance 1 mysql3306 and
 * server 3 192.168.49.130:22). Both disposable bindings carry the existing `timeout_ms` override
 * at its platform floor (250ms, below the binding interval), the worker lease stays far longer,
 * and no collector is mocked. Each target runs exactly one real worker attempt, proving:
 *
 *   1. the existing SCHEDULE_TIMEOUT deadline cancels the attempt while its real read is still
 *      running; the job is not completed and no second job row appears;
 *   2. the cancelled attempt commits no formal observation for its existing attempt_id prefix
 *      (stage='normalized' is 0) and leaves an existing cancellation event;
 *   3. an immediate tick while the job is still non-terminal enqueues nothing and keeps the one
 *      existing job id on the schedule row.
 *
 * The source application database is read with SELECT only; credentials are decrypted from the
 * existing rows and re-encrypted into the disposable copy. Live binding, schedule, observation
 * and asset rows are never written.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const envFile = process.env.SLIDE_DEBUG_ENV_FILE;
const database = `max238_formal_timeout_${process.pid}`;
const TIMEOUT_MS = 250;
const LEASE_SECONDS = 60;
const instanceRef = { type: 'instance' as const, id: 1 };
const serverRef = { type: 'server' as const, id: 3 };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!port || !envFile)('MAX-238 a timed-out attempt never executes twice', () => {
  let root: Pool, pool: Pool, source: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let scheduler: MetricScheduler, jobs: JobRegistry, worker: WorkerRuntime;
  let configured: Record<string, string>;
  let poolSpy: ReturnType<typeof vi.spyOn>;
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

  /** Observations attributable to one cancelled attempt through its existing attempt_id prefix. */
  const observationCount = async (jobId: string, fencingToken: number) => Number((await one(
    `SELECT COUNT(*) AS n FROM metric_observations WHERE stage = 'normalized'
     AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.source.attempt_id')) LIKE ?`, [`${jobId}:${fencingToken}:%`]))!.n);
  const attemptRows = async (jobId: string, fencingToken: number) => Number((await one(
    'SELECT COUNT(*) AS n FROM metric_attempts WHERE id LIKE ?', [`${jobId}:${fencingToken}:%`]))!.n);
  const eventsOf = (jobId: string) => rows(
    'SELECT code, duration_ms, uncertain, logical_reads FROM metric_schedule_events WHERE job_id = ? ORDER BY code', [jobId]);

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
    // The existing platform floor, below each package's 60s cadence; no new configuration key.
    const overrides = { timeout_ms: { mode: 'set' as const, value: TIMEOUT_MS } };
    await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: pinOf('mysql-diagnostics'), overrides }, true);
    await policies.changeBinding(admin, serverRef, { expected_revision: 0, package: pinOf('linux-host'), overrides }, true);

    scheduler = new MetricScheduler(new MysqlScheduleStore(pool, packages), packages, createAssetCollectorAccess(true));
    jobs = new JobRegistry();
    scheduler.register(jobs);
    worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as never), 'max238-formal-timeout', LEASE_SECONDS);
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

  it('cancels one real attempt per target at the deadline without committing or re-enqueuing', async () => {
    const before = await liveSnapshot();
    // The authorized source baseline this package must leave untouched.
    expect(before).toEqual({ database_instances: 5, servers: 1,
      server3: { id: 3, collection_enabled: 1, host: '192.168.49.130', port: 22 },
      bindings: [{ resource_key: 'instance:1', revision: 4 }, { resource_key: 'server:3', revision: 3 }] });

    // The disposable bindings must carry the floor timeout below their own interval.
    const bindingRows = await rows("SELECT resource_key, payload FROM metric_policy_bindings WHERE resource_key IN ('instance:1','server:3') ORDER BY resource_key");
    expect(bindingRows.map(row => String(row.resource_key))).toEqual(['instance:1', 'server:3']);
    const bindingFacts = bindingRows.map(row => {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      return { resource_key: String(row.resource_key), revision: Number(payload.binding.revision),
        timeout_ms: Number(payload.resolved.settings.timeout_ms), interval_ms: Number(payload.resolved.settings.interval_ms) };
    });
    for (const fact of bindingFacts) {
      expect(fact.timeout_ms).toBe(TIMEOUT_MS);
      expect(fact.interval_ms).toBeGreaterThan(TIMEOUT_MS);
    }
    expect(LEASE_SECONDS * 1000).toBeGreaterThan(TIMEOUT_MS);

    // Both jobs must be due before the attempt assertions; the per-resource jitter is real,
    // so scan until both rows are queued instead of rewriting the persisted schedule.
    let queued = await scheduler.tick();
    const deadline = Date.now() + 15000;
    while (queued < 2 && Date.now() < deadline) {
      await sleep(250);
      queued += await scheduler.tick();
    }
    expect(queued).toBe(2);

    const firstSchedules = await rows('SELECT resource_key, job_id, revision, next_due_ms FROM metric_schedule ORDER BY resource_key');
    expect(firstSchedules.map(row => String(row.resource_key))).toEqual(['instance:1', 'server:3']);
    const firstJobIds = Object.fromEntries(firstSchedules.map(row => [String(row.resource_key), String(row.job_id)]));
    expect(firstJobIds['instance:1']).toBeTruthy();
    expect(firstJobIds['server:3']).toBeTruthy();
    expect(firstJobIds['instance:1']).not.toBe(firstJobIds['server:3']);

    // Each real target runs exactly one existing worker attempt through the real transport.
    const claims: string[] = [];
    const outcomes: string[] = [];
    const elapsed: number[] = [];
    for (let run = 0; run < 2; run++) {
      const started = Date.now();
      outcomes.push(await worker.runOnce((claimed, context) => { claims.push(claimed.id); return jobs.execute(claimed, context); }, Date.now()));
      elapsed.push(Date.now() - started);
    }
    // A real read that beats the 250ms deadline would invalidate this package: report its timing.
    const committedEvents = await rows("SELECT job_id, duration_ms FROM metric_schedule_events WHERE code = 'committed'");
    expect(committedEvents, `a real read completed before the ${TIMEOUT_MS}ms deadline: ${JSON.stringify(committedEvents)}`).toHaveLength(0);
    expect(outcomes).toEqual(['retry', 'retry']);
    expect(claims).toHaveLength(2);
    expect(new Set(claims).size).toBe(2);
    expect([...claims].sort()).toEqual(Object.values(firstJobIds).sort());

    const timedOutJobs = await rows('SELECT id, state, attempts, fencing_token, payload FROM workflow_jobs ORDER BY id');
    expect(timedOutJobs).toHaveLength(2);
    expect(timedOutJobs.map(job => String(job.id)).sort()).toEqual(Object.values(firstJobIds).sort());
    const byResource = Object.fromEntries(timedOutJobs.map(job => [resourceOf(job), job]));
    expect(Object.keys(byResource).sort()).toEqual(['instance:1', 'server:3']);
    const schedulesTimedOut = await rows('SELECT resource_key, job_id FROM metric_schedule ORDER BY resource_key');

    const proof: Record<string, { job_id: string; fencing_token: number; state: string; attempts: number;
      schedule_job_id: string | null; elapsed_ms: number; observations: number; attempts_rows: number;
      events: Array<{ code: string; duration_ms: number; uncertain: number; logical_reads: number }> }> = {};
    for (const key of ['instance:1', 'server:3']) {
      // 1. The deadline cancelled this attempt: not completed, the same row, no second job.
      const job = byResource[key];
      expect(String(job.id)).toBe(firstJobIds[key]);
      expect(String(job.state), `${key} must be cancelled, not completed`).not.toBe('completed');
      expect(['completed', 'dead_letter', 'cancelled']).not.toContain(String(job.state));
      expect(String(job.state)).toBe('retry');
      expect(Number(job.attempts)).toBe(1);
      expect(Number(job.fencing_token)).toBe(1);
      // 2. Nothing reached formal history; an existing cancellation event records the attempt.
      const observations = await observationCount(String(job.id), Number(job.fencing_token));
      expect(observations, `${key} formal observations`).toBe(0);
      const attempts = await attemptRows(String(job.id), Number(job.fencing_token));
      expect(attempts, `${key} stored attempts`).toBe(0);
      const events = (await eventsOf(String(job.id))).map(event => ({ code: String(event.code),
        duration_ms: Number(event.duration_ms), uncertain: Number(event.uncertain), logical_reads: Number(event.logical_reads) }));
      const cancelled = events.filter(event => ['cancellation_requested', 'cancelled_result_uncertain'].includes(event.code));
      expect(cancelled.length, `${key} cancellation events: ${JSON.stringify(events)}`).toBeGreaterThan(0);
      // The timeout must have hit a real read, not only the pre-read bookkeeping.
      expect(cancelled.some(event => event.logical_reads >= 1), `${key} timeout fired before any real read: ${JSON.stringify(events)}`).toBe(true);
      expect(events.map(event => event.code)).not.toContain('committed');
      expect(schedulesTimedOut.find(row => String(row.resource_key) === key)!.job_id).toBe(String(job.id));
      proof[key] = { job_id: String(job.id), fencing_token: Number(job.fencing_token), state: String(job.state),
        attempts: Number(job.attempts), schedule_job_id: String(schedulesTimedOut.find(row => String(row.resource_key) === key)!.job_id),
        elapsed_ms: elapsed[claims.indexOf(String(job.id))], observations, attempts_rows: attempts, events };
    }

    // 3. The job is still not completed/dead_letter/cancelled: an immediate tick enqueues nothing
    //    and the single job id stays on the schedule row.
    const tickAfterTimeout = await scheduler.tick();
    expect(tickAfterTimeout).toBe(0);
    const jobRowsAfterTick = await rows('SELECT id, state, attempts, fencing_token FROM workflow_jobs ORDER BY id');
    expect(jobRowsAfterTick).toHaveLength(2);
    expect(jobRowsAfterTick.map(job => String(job.id)).sort()).toEqual(Object.values(firstJobIds).sort());
    const proofByJobId = Object.fromEntries(Object.entries(proof).map(([key, job]) => [job.job_id, job]));
    for (const job of jobRowsAfterTick) {
      const known = proofByJobId[String(job.id)];
      expect(known, `unexpected job row ${String(job.id)}`).toBeTruthy();
      expect({ state: String(job.state), attempts: Number(job.attempts), fencing_token: Number(job.fencing_token) })
        .toEqual({ state: known.state, attempts: known.attempts, fencing_token: known.fencing_token });
    }
    const schedulesAfterTick = await rows('SELECT resource_key, job_id FROM metric_schedule ORDER BY resource_key');
    expect(schedulesAfterTick.map(row => ({ resource_key: String(row.resource_key), job_id: String(row.job_id) })))
      .toEqual(Object.keys(firstJobIds).sort().map(key => ({ resource_key: key, job_id: firstJobIds[key] })));
    const observationsAfterTick: Record<string, number> = {};
    for (const key of ['instance:1', 'server:3']) {
      const observations = await observationCount(proof[key].job_id, proof[key].fencing_token);
      expect(observations, `${key} observations after repeated tick`).toBe(0);
      observationsAfterTick[key] = observations;
    }

    // Only the disposable schema received jobs and schedule events; the source stays identical.
    const after = await liveSnapshot();
    expect(after).toEqual(before);
    evidence.readonly = { pre: before, post: after, unchanged: true };
    evidence.bindings = bindingFacts;
    evidence.schedule = { first: firstSchedules.map(row => ({ resource_key: String(row.resource_key), job_id: String(row.job_id),
      revision: Number(row.revision), next_due_ms: Number(row.next_due_ms) })) };
    evidence.attempts = { worker_lease_seconds: LEASE_SECONDS, timeout_ms: TIMEOUT_MS, outcomes, elapsed_ms: elapsed, claims,
      jobs: Object.entries(proof).map(([resource_key, job]) => ({ resource_key, ...job })) };
    evidence.post_timeout_retick = { tick_result: tickAfterTimeout, workflow_job_rows: jobRowsAfterTick.length,
      schedule_job_ids: schedulesAfterTick.map(row => ({ resource_key: String(row.resource_key), job_id: String(row.job_id) })),
      observations: observationsAfterTick };
    evidence.run = { branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), test: 'formal-timeout.mysql.test.ts',
      disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll` };
    evidence.targets = { instance: { id: 1, name: 'mysql3306', host: 'localhost', port: 3306 },
      server: { id: 3, host: '192.168.49.130', port: 22 } };
    writeFileSync(new URL('../../../../../docs/slide/development/MAX-238/formal-timeout-20261027.json', import.meta.url),
      JSON.stringify(evidence, null, 2) + '\n');
  }, 180000);
});
