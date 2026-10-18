import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { WorkerLease } from '../../lifecycle/worker-lease.js';
import { MysqlWorkflowStore, type ClaimedJob } from '../../workflows/worker-runtime.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { assertSourceClock, assertSourceDeadline, sourceFailure, type SourcePackage } from './config.js';

export async function sourceDatabaseGuard(pool: Pool, config: SourcePackage) {
  assertSourceDeadline(config);
  const before = Date.now();
  const [rows] = await pool.query<RowDataPacket[]>('SELECT DATABASE() AS db, UTC_TIMESTAMP(3) AS utc, @@session.time_zone AS zone');
  assertSourceClock(before, Date.now(), new Date(rows[0].utc).getTime());
  if (rows[0].db !== config.database || rows[0].zone !== '+00:00') sourceFailure('DATABASE_IDENTITY');
}

/** Exact ID only. No queue scan, expired-running reclaim or retry. Reuses the
 * production durable row/fence and heartbeat/complete semantics. */
export async function claimSourceJob(pool: Pool, id: string, type: string, workerId: string): Promise<ClaimedJob> {
  // The existing queue uses second-precision DATETIME: mysql2 may round an
  // immediate millisecond timestamp up. Wait for that exact row, never change
  // availability or select another job to compensate.
  const [due] = await pool.execute<RowDataPacket[]>(`SELECT GREATEST(0,TIMESTAMPDIFF(MICROSECOND,UTC_TIMESTAMP(3),available_at)/1000) AS waitMs
    FROM workflow_jobs WHERE id=? AND job_type=? AND state='queued' AND attempts=0`, [id, type]);
  if (due.length === 1 && Number(due[0].waitMs) > 0 && Number(due[0].waitMs) <= 1000)
    await delay(Math.ceil(Number(due[0].waitMs)) + 2);
  const [updated] = await pool.execute<any>(`UPDATE workflow_jobs SET state='running', attempts=attempts+1,
    lease_owner=?, lease_expires_at=DATE_ADD(NOW(),INTERVAL 30 SECOND), fencing_token=fencing_token+1
    WHERE id=? AND job_type=? AND state='queued' AND attempts=0 AND available_at<=NOW(3)
    AND lease_expires_at IS NULL`, [workerId, id, type]);
  if (Number(updated.affectedRows) !== 1) sourceFailure('JOB_NOT_UNSENT');
  const [rows] = await pool.execute<RowDataPacket[]>(`SELECT id,job_type AS type,payload,attempts,max_attempts AS maxAttempts,
    fencing_token AS fencingToken FROM workflow_jobs WHERE id=? AND lease_owner=? AND state='running'`, [id, workerId]);
  if (rows.length !== 1) sourceFailure('CLAIM_UNKNOWN');
  return { ...rows[0], payload: typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload } as ClaimedJob;
}

/** One foreground, schema-exclusive operation. A durable intent survives
 * disconnect/crash. Existing IDs (including completed) never resend. */
