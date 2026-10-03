import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { cpus, platform, release, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../apps/db-ops-api/src/workflows/worker-runtime.js';
import { qualifyBoundedQueue } from './assert-bounded-queue.js';
import { platformLogs } from '../../apps/db-ops-api/src/platform/structured-log-evidence-adapter.js';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 10,
  timezone: 'Z',
});

try {
  const key = `qualification-stability:${randomUUID()}`;
  const store = new MysqlWorkflowStore(() => pool as any);
  await Promise.all(Array.from({ length: 20 }, () => store.enqueue({
    id: randomUUID(), type: 'notification.deliver', schemaVersion: 1,
    payload: { alertId: 1, channelId: 1 }, idempotencyKey: key,
  })));
  const [rows] = await pool.query<Array<{ count: number }>>('SELECT COUNT(*) AS count FROM workflow_jobs WHERE idempotency_key = ?', [key]);
  if (Number(rows[0]?.count) !== 1) throw new Error(`expected one idempotent workflow job, got ${rows[0]?.count}`);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const claimed = await store.claim('33333333-3333-4333-8333-333333333333', 30);
  if (!claimed) throw new Error('stability job was not claimable');
  if (!await store.complete(claimed.id, '33333333-3333-4333-8333-333333333333', claimed.fencingToken)) throw new Error('stability job did not complete');
  console.log('stability invariant valid: concurrent idempotent enqueue produced one completed job');

  // Same-resource mixed load, no providers, no external sends, real ten-second timer.
  // --baseline allows this identical harness to run against the exact pre-change main.
  const baseline = process.argv.includes('--baseline');
  const worker = new WorkerRuntime(store, randomUUID());
  const jobs = ['report.schedule', 'notification.deliver', 'capacity.collect'].map(type => ({
    id: randomUUID(), type, schemaVersion: 1, payload: { instanceId: 1 },
    idempotencyKey: randomUUID(), availableAt: new Date(Date.now() - 1000),
  }));
  const enqueuedAt: Record<string, number> = {};
  const startedAt: Record<string, number> = {};
  const completed: string[] = [];
  let active = 0; let peakActive = 0;
  let started!: () => void;
  const reportStarted = new Promise<void>(resolve => { started = resolve; });
  const startCpu = process.cpuUsage(); const startMemory = process.memoryUsage(); const start = performance.now();
  const handler = async (job: { id: string; type: string }) => {
    startedAt[job.type] = Date.now();
    peakActive = Math.max(peakActive, ++active);
    try {
      if (job.type === 'report.schedule') {
        started();
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      completed.push(job.type);
    } finally { active--; }
  };
  await store.enqueue(jobs[0]);
  enqueuedAt[jobs[0].type] = Date.now();
  const report = worker.runOnce(handler);
  // If claim fails or returns idle, fail instead of waiting forever for the handler.
  await Promise.race([reportStarted, report.then(() => { throw new Error('slow report did not start'); })]);
  let before; let after;
  try {
    for (const job of jobs.slice(1)) {
      enqueuedAt[job.type] = Date.now();
      await store.enqueue(job);
    }
    if (!baseline) {
      before = await store.observeQueue();
      assert.equal(before.types.find(t => t.jobType === 'report.schedule')?.running, 1);
      for (const type of ['notification.deliver', 'capacity.collect']) {
        assert.equal(before.types.find(t => t.jobType === type)?.ready, 1);
      }
    }
    const deadline = Date.now() + 20000;
    while (completed.length < 3 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await worker.runOnce(handler);
    }
    assert.equal(await report, 'completed');
    assert.equal(completed.length, 3, 'all types eventually start; no starvation for this finite load');
    assert.equal(peakActive, 1, 'same-resource side effects must remain serial');
    for (const type of ['notification.deliver', 'capacity.collect']) {
      assert.ok(startedAt[type] - enqueuedAt[type] >= 9000, 'must reproduce slow-report blocking');
    }
    if (!baseline) {
      after = await store.observeQueue();
      assert.ok(jobs.every(j => !after!.types.some(t => t.jobType === j.type)));
      const groups = platformLogs.query({ component: 'queue' }).groups;
      for (const type of ['notification.deliver', 'capacity.collect']) {
        assert.ok(groups.some(g => g.jobType === type && g.eventType === 'job.wait' && (g.maxDurationMs ?? 0) >= 9000));
      }
      assert.ok(groups.some(g => g.jobType === 'report.schedule' && g.eventType === 'job.executed' && (g.maxDurationMs ?? 0) >= 9900));
    }
  } finally {
    // Always collect this run-owned handler and drain before releasing its database.
    await report;
    assert.equal(await worker.shutdown(), true);
  }
  console.log(JSON.stringify({
    scenario: 'MAX-120 slow-report serial mixed load', mode: baseline ? 'base-main' : 'observed',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    hardware: { platform: platform(), release: release(), cpu: cpus()[0]?.model,
      logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version },
    load: { reportMs: 10000, notificationJobs: 1, collectionJobs: 1, workerConcurrency: 1, pollMs: 1000,
      controlPoolLimit: 10, sharedInstanceId: 1, realModelCalls: 0 },
    waitMs: Object.fromEntries(jobs.map(j => [j.type, startedAt[j.type] - enqueuedAt[j.type]])),
    elapsedMs: Math.round(performance.now() - start), peakActive, completed,
    cpuMicroseconds: process.cpuUsage(startCpu), memoryBefore: startMemory, memoryAfter: process.memoryUsage(),
    before, after, candidateTarget: { fastStartMs: 2000, status: 'confirmed-isolated-experiment-not-production-SLA' },
  }));

  if (!baseline) {
    await qualifyBoundedQueue(pool);
    // Durable gauges distinguish ready work, scheduled retry, dead letter and expired running lease.
    const fixtureType = 'qualification.queue-gauges';
    const fixture = async (state: string, dueSeconds: number, leaseSeconds: number | null) => {
      const id = randomUUID();
      await pool.execute(`INSERT INTO workflow_jobs
        (id, job_type, schema_version, payload, idempotency_key, state, available_at, created_at, lease_expires_at)
        VALUES (?, ?, 1, '{}', ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND),
          DATE_SUB(NOW(), INTERVAL 20 SECOND), ${leaseSeconds === null ? 'NULL' : 'DATE_ADD(NOW(), INTERVAL ? SECOND)'})`,
      [id, fixtureType, id, state, dueSeconds, ...(leaseSeconds === null ? [] : [leaseSeconds])]);
      return id;
    };
    await fixture('queued', -10, null);
    await fixture('retry', 100, null);
    await fixture('dead_letter', -10, null);
    const expired = await fixture('running', -10, -5);
    const measured = (await store.observeQueue()).types.find(t => t.jobType === fixtureType)!;
    assert.deepEqual({ ...measured, oldestReadyWaitMs: 10000 }, {
      jobType: fixtureType, queued: 1, retry: 1, scheduled: 1, ready: 2, running: 1,
      deadLetter: 1, expiredLeases: 1, oldestReadyWaitMs: 10000,
    });
    assert.ok(measured.oldestReadyWaitMs! >= 10000 && measured.oldestReadyWaitMs! < 13000);
    assert.equal(await store.complete(expired, 'old-owner', 0), false);
    console.log('queue gauges valid: scheduled retry excluded, dead letter counted, expired lease ready, stale owner fenced');
  }
} finally {
  await pool.end();
}
