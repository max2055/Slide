import { expect, it, vi } from 'vitest';
import { JobRegistry } from './job-registry.js';
import { createMetricRetentionJob, readMetricRetentionConfig, registerMetricRetentionHandler } from './metric-retention-handler.js';

const env = { METRICS_V2_RETENTION_ENABLED: 'true', METRICS_V2_RETENTION_RAW_MS: '1000',
  METRICS_V2_RETENTION_HISTORY_MS: '10000', METRICS_V2_RETENTION_ATTEMPT_MS: '5000' };
it('requires explicit validated durations and defaults to dry-run with bounded work', () => {
  expect(readMetricRetentionConfig({})).toBeNull();
  expect(() => readMetricRetentionConfig({ METRICS_V2_RETENTION_ENABLED: 'true' })).toThrow('RETENTION_CONFIG');
  expect(() => readMetricRetentionConfig({ ...env, METRICS_V2_RETENTION_RAW_MS: '10001' })).toThrow('RETENTION');
  expect(() => readMetricRetentionConfig({ ...env, METRICS_V2_RETENTION_MODE: 'delete' })).toThrow('RETENTION');
  expect(readMetricRetentionConfig(env)).toMatchObject({ mode: 'dry-run', limit: 1000, maxBatches: 5, maxRunMs: 10000 });
});
it('fixed jobs cannot supply policy or arbitrary cleanup capability', () => {
  expect(createMetricRetentionJob(new Date(1000))).toMatchObject({ type: 'metrics.retention', payload: {} });
});
it('registers a fixed handler, cooperates with cancellation and leaves recovery to durable workflow', async () => {
  const registry = new JobRegistry(); const run = vi.fn(async () => ({ reason: 'retention', batches: 0 }));
  registerMetricRetentionHandler(registry, run);
  const job = { ...createMetricRetentionJob(new Date(1000)), attempts: 1, maxAttempts: 5, fencingToken: 1 };
  const controller = new AbortController(); const context = { signal: controller.signal, workerId: 'test', fencingToken: 1 };
  await registry.execute(job, context); expect(run).toHaveBeenCalledWith(job, context);
  controller.abort(new Error('stopped'));
  await expect(registry.execute(job, context)).rejects.toThrow('stopped'); expect(run).toHaveBeenCalledTimes(1);
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { beforeAll, afterAll, beforeEach, describe } from 'vitest';
import { startMetricRetention } from './metric-retention-handler.js';
import { MysqlWorkflowStore, WorkerRuntime } from './worker-runtime.js';
import { MigrationRunner } from '../migrations/runner.js';
import type { MigrationPool } from '../migrations/types.js';
import { MysqlMetricStorage } from '../metrics-v2/storage.js';
import { RolloutControl } from '../metrics-v2/rollout/control.js';
import { definitions, rawObservation, observations, identify, timeoutAttempt } from '../contracts/metrics-v2/fixtures.js';

const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
describe.skipIf(!port)('production retention assembly through real MySQL workflow leases', () => {
  let root: Pool, pool: Pool; let now: Date;
  const database = `max117_${process.pid}`;
  let config: NodeJS.ProcessEnv;
  let store: MysqlWorkflowStore;
  const run = async (report = vi.fn(), workerId = 'retention-test') => {
    const registry = new JobRegistry();
    await startMetricRetention(pool, registry, job => store.enqueue(job), { env: config, clock: () => now, report });
    const worker = new WorkerRuntime(store, workerId);
    return { registry, worker, result: await worker.runOnce((job, ctx) => registry.execute(job, ctx)) };
  };
  const state = async () => (await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_retention_state WHERE id = 1'))[0][0];
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 12, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    await pool.query("INSERT INTO database_instances (id, name, db_type, host, port, username, password_encrypted) VALUES (1, 'isolated', 'mysql', 'localhost', 3306, 'fake', 'fake')");
  }, 120000);
  afterAll(async () => { await pool?.end(); if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); } });
  beforeEach(async () => {
    for (const table of ['workflow_jobs', 'metric_v2_alert_transitions', 'metric_v2_alert_state', 'alerts', 'metric_v2_rollout', 'metric_v2_publications', 'metric_v2_observations', 'metric_v2_attempts']) await pool.query(`DELETE FROM ${table}`);
    await pool.query('UPDATE metric_v2_retention_state SET preview_policy_hash = NULL, preview_at = NULL, last_report = NULL');
    now = new Date(Date.now() - 5000); config = { ...env }; store = new MysqlWorkflowStore(() => pool as any);
  });
  it('apply fails closed without a completed matching policy preview; default dry-run gives counts/time range without deletion', async () => {
    const storage = new MysqlMetricStorage(pool, () => new Date(now.getTime() - 20000), { rawMs: 1000, historyMs: 10000, attemptMs: 5000 });
    await storage.write(rawObservation, definitions[0]);
    config.METRICS_V2_RETENTION_MODE = 'apply';
    expect((await run()).result).toBe('retry');
    expect((await pool.query<RowDataPacket[]>('SELECT last_error FROM workflow_jobs WHERE state = \'retry\''))[0][0].last_error).toBe('RETENTION_DRY_RUN_REQUIRED');
    expect((await pool.query<RowDataPacket[]>('SELECT payload FROM metric_v2_observations'))[0][0].payload).not.toBeNull();
    config.METRICS_V2_RETENTION_MODE = 'dry-run';
    await pool.query("UPDATE workflow_jobs SET available_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE state = 'retry'");
    expect((await run()).result).toBe('completed');
    expect((await state()).last_report).toMatchObject({ mode: 'dry-run', batches: 0, preview: { rawPayload: { count: 1, oldestAgeMs: 20000 } } });
    expect((await state()).preview_policy_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await pool.query<RowDataPacket[]>('SELECT payload FROM metric_v2_observations'))[0][0].payload).not.toBeNull();
    config.METRICS_V2_RETENTION_HISTORY_MS = '11000'; config.METRICS_V2_RETENTION_MODE = 'apply'; now = new Date(now.getTime() + 1000);
    expect((await run()).result).toBe('retry');
  });
  it('expires sensitive raw payload despite current lineage, retains source tombstone/current alert, clears unreferenced history and terminal attempts across batches and restarts', async () => {
    const old = new MysqlMetricStorage(pool, () => new Date(now.getTime() - 20000), { rawMs: 1000, historyMs: 10000, attemptMs: 5000 });
    await old.write(rawObservation, definitions[0]);
    const current = identify({ ...observations[0], resource_id: '1', lineage: [{ id: rawObservation.id, stage: 'raw' as const }] });
    const rollout = new RolloutControl(pool, undefined, () => new Date(now.getTime() - 20000));
    const target = { source: 'v2', read: 'v2' as const, revision: 1, package: { id: 'fixture', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` } };
    const ticket = { source: 'v2', generation: 1, revision: 1 };
    await rollout.initialize(current, target); await rollout.applied(current, ticket); await rollout.publish(current, definitions[0], ticket);
    const input = { rule: 'current', ruleVersion: '1', observationId: current.id, windowEnd: Date.parse(current.observed_at), state: 'firing' as const, value: 3600, title: 'fixture', level: 'warning' as const };
    await rollout.transition(current, ticket, input);
    // A superseded transition can disappear; the watermark transition must remain.
    await pool.query("INSERT INTO metric_v2_alert_transitions SELECT REPEAT('b', 64), identity_hash, window_ms - 1000, 'healthy', evidence FROM metric_v2_alert_transitions");
    for (let i = 0; i < 3; i++) {
      const o = identify({ ...observations[0], resource_id: `unused-${i}` });
      await old.write(o, definitions[0]);
    }
    await old.writeAttempt(timeoutAttempt);
    const { ended_at: _end, ...running } = timeoutAttempt;
    await old.writeAttempt({ ...running, id: 'active-attempt', status: 'running', error: null });
    const fresh = new MysqlMetricStorage(pool, () => now, { rawMs: 1000, historyMs: 10000, attemptMs: 5000 });
    const freshRaw = identify({ ...rawObservation, resource_id: 'fresh' }); await fresh.write(freshRaw, definitions[0]);
    expect((await run()).result).toBe('completed');
    config.METRICS_V2_RETENTION_MODE = 'apply'; config.METRICS_V2_RETENTION_BATCH_LIMIT = '1'; config.METRICS_V2_RETENTION_MAX_BATCHES = '1';
    now = new Date(now.getTime() + 1000);
    expect((await run()).result).toBe('completed');
    expect((await state()).last_report).toMatchObject({ batches: 1, pending: true, counts: { rawPayload: 1 } });
    const expired = await fresh.evidence(rawObservation.id);
    expect(expired).toMatchObject({ status: 'expired', tombstone: { id: rawObservation.id, source: rawObservation.source, reason: 'raw_retention_expired' } });
    expect(JSON.stringify(expired)).not.toContain('raw_field'); expect(JSON.stringify(expired)).not.toContain('uint64');
    // New worker/registry after every run: no in-memory timer/cursor is required to continue.
    for (let i = 0; i < 8; i++) { now = new Date(now.getTime() + 1000); await run(vi.fn(), `restart-${i}`); }
    expect(await fresh.evidence(current.id)).toMatchObject({ status: 'available' });
    expect(await fresh.evidence(rawObservation.id)).toMatchObject({ status: 'expired' });
    expect(await fresh.attempt(timeoutAttempt.id)).toBeNull(); expect(await fresh.attempt('active-attempt')).toMatchObject({ status: 'running' });
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_alert_transitions'))[0]).toHaveLength(1);
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_publications'))[0]).toHaveLength(1);
    expect((await pool.query<RowDataPacket[]>("SELECT * FROM metric_v2_observations WHERE stage = 'normalized'"))[0]).toHaveLength(1);
    expect(await rollout.transition(current, ticket, input)).toBe(false);
  });
  it('an abandoned process lease is reclaimed, disabled jobs do nothing, and reenabling resumes durable cleanup', async () => {
    const old = new MysqlMetricStorage(pool, () => new Date(now.getTime() - 20000), { rawMs: 1000, historyMs: 10000, attemptMs: 5000 });
    await old.write(rawObservation, definitions[0]); await run();
    config.METRICS_V2_RETENTION_MODE = 'apply'; now = new Date(now.getTime() + 1000);
    const registry = new JobRegistry(); await startMetricRetention(pool, registry, j => store.enqueue(j), { env: config, clock: () => now, report: vi.fn() });
    const abandoned = await store.claim('exited-process', 30); expect(abandoned).not.toBeNull();
    await pool.query('UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [abandoned!.id]);
    config.METRICS_V2_RETENTION_ENABLED = 'false';
    expect((await run()).result).toBe('completed');
    expect((await pool.query<RowDataPacket[]>('SELECT payload FROM metric_v2_observations'))[0][0].payload).not.toBeNull();
    config.METRICS_V2_RETENTION_ENABLED = 'true'; now = new Date(now.getTime() + 1000);
    expect((await run()).result).toBe('completed');
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_observations'))[0]).toHaveLength(0);
  });
  it('recovers after an actual worker process exits after committed deletion but before workflow acknowledgement', async () => {
    const old = new MysqlMetricStorage(pool, () => new Date(now.getTime() - 20000), { rawMs: 1000, historyMs: 10000, attemptMs: 5000 });
    await old.write(rawObservation, definitions[0]); await run();
    config.METRICS_V2_RETENTION_MODE = 'apply'; now = new Date(now.getTime() + 1000);
    const script = `
      import mysql from 'mysql2/promise';
      import { JobRegistry } from './src/workflows/job-registry.ts';
      import { MysqlWorkflowStore, WorkerRuntime } from './src/workflows/worker-runtime.ts';
      import { startMetricRetention } from './src/workflows/metric-retention-handler.ts';
      const pool = mysql.createPool({host:'127.0.0.1', port:Number(process.env.METRICS_V2_TEST_MYSQL_PORT), user:'root', password:'', database:process.env.RETENTION_TEST_DATABASE, timezone:'Z', connectionLimit:12});
      const store = new MysqlWorkflowStore(() => pool), registry = new JobRegistry();
      await startMetricRetention(pool, registry, j => store.enqueue(j), {clock:() => new Date(process.env.RETENTION_TEST_NOW), report:() => process.exit(73)});
      await new WorkerRuntime(store, 'crashing-process').runOnce((job, ctx) => registry.execute(job, ctx));
      process.exit(74);
    `;
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      env: { PATH: process.env.PATH, ...config, METRICS_V2_TEST_MYSQL_PORT: String(port), RETENTION_TEST_DATABASE: database, RETENTION_TEST_NOW: now.toISOString() }, timeout: 20000,
    })).rejects.toMatchObject({ code: 73 });
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_observations'))[0]).toHaveLength(0);
    expect((await state()).last_report).toMatchObject({ mode: 'apply', counts: { rawPayload: 1, rawIdentity: 1 } });
    const [jobs] = await pool.query<RowDataPacket[]>("SELECT id, fencing_token FROM workflow_jobs WHERE state = 'running' AND lease_owner = 'crashing-process'");
    expect(jobs).toHaveLength(1);
    await pool.query('UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [jobs[0].id]);
    expect((await run()).result).toBe('completed');
    const [recovered] = await pool.query<RowDataPacket[]>('SELECT state, fencing_token FROM workflow_jobs WHERE id = ?', [jobs[0].id]);
    expect(recovered[0].state).toBe('completed'); expect(Number(recovered[0].fencing_token)).toBeGreaterThan(Number(jobs[0].fencing_token));
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_observations'))[0]).toHaveLength(0);
  });
  it('time admission budget stops further batches and creates a durable continuation without deletion', async () => {
    const old = new MysqlMetricStorage(pool, () => new Date(now.getTime() - 20000), { rawMs: 1000, historyMs: 10000, attemptMs: 5000 });
    await old.write(rawObservation, definitions[0]); await run();
    config.METRICS_V2_RETENTION_MODE = 'apply'; config.METRICS_V2_RETENTION_MAX_RUN_MS = '1'; now = new Date(now.getTime() + 1000);
    const preview = MysqlMetricStorage.prototype.preview;
    let expired = false; const actualTime = Date.now();
    const time = vi.spyOn(Date, 'now').mockImplementation(() => expired ? actualTime + 100 : actualTime);
    const spy = vi.spyOn(MysqlMetricStorage.prototype, 'preview').mockImplementation(async function () {
      const result = await preview.call(this); expired = true; return result;
    });
    try {
      expect((await run()).result).toBe('completed');
      expect((await state()).last_report).toMatchObject({ batches: 0, pending: true });
      expect((await pool.query<RowDataPacket[]>('SELECT payload FROM metric_v2_observations'))[0][0].payload).not.toBeNull();
      expect((await pool.query<RowDataPacket[]>("SELECT id FROM workflow_jobs WHERE state = 'queued'"))[0]).toHaveLength(2);
    } finally { time.mockRestore(); spy.mockRestore(); }
  });
  it('worker shutdown while waiting for the policy lock leaves payload intact and reclaims its lease on restart', async () => {
    const old = new MysqlMetricStorage(pool, () => new Date(now.getTime() - 20000), { rawMs: 1000, historyMs: 10000, attemptMs: 5000 });
    await old.write(rawObservation, definitions[0]); await run();
    config.METRICS_V2_RETENTION_MODE = 'apply'; now = new Date(now.getTime() + 1000);
    const registry = new JobRegistry(); await startMetricRetention(pool, registry, j => store.enqueue(j), { env: config, clock: () => now, report: vi.fn() });
    const blocker = await pool.getConnection(); await blocker.beginTransaction();
    await blocker.query('SELECT id FROM metric_v2_policy_lock WHERE id = 1 FOR UPDATE');
    let reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const worker = new WorkerRuntime(store, 'shutdown-worker');
    const preview = MysqlMetricStorage.prototype.preview;
    const spy = vi.spyOn(MysqlMetricStorage.prototype, 'preview').mockImplementation(async function () {
      reached(); return preview.call(this);
    });
    const pending = worker.runOnce((job, ctx) => registry.execute(job, ctx));
    try {
      await entered;
      expect(await worker.shutdown(1)).toBe(false);
    } finally { await blocker.commit(); blocker.release(); spy.mockRestore(); }
    expect(await pending).toBe('cancelled');
    expect((await pool.query<RowDataPacket[]>('SELECT payload FROM metric_v2_observations'))[0][0].payload).not.toBeNull();
    await pool.query("UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE state = 'running'");
    expect((await run()).result).toBe('completed');
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_observations'))[0]).toHaveLength(0);
  });
  it('shutdown/lease fencing aborts before deletion; retry never revives already expired raw payload', async () => {
    const old = new MysqlMetricStorage(pool, () => new Date(now.getTime() - 20000), { rawMs: 1000, historyMs: 10000, attemptMs: 5000 });
    await old.write(rawObservation, definitions[0]); await run();
    config.METRICS_V2_RETENTION_MODE = 'apply'; now = new Date(now.getTime() + 1000);
    const registry = new JobRegistry(); await startMetricRetention(pool, registry, j => store.enqueue(j), { env: config, clock: () => now, report: vi.fn() });
    const job = (await store.claim('stale-worker', 30))!;
    await pool.query('UPDATE workflow_jobs SET fencing_token = fencing_token + 1 WHERE id = ?', [job.id]);
    await expect(registry.execute(job, { signal: new AbortController().signal, workerId: 'stale-worker', fencingToken: job.fencingToken })).rejects.toThrow('WORKFLOW_LEASE_LOST');
    expect((await pool.query<RowDataPacket[]>('SELECT payload FROM metric_v2_observations'))[0][0].payload).not.toBeNull();
    await pool.query('UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [job.id]);
    expect((await run()).result).toBe('completed');
    expect(await new MysqlMetricStorage(pool, () => now).evidence(rawObservation.id)).toEqual({ status: 'not_retained' });
  });
});