export class SourceControl {
  // workflow_jobs.lease_owner is CHAR(36), so retain the production UUID wire format.
  readonly workerId = randomUUID();
  readonly signal: AbortSignal;
  private controller = new AbortController();
  private lease: WorkerLease;
  private lock?: PoolConnection;
  private intent?: ClaimedJob;
  private timer?: ReturnType<typeof setInterval>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private renewing?: Promise<void>;
  private active?: ClaimedJob;
  private queue: MysqlWorkflowStore;
  private lockName = '';
  constructor(readonly pool: Pool, readonly config: SourcePackage, readonly cancel?: AbortSignal) {
    this.signal = this.controller.signal;
    this.queue = new MysqlWorkflowStore(() => pool as never);
    this.lease = new WorkerLease(pool);
  }
  private onCancel = () => this.controller.abort(new Error('V23_SOURCE_CANCELLED'));
  async assertActive() {
    this.signal.throwIfAborted(); assertSourceDeadline(this.config);
    if (!this.lock) sourceFailure('LOCK_LOST');
    const [held] = await this.lock.query<RowDataPacket[]>('SELECT IS_USED_LOCK(?)=CONNECTION_ID() AS held', [this.lockName]);
    if (Number(held[0].held) !== 1) sourceFailure('LOCK_LOST');
    if (!await this.lease.renew()) sourceFailure('LEASE_LOST');
    for (const job of [this.intent, this.active]) if (job
      && !await this.queue.heartbeat(job.id, this.workerId, job.fencingToken, 30)) sourceFailure('JOB_LEASE_LOST');
    await sourceDatabaseGuard(this.pool, this.config);
    this.signal.throwIfAborted();
  }
  /** Lock and recheck the exact source authority on the content transaction.
   * Call again immediately before commit so time expiry rolls back its writes. */
  async assertCommitFence(connection: PoolConnection) {
    this.signal.throwIfAborted(); assertSourceDeadline(this.config);
    if (!this.lock || !this.intent || !this.active) sourceFailure('COMMIT_FENCE_LOST');
    const [held] = await connection.execute<RowDataPacket[]>('SELECT IS_USED_LOCK(?)=? AS held', [this.lockName, this.lock.threadId]);
    const [lease] = await connection.execute<RowDataPacket[]>(`SELECT owner_id,expires_at>NOW(3) AS live FROM worker_leases
      WHERE lease_name='slide-singleton-workers' FOR UPDATE`);
    if (Number(held[0].held) !== 1 || lease[0]?.owner_id !== this.lease.ownerId || Number(lease[0]?.live) !== 1)
      sourceFailure('COMMIT_FENCE_LOST');
    for (const job of [this.intent, this.active]) {
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT state,lease_owner,fencing_token,lease_expires_at>NOW(3) AS live
        FROM workflow_jobs WHERE id=? FOR UPDATE`, [job.id]);
      const row = rows[0];
      if (row?.state !== 'running' || row.lease_owner !== this.workerId || Number(row.fencing_token) !== job.fencingToken
        || Number(row.live) !== 1) sourceFailure('COMMIT_FENCE_LOST');
    }
    this.signal.throwIfAborted();
  }
  async open() {
    await sourceDatabaseGuard(this.pool, this.config);
    this.lock = await this.pool.getConnection();
    this.lockName = `v23-source:${this.config.database}`;
    const [rows] = await this.lock.execute<RowDataPacket[]>('SELECT GET_LOCK(?,0) AS held', [this.lockName]);
    if (Number(rows[0].held) !== 1) sourceFailure('LOCK_BUSY');
    if (!await this.lease.acquire()) sourceFailure('WORKER_LEASE_BUSY');
    // Never re-adopt active/unknown work from a previous package operation.
    const [pending] = await this.pool.execute<RowDataPacket[]>(`SELECT id FROM workflow_jobs
      WHERE state NOT IN ('completed','cancelled')
      AND NOT (?='investigate' AND job_type='investigation.execute' AND state='queued' AND attempts=0
        AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.investigationId'))=?
        AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.requestId'))=?) LIMIT 1`,
    [this.config.phase, this.config.investigationId ?? '', this.config.requestId ?? '']);
    if (pending.length) sourceFailure('PRIOR_WORK_REQUIRES_AUDIT');
    const [prior] = await this.pool.execute<RowDataPacket[]>('SELECT id FROM workflow_jobs WHERE idempotency_key=?', [`v23-source:${this.config.operationId}`]);
    if (prior.length) sourceFailure('OPERATION_ALREADY_RECORDED');
    const intentId = randomUUID();
    await this.queue.enqueue({ id: intentId, type: 'qualification.source', schemaVersion: 1,
      payload: { operationId: this.config.operationId, phase: this.config.phase },
      idempotencyKey: `v23-source:${this.config.operationId}`, maxAttempts: 1 });
    this.intent = await claimSourceJob(this.pool, intentId, 'qualification.source', this.workerId);
    this.cancel?.addEventListener('abort', this.onCancel, { once: true });
    if (this.cancel?.aborted) this.onCancel();
    this.deadlineTimer = setTimeout(() => this.controller.abort(new Error('V23_SOURCE_DEADLINE')),
      Date.parse(this.config.deadline) - Date.now());
    this.timer = setInterval(() => {
      if (this.renewing) return;
      this.renewing = this.assertActive().catch(() => this.controller.abort(new Error('V23_SOURCE_LEASE_LOST')))
        .finally(() => { this.renewing = undefined; });
    }, 5000);
    await this.assertActive();
  }
  async execute(id: string, type: 'metrics.collect' | 'investigation.execute', registry: JobRegistry,
    validate: (job: ClaimedJob) => void) {
    await this.assertActive();
    const job = await claimSourceJob(this.pool, id, type, this.workerId); this.active = job;
    try {
      validate(job); this.signal.throwIfAborted();
      await registry.execute(job, { signal: this.signal, workerId: this.workerId, fencingToken: job.fencingToken });
      await this.assertActive();
      if (!await this.queue.complete(job.id, this.workerId, job.fencingToken)) sourceFailure('COMPLETION_UNKNOWN');
    } catch {
      // Fail terminally; no automatic retry even if the transport might have sent.
      await this.queue.fail(job, this.workerId, new Error('V23_SOURCE_RESULT_UNCERTAIN'), null);
      sourceFailure('RESULT_UNCERTAIN');
    } finally { this.active = undefined; }
  }
  async close(success = false) {
    if (this.timer) clearInterval(this.timer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.cancel?.removeEventListener('abort', this.onCancel);
    await this.renewing;
    try {
      if (this.intent) {
        if (success && !this.signal.aborted) {
          if (!await this.queue.complete(this.intent.id, this.workerId, this.intent.fencingToken)) sourceFailure('INTENT_UNKNOWN');
        } else await this.queue.fail(this.intent, this.workerId, new Error('V23_SOURCE_REQUIRES_AUDIT'), null);
      }
    } finally {
      await this.lease.release();
      if (this.lock) {
        try { await this.lock.execute('SELECT RELEASE_LOCK(?)', [this.lockName]); this.lock.release(); }
        catch { this.lock.destroy(); }
        this.lock = undefined;
      }
    }
  }
}
