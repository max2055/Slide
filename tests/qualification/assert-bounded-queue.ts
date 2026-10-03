import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { BoundedWorkflowRuntime } from '../../apps/db-ops-api/src/workflows/bounded-worker.js';
import { MysqlWorkflowStore, type ClaimedJob, type JobExecutionContext } from '../../apps/db-ops-api/src/workflows/worker-runtime.js';
import type { Pool } from '../../apps/db-ops-api/node_modules/mysql2/promise.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const deadlineWait = async (condition: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await sleep(10);
  assert.ok(condition(), 'bounded condition did not become true');
};

/** Real queue/fencing/resource snapshots; handlers perform no external I/O. */
export async function qualifyBoundedQueue(pool: Pool) {
  const store = new MysqlWorkflowStore(() => pool as any);
  const runtime = (concurrency = 3, lease = 30) => new BoundedWorkflowRuntime(store, randomUUID(), concurrency, j => store.resourcesFor(j), lease);
  const [alertRow] = await pool.execute<any>("INSERT INTO alerts (instance_id, alert_type, level, title, message) VALUES (NULL, 'performance', 'warning', 'queue fixture', 'fake handler')");
  const alertId = Number(alertRow.insertId);
  // No external instance connections. This source is only consumed by a fake handler.
  let configId = 900000;
  const enqueue = async (type: string, resource: number) => {
    const id = randomUUID();
    let payload: Record<string, unknown>;
    if (type === 'report.occurrence') {
      const occurrenceAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000);
      payload = { configId: ++configId, occurrenceAt: occurrenceAt.toISOString() };
      await pool.execute(`INSERT INTO report_schedule_occurrences
        (config_id, occurrence_at, state, workflow_job_id, config_snapshot) VALUES (?, ?, 'queued', ?, ?)`,
        [configId, occurrenceAt, id, JSON.stringify({ type: 'health', instance_id: resource })]);
    } else if (type === 'notification.deliver') {
      await pool.execute('UPDATE alerts SET instance_id = ? WHERE id = ?', [resource, alertId]);
      payload = { alertId, channelId: 1 };
    } else payload = { resource: { type: 'instance', id: resource }, revision: 1 };
    if (type === 'report.occurrence') assert.deepEqual(await store.resourcesFor({ id, type, payload, attempts: 1, maxAttempts: 5, fencingToken: 1 }), [`instance:${resource}`]);
    await store.enqueue({ id, type, schemaVersion: 1, payload, idempotencyKey: id, availableAt: new Date(Date.now() - 1000) });
    return id;
  };

  const mixed = async (concurrency: number, sameResource: boolean) => {
    const worker = runtime(concurrency);
    const starts: Record<string, number> = {}; const enqueued: Record<string, number> = {};
    const completed: string[] = []; let active = 0; let peak = 0;
    const activeResources = new Set<number>(); let overlaps = 0;
    const cpu = process.cpuUsage(); const memory = process.memoryUsage(); const start = performance.now();
    const handler = async (j: ClaimedJob) => {
      starts[j.type] = Date.now();
      const resource = j.type === 'report.occurrence' ? 1 : sameResource ? 1 : j.type === 'notification.deliver' ? 2 : 3;
      if (activeResources.has(resource)) overlaps++;
      activeResources.add(resource); peak = Math.max(peak, ++active);
      try { if (j.type === 'report.occurrence') await sleep(10000); completed.push(j.id); }
      finally { active--; activeResources.delete(resource); }
    };
    const reportId = await enqueue('report.occurrence', 1);
    enqueued['report.occurrence'] = Date.now();
    const report = worker.runOnce(handler);
    const ticks: Array<Promise<unknown>> = [report];
    try {
      await deadlineWait(() => !!starts['report.occurrence']);
      for (const [type, resource] of [['notification.deliver', 2], ['metrics.collect', 3]] as const) {
        enqueued[type] = Date.now(); await enqueue(type, sameResource ? 1 : resource);
      }
      const end = Date.now() + 20000;
      while (completed.length < 3 && Date.now() < end) {
        await sleep(1000); ticks.push(worker.runOnce(handler));
      }
      await Promise.all(ticks);
      assert.equal(completed.length, 3);
      assert.equal(overlaps, 0, 'same-resource effects never overlap');
      const waitMs = Object.fromEntries(Object.keys(starts).map(t => [t, starts[t] - enqueued[t]]));
      for (const type of ['notification.deliver', 'metrics.collect']) {
        if (concurrency === 3 && !sameResource) assert.ok(waitMs[type] < 2000, `${type} must start within 2 seconds`);
        else assert.ok(waitMs[type] >= 9000, 'serial/same-resource must wait for slow report');
      }
      assert.ok(peak <= concurrency);
      const [rows] = await pool.query<any[]>('SELECT state, attempts FROM workflow_jobs WHERE id = ?', [reportId]);
      assert.equal(rows[0].state, 'completed'); assert.equal(rows[0].attempts, 1);
      console.log(JSON.stringify({ scenario: 'MAX-120 bounded mixed load', concurrency, sameResource, reportMs: 10000,
        poolLimit: 10, modelSlots: 1, pollMs: 1000, waitMs, peakActive: peak, overlaps, completed: completed.length,
        cpuMicroseconds: process.cpuUsage(cpu), memoryBefore: memory, memoryAfter: process.memoryUsage(),
        elapsedMs: Math.round(performance.now() - start), target: 'confirmed-isolated-experiment-not-production-SLA' }));
    } finally { await Promise.allSettled(ticks); assert.equal(await worker.shutdown(), true); }
  };
  await mixed(1, false);
  await mixed(3, false);
  await mixed(3, true);

  // Continued finite arrivals in every lane; no lane relies on another lane becoming idle.
  const worker = runtime(); const runs: Array<Promise<unknown>> = []; const completed = new Set<string>(); const ids: string[] = [];
  let active = 0; let peak = 0;
  try {
    for (let i = 0; i < 12; i++) {
      for (const type of ['report.occurrence', 'notification.deliver', 'metrics.collect']) ids.push(await enqueue(type, type === 'report.occurrence' ? 1 : type === 'notification.deliver' ? 2 : 3));
      runs.push(worker.runOnce(async j => { peak = Math.max(peak, ++active); try { await sleep(60); completed.add(j.id); } finally { active--; } }));
      await sleep(100);
    }
    const end = Date.now() + 5000;
    while (completed.size < ids.length && Date.now() < end) {
      runs.push(worker.runOnce(async j => { completed.add(j.id); })); await sleep(50);
    }
    await Promise.all(runs); assert.equal(completed.size, 36); assert.ok(peak <= 3);
    const [rows] = await pool.query<any[]>('SELECT MAX(attempts) AS attempts, SUM(state <> \'completed\') AS pending FROM workflow_jobs WHERE id IN (?)', [ids]);
    assert.equal(Number(rows[0].attempts), 1); assert.equal(Number(rows[0].pending), 0);
    console.log(JSON.stringify({ scenario: 'MAX-120 continued finite arrivals', arrivalsPerType: 12, intervalMs: 100, handlerMs: 60, completed: completed.size, peakActive: peak, attempts: 1 }));
  } finally { await Promise.allSettled(runs); assert.equal(await worker.shutdown(), true); }

  // Atomic claim race and stale owner fencing, including delayed retry/dead-letter transition.
  const id = await enqueue('metrics.collect', 3);
  const owners = Array.from({ length: 8 }, () => randomUUID());
  const contenders = await Promise.all(owners.map(owner => store.claim(owner, 30, { types: ['metrics.collect'], exclude: false })));
  const staleOwner = owners[contenders.findIndex(Boolean)];
  const claimed = contenders.filter(Boolean) as ClaimedJob[];
  assert.equal(claimed.length, 1); assert.equal(claimed[0].id, id);
  await pool.execute("UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?", [id]);
  const newOwner = randomUUID(); const replacement = (await store.claim(newOwner, 30, { types: ['metrics.collect'], exclude: false }))!;
  assert.equal(replacement.fencingToken, claimed[0].fencingToken + 1);
  assert.equal(await store.complete(id, staleOwner, claimed[0].fencingToken), false);
  assert.equal(await store.heartbeat(id, staleOwner, claimed[0].fencingToken, 30), false);
  assert.equal(await store.fail(claimed[0], staleOwner, new Error('fake'), null), false);
  assert.equal(await store.fail(replacement, newOwner, new Error('fake'), new Date(Date.now() + 60000)), true);
  assert.equal(await store.claim(randomUUID(), 30, { types: ['metrics.collect'], exclude: false }), null);
  await pool.execute("UPDATE workflow_jobs SET available_at = DATE_SUB(NOW(), INTERVAL 1 SECOND), attempts = max_attempts - 1 WHERE id = ?", [id]);
  const poison = runtime(); await poison.runOnce(async () => { throw new Error('fake failure'); }); await poison.shutdown();
  const [dead] = await pool.query<any[]>('SELECT state FROM workflow_jobs WHERE id = ?', [id]); assert.equal(dead[0].state, 'dead_letter');

  // Force a lease loss while the handler ignores AbortSignal. Same-resource work
  // waits behind it; shutdown aborts waiters but cannot release the unknown operation.
  const slow = runtime(3, 3); const slowId = await enqueue('report.occurrence', 1);
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const starts: string[] = []; let context: JobExecutionContext | undefined;
  const run = slow.runOnce(async (j, c) => { starts.push(j.type); context = c; await gate; });
  const safetyTicks: Array<Promise<unknown>> = [run];
  try {
    await deadlineWait(() => starts.length === 1);
    await enqueue('notification.deliver', 1);
    const waiting = slow.runOnce(async () => { throw new Error('same-resource overlap'); });
    // Collect the additional tick even when the forced loss fails.
    safetyTicks.push(waiting);
    await pool.execute('UPDATE workflow_jobs SET fencing_token = fencing_token + 1 WHERE id = ?', [slowId]);
    await deadlineWait(() => !!context?.signal.aborted, 2500);
    assert.deepEqual(starts, ['report.occurrence']);
    assert.equal(await slow.shutdown(30), false);
    for (let i = 0; i < 5; i++) assert.equal(await slow.runOnce(async () => { throw new Error('late execution'); }), 'cancelled');
    assert.equal(starts.length, 1);
    await waiting;
  } finally { release(); await Promise.allSettled(safetyTicks); assert.equal(await slow.shutdown(), true); }
  const [unknown] = await pool.query<any[]>('SELECT state FROM workflow_jobs WHERE id = ?', [slowId]); assert.equal(unknown[0].state, 'running');
  console.log('bounded safety valid: duplicate claim fenced; delayed retry/dead-letter; lease-loss handler retains resource/slot; shutdown waiters cancelled and unknown left for recovery');
}
