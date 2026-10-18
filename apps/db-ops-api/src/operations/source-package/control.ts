import { assertKnownPartial } from '../../investigations/continuation.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sourceIntentHash, verifySourceAudit, type SourceAuditInput } from './audit.js';
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
  constructor(readonly pool: Pool, readonly config: SourcePackage, readonly cancel?: AbortSignal, readonly audit?: SourceAuditInput) {
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
    const intentId = await this.recordIntent();
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
  /** The failure stays byte-for-byte unchanged. Audit consumption and the new
   * unsent intent commit together, under both schema lock and row locks. A crash
   * after commit leaves an unsent/running intent, never a reusable approval. */
  private async recordIntent() {
    const connection = this.lock!;
    await connection.beginTransaction();
    try {
      const receipt = this.audit ? verifySourceAudit(this.audit, this.config) : undefined;
      const [jobs] = await connection.query<RowDataPacket[]>('SELECT * FROM workflow_jobs ORDER BY id FOR UPDATE');
      if (jobs.some(j => j.idempotency_key === `v23-source:${this.config.operationId}`)) sourceFailure('OPERATION_ALREADY_RECORDED');
      const historical = new Map(jobs.filter(j => j.job_type === 'qualification.source.audit' && j.state === 'completed')
        .map(j => { const p = typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload;
          return [p.predecessorId, p.predecessorHash]; }));
      const continuation = receipt?.decision === 'known_partial_explicit_continuation' ? receipt : undefined;
      let partial: Awaited<ReturnType<typeof assertKnownPartial>> | undefined;
      if (continuation) {
        partial = await assertKnownPartial(connection as never, continuation.partial.investigationId, continuation.partial);
        if (sourceIntentHash(partial) !== continuation.partial.recordsHash || partial.job.id !== continuation.partial.executionJobId
          || sourceIntentHash(partial.job) !== continuation.partial.executionJobHash) sourceFailure('AUDIT_PARTIAL_BINDING');
      }
      const historicalExecutions = new Map(jobs.filter(j => j.job_type === 'qualification.source.audit' && j.state === 'completed')
        .flatMap(j => { const p = typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload;
          return p.receipt?.decision === 'known_partial_explicit_continuation' ? [[p.receipt.partial.executionJobId, p.receipt.partial.executionJobHash]] : []; }));
      for (const auditJob of jobs.filter(j => j.job_type === 'qualification.source.audit' && j.state === 'completed')) {
        const data = typeof auditJob.payload === 'string' ? JSON.parse(auditJob.payload) : auditJob.payload;
        if (data.receipt?.decision !== 'known_partial_explicit_continuation') continue;
        const previous = data.receipt.partial;
        if (this.config.investigationId !== previous.investigationId || !this.config.requestId) sourceFailure('CONTINUATION_BINDING');
        // A consumed technical audit does not prove HTTP admission happened.
        // A fresh signed audit may recover its exact failed continue only while
        // the same immutable partial still has no successor request. After
        // admission, every later phase must retain the exact accepted successor.
        const beforeAdmission = continuation && isDeepStrictEqual(previous, continuation.partial);
        const retained = await assertKnownPartial(connection as never, previous.investigationId, previous,
          beforeAdmission ? undefined : this.config.requestId);
        if (sourceIntentHash(retained) !== previous.recordsHash) sourceFailure('AUDIT_PARTIAL_BINDING');
      }
      if (this.config.phase === 'continue' && !continuation) sourceFailure('PARTIAL_AUDIT_REQUIRED');
      if (historicalExecutions.size && ['collect', 'investigate'].includes(this.config.phase)
        && (!this.config.investigationId || !this.config.requestId)) sourceFailure('CONTINUATION_BINDING');
      let used = false;
      for (const job of jobs) {
        if (['completed', 'cancelled'].includes(job.state)) continue;
        const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
        if (['collect', 'investigate'].includes(this.config.phase) && job.job_type === 'investigation.execute' && job.state === 'queued'
          && job.attempts === 0 && payload.investigationId === this.config.investigationId && payload.requestId === this.config.requestId) {
          if (historicalExecutions.size) {
            const [requests] = await connection.execute<RowDataPacket[]>('SELECT request_snapshot FROM investigation_requests WHERE id=? FOR UPDATE', [this.config.requestId]);
            const snapshot = typeof requests[0]?.request_snapshot === 'string' ? JSON.parse(requests[0].request_snapshot) : requests[0]?.request_snapshot;
            const matches = jobs.filter(j => j.job_type === 'qualification.source.audit' && j.state === 'completed')
              .some(j => { const p = typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload, previous = p.receipt?.partial;
                return previous?.investigationId === this.config.investigationId && snapshot?.continuationOf?.requestId === previous.requestId
                  && snapshot.continuationOf.runId === previous.runId && snapshot.continuationOf.resultVersion === previous.resultVersion; });
            if (!matches) sourceFailure('CONTINUATION_BINDING');
          }
          continue;
        }
        if (job.id === partial?.job.id) continue;
        if (job.job_type === 'investigation.execute' && job.state === 'dead_letter'
          && historicalExecutions.get(job.id) === sourceIntentHash(job)) continue;
        const terminal = job.job_type === 'qualification.source' && job.state === 'dead_letter' && job.attempts === 1
          && job.max_attempts === 1 && job.lease_owner === null && job.lease_expires_at === null
          && job.last_error === 'V23_SOURCE_REQUIRES_AUDIT' && (payload.phase === 'collect'
            || (['investigate', 'continue'].includes(payload.phase) && (continuation || historical.has(job.id))));
        const digest = sourceIntentHash(job);
        if (terminal && historical.get(job.id) === digest) continue;
        if (!receipt || used || !terminal || receipt.predecessor.intentId !== job.id
          || receipt.predecessor.operationId !== payload.operationId || receipt.predecessor.jobHash !== digest)
          sourceFailure('PRIOR_WORK_REQUIRES_AUDIT');
        used = true;
      }
      if (receipt) {
        const [identity] = await connection.query<RowDataPacket[]>('SELECT @@server_uuid AS uuid');
        if (identity[0]?.uuid !== receipt.successor.databaseServerUuid) sourceFailure('AUDIT_DATABASE_IDENTITY');
        if (!used || historical.has(receipt.predecessor.intentId)) sourceFailure('AUDIT_ALREADY_USED_OR_UNKNOWN');
        // This narrowly supported failure occurred before any collection or model
        // work. A signed assertion cannot override contradictory durable facts.
        if (!continuation && jobs.some(j => !['qualification.source', 'qualification.source.audit'].includes(j.job_type))) sourceFailure('AUDIT_EXECUTION_EXISTS');
        for (const table of continuation ? [] : ['metric_observations', 'metric_publications', 'investigations']) {
          const [rows] = await connection.query<RowDataPacket[]>(`SELECT 1 FROM ${table} LIMIT 1`);
          if (rows.length) sourceFailure('AUDIT_EXECUTION_EXISTS');
        }
      }
      const id = randomUUID(), queue = new MysqlWorkflowStore(() => connection as never);
      if (receipt) {
        // Unique predecessor idempotency key + unique review UUID enforce single
        // consumption even if another caller bypasses this process's mutex.
        await connection.execute(`INSERT INTO workflow_jobs
          (id,job_type,schema_version,payload,idempotency_key,state,attempts,max_attempts)
          VALUES (?,'qualification.source.audit',1,?,?,'completed',1,1)`,
        [receipt.reviewId, JSON.stringify({ predecessorId: receipt.predecessor.intentId,
          predecessorHash: receipt.predecessor.jobHash, successorIntentId: id, receipt,
          signedEnvelope: this.audit!.envelope.toString() }), `v23-source-audit:${receipt.predecessor.intentId}`]);
      }
      await queue.enqueue({ id, type: 'qualification.source', schemaVersion: 1,
        payload: { operationId: this.config.operationId, phase: this.config.phase },
        idempotencyKey: `v23-source:${this.config.operationId}`, maxAttempts: 1 });
      await connection.execute<RowDataPacket[]>(`SELECT lease_name FROM worker_leases
        WHERE lease_name='slide-singleton-workers' FOR UPDATE`);
      // NOW() on a locking SELECT is fixed before its row-lock wait. With the
      // lease row now locked, use a current read (not the transaction's older
      // repeatable-read snapshot) to sample UTC and authority afresh. Perform
      // all time/signature/cancellation checks after the final SQL response.
      const before = Date.now();
      const [guard] = await connection.execute<RowDataPacket[]>(`SELECT DATABASE() AS db, UTC_TIMESTAMP(3) AS utc,
        @@session.time_zone AS zone, IS_USED_LOCK(?)=? AS held, owner_id, expires_at FROM worker_leases
        WHERE lease_name='slide-singleton-workers' FOR UPDATE`, [this.lockName, connection.threadId]);
      const row = guard[0], now = Date.now(), dbNow = new Date(row?.utc).getTime();
      assertSourceClock(before, now, dbNow);
      if (row.db !== this.config.database || row.zone !== '+00:00') sourceFailure('DATABASE_IDENTITY');
      if (Number(row.held) !== 1) sourceFailure('LOCK_LOST');
      if (row.owner_id !== this.lease.ownerId || !(new Date(row.expires_at).getTime() > Math.max(now, dbNow))) sourceFailure('LEASE_LOST');
      assertSourceDeadline(this.config, dbNow);
      assertSourceDeadline(this.config);
      if (this.audit) verifySourceAudit(this.audit, this.config);
      this.signal.throwIfAborted(); this.cancel?.throwIfAborted();
      await connection.commit();
      return id;
    } catch (error) { await connection.rollback(); throw error; }
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
