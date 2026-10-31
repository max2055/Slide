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
import { MysqlScheduleStore } from './store.js';
import { MetricScheduler } from './service.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import { JobRegistry } from '../../workflows/job-registry.js';

/**
 * MAX-238 formal-trace package. Two existing read-only targets (instance 1 mysql3306 and
 * server 3 192.168.49.130:22) are collected by the existing MetricScheduler -> WorkerRuntime
 * path into a disposable schema on METRICS_TEST_MYSQL_PORT. Job identity is joined back to
 * observations with existing fields only: metric_schedule_events.job_id and
 * metric_observations.payload.source.attempt_id = `${job.id}:${fencingToken}:${collectorId}`.
 *
 * The source application database is read with SELECT only; credentials are decrypted from
 * the existing rows and re-encrypted into the disposable copy. The live binding, schedule,
 * observation and asset rows are never written.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const envFile = process.env.SLIDE_DEBUG_ENV_FILE;
const database = `max238_formal_trace_${process.pid}`;
const instanceRef = { type: 'instance' as const, id: 1 };
const serverRef = { type: 'server' as const, id: 3 };

describe.skipIf(!port || !envFile)('MAX-238 formal job traced to real observations', () => {
  let root: Pool, pool: Pool, source: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let scheduler: MetricScheduler, jobs: JobRegistry, worker: WorkerRuntime;
  let configured: Record<string, string>;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const evidence: Record<string, unknown> = {};
  const query = async (target: Pool, sql: string, values: unknown[] = []) =>
    (await target.query<RowDataPacket[]>(sql, values as never))[0];
  const rows = (sql: string, values: unknown[] = []) => query(pool, sql, values);

  /** Read-only snapshot of exactly the facts this package must not change on the source. */
  const liveSnapshot = async () => {
    const instances = await query(source, 'SELECT COUNT(*) AS n FROM database_instances');
    const servers = await query(source, 'SELECT COUNT(*) AS n FROM servers');
    const server3 = await query(source, 'SELECT id, collection_enabled FROM servers WHERE id = 3');
    const bindings = await query(source,
      "SELECT resource_key, JSON_EXTRACT(payload,'$.binding.revision') AS revision FROM metric_policy_bindings WHERE resource_key IN ('instance:1','server:3') ORDER BY resource_key");
    return {
      database_instances: Number(instances[0].n),
      servers: Number(servers[0].n),
      server3: { id: Number(server3[0]?.id ?? 0), collection_enabled: Number(server3[0]?.collection_enabled ?? -1) },
      bindings: bindings.map(row => ({ resource_key: String(row.resource_key), revision: Number(row.revision) })),
    };
  };

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
    // Pin the authorized targets before any copy or collection request.
    expect(instance).toMatchObject({ id: 1, name: 'mysql3306', port: 3306 });
    expect(server).toMatchObject({ id: 3, host: '192.168.49.130' });
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
    evidence.schedule = (await rows("SELECT resource_key, JSON_EXTRACT(payload,'$.binding.revision') AS revision, JSON_EXTRACT(payload,'$.binding.package.id') AS package_id FROM metric_policy_bindings ORDER BY resource_key"))
      .map(row => ({ resource_key: row.resource_key, revision: Number(row.revision), package_id: row.package_id }));

    scheduler = new MetricScheduler(new MysqlScheduleStore(pool, packages), packages, createAssetCollectorAccess(true));
    jobs = new JobRegistry();
    scheduler.register(jobs);
    worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as never), 'max238-formal-trace', 60);
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

  it('runs both scheduled jobs once and joins each job back to its committed observations', async () => {
    const before = await liveSnapshot();
    // The authorized source baseline this package must leave untouched.
    expect(before).toEqual({ database_instances: 5, servers: 1, server3: { id: 3, collection_enabled: 1 },
      bindings: [{ resource_key: 'instance:1', revision: 4 }, { resource_key: 'server:3', revision: 3 }] });
    // Compile + enqueue through the existing scheduler. The per-resource jitter is real,
    // so scan until both rows are due instead of rewriting the persisted schedule.
    let queued = await scheduler.tick();
    const deadline = Date.now() + 15000;
    while (queued < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      queued += await scheduler.tick();
    }
    expect(queued).toBe(2);

    const outcomes: string[] = [];
    for (let job = 0; job < 2; job++) outcomes.push(await worker.runOnce((claimed, context) => jobs.execute(claimed, context), Date.now()));
    expect(outcomes).toEqual(['completed', 'completed']);

    const traced = [];
    for (const ref of [instanceRef, serverRef]) {
      const resourceKey = `${ref.type}:${ref.id}`;
      const events = await rows('SELECT id, job_id, code, duration_ms, logical_reads FROM metric_schedule_events WHERE resource_key = ? ORDER BY id', [resourceKey]);
      const committed = events.filter(event => event.code === 'committed');
      expect(committed, `${resourceKey} committed event: ${JSON.stringify(events)}`).toHaveLength(1);
      const jobId = String(committed[0].job_id);
      expect(jobId).toBeTruthy();
      const [job] = await rows('SELECT id, state, attempts, max_attempts, fencing_token FROM workflow_jobs WHERE id = ?', [jobId]);
      expect(job?.state).toBe('completed');
      const fencingToken = Number(job.fencing_token);
      const attemptPrefix = `${jobId}:${fencingToken}:`;
      const attempts = await rows('SELECT id FROM metric_attempts WHERE id LIKE ? ORDER BY id', [`${attemptPrefix}%`]);
      expect(attempts.length, `${resourceKey} attempts for ${attemptPrefix}`).toBeGreaterThan(0);
      expect(attempts.every(attempt => String(attempt.id).startsWith(attemptPrefix))).toBe(true);
      const observations = await rows(`SELECT id, payload FROM metric_observations
        WHERE stage = 'normalized' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.source.attempt_id')) LIKE ? ORDER BY observed_at, id`, [`${attemptPrefix}%`]);
      expect(observations.length, `${resourceKey} observations for ${attemptPrefix}`).toBeGreaterThan(0);
      const samples = observations.map(row => {
        const observation = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        expect(observation.source.attempt_id.startsWith(attemptPrefix)).toBe(true);
        return { job_id: jobId, fencing_token: fencingToken, attempt_id: observation.source.attempt_id,
          operation_id: observation.source.collector_id, observation_id: observation.id,
          metric_id: observation.metric.id, semantic_version: observation.metric.semantic_version,
          dimensions: observation.dimensions, unit: observation.unit,
          encoding: observation.value?.encoding ?? null, value: observation.value?.value ?? null,
          quality: observation.quality.status, observed_at: observation.observed_at, config_revision: observation.versions.config_revision };
      });
      traced.push({ resource_key: resourceKey, events: events.map(event => ({ job_id: event.job_id, code: event.code,
        duration_ms: Number(event.duration_ms), logical_reads: Number(event.logical_reads) })),
        job: { id: jobId, state: job.state, attempts: Number(job.attempts), max_attempts: Number(job.max_attempts), fencing_token: fencingToken },
        attempt_ids: attempts.map(attempt => attempt.id), observations: samples });
    }

    // Only the disposable schema received observations; the source stays byte-identical.
    const after = await liveSnapshot();
    expect(after).toEqual(before);
    evidence.readonly = { pre: before, post: after, unchanged: true };
    evidence.trace = traced;
    evidence.run = { branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), test: 'formal-trace.mysql.test.ts',
      disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll` };
    evidence.targets = { instance: { id: 1, name: 'mysql3306', host: 'localhost', port: 3306 },
      server: { id: 3, host: '192.168.49.130', port: 22 } };
    writeFileSync(new URL('../../../../../docs/slide/development/MAX-238/formal-trace-20261027.json', import.meta.url),
      JSON.stringify(evidence, null, 2) + '\n');
  }, 180000);
});
