import { platformLogs } from '../platform/structured-log-evidence-adapter.js';

export type WorkflowState = 'queued' | 'running' | 'retry' | 'completed' | 'dead_letter' | 'cancelled';
export interface ClaimedJob { id: string; type: string; payload: Record<string, unknown>; attempts: number; maxAttempts: number; fencingToken: number; queueWaitMs?: number; }
export interface QueueTypeObservation {
  jobType: string; queued: number; retry: number; scheduled: number; ready: number;
  running: number; deadLetter: number; expiredLeases: number; oldestReadyWaitMs: number | null;
}
export interface QueueObservation {
  schemaVersion: 1; generatedAt: string; persistence: 'mysql';
  quality: 'good' | 'degraded' | 'unknown'; types: QueueTypeObservation[]; gaps: string[];
}
export interface ClaimFilter { types: readonly string[]; exclude: boolean; }
export interface WorkflowStore {
  claim(workerId: string, leaseSeconds: number, filter?: ClaimFilter): Promise<ClaimedJob | null>;
  heartbeat(jobId: string, workerId: string, fencingToken: number, leaseSeconds: number): Promise<boolean>;
  complete(jobId: string, workerId: string, fencingToken: number): Promise<boolean>;
  fail(job: ClaimedJob, workerId: string, error: Error, retryAt: Date | null): Promise<boolean>;
}
interface SqlPool { execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }
export type WorkflowJobInput = { id: string; type: string; schemaVersion: number; payload: Record<string, unknown>; idempotencyKey: string; maxAttempts?: number; availableAt?: Date };

export class MysqlWorkflowStore implements WorkflowStore {
  constructor(private readonly poolProvider: () => SqlPool | null) {}
  /** Durable gauges, not throughput. Eligibility matches claim, including expired leases. */
  async observeQueue(): Promise<QueueObservation> {
    const eligible = "state IN ('queued', 'retry', 'running') AND available_at <= NOW() AND (lease_expires_at IS NULL OR lease_expires_at < NOW())"
      + (process.env.ANALYSIS_DISPATCH_ENABLED === 'false' ? " AND job_type <> 'analysis.dispatch'" : '');
    const [rows] = await this.pool().execute<Array<QueueTypeObservation>>(
      `SELECT job_type AS jobType,
        SUM(state = 'queued') AS queued, SUM(state = 'retry') AS retry,
        SUM(state IN ('queued', 'retry') AND available_at > NOW()) AS scheduled,
        SUM(${eligible}) AS ready, SUM(state = 'running') AS running,
        SUM(state = 'dead_letter') AS deadLetter,
        SUM(state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < NOW())) AS expiredLeases,
        MAX(CASE WHEN ${eligible} THEN GREATEST(0,
          TIMESTAMPDIFF(MICROSECOND, GREATEST(created_at, available_at), NOW(3)) / 1000) END) AS oldestReadyWaitMs
       FROM workflow_jobs WHERE state IN ('queued', 'retry', 'running', 'dead_letter')
       GROUP BY job_type ORDER BY job_type LIMIT 101`,
    );
    const count = (value: unknown) => Math.max(0, Number(value));
    const types = rows.slice(0, 100).map(row => ({
      jobType: row.jobType, queued: count(row.queued), retry: count(row.retry),
      scheduled: count(row.scheduled), ready: count(row.ready), running: count(row.running),
      deadLetter: count(row.deadLetter), expiredLeases: count(row.expiredLeases),
      oldestReadyWaitMs: row.oldestReadyWaitMs === null ? null : count(row.oldestReadyWaitMs),
    }));
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), persistence: 'mysql',
      quality: rows.length > 100 ? 'degraded' : 'good', types,
      gaps: rows.length > 100 ? ['QUEUE_TYPES_TRUNCATED'] : [] };
  }
  async enqueue(input: WorkflowJobInput): Promise<void> {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(input.type) || !input.idempotencyKey || JSON.stringify(input.payload).length > 64_000) throw new Error('WORKFLOW_JOB_INVALID');
    await this.pool().execute(
      `INSERT INTO workflow_jobs (id, job_type, schema_version, payload, idempotency_key, max_attempts, available_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [input.id, input.type, input.schemaVersion, JSON.stringify(input.payload), input.idempotencyKey, input.maxAttempts ?? 5, input.availableAt ?? new Date()],
    );
  }
  async replayDeadLetter(jobId: string): Promise<boolean> {
    const [result] = await this.pool().execute<{ affectedRows: number }>(
      `UPDATE workflow_jobs SET state = 'queued', attempts = 0, available_at = NOW(),
       lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
       WHERE id = ? AND state = 'dead_letter'
       AND job_type IN ('notification.deliver', 'report.notify')
       AND NOT EXISTS (SELECT 1 FROM notification_delivery_states d
         WHERE d.business_key = CONCAT(IF(workflow_jobs.job_type = 'notification.deliver', 'notification:', 'report:'),
           JSON_UNQUOTE(JSON_EXTRACT(workflow_jobs.payload, IF(workflow_jobs.job_type = 'notification.deliver', '$.alertId', '$.reportId'))),
           ':', JSON_UNQUOTE(JSON_EXTRACT(workflow_jobs.payload, '$.channelId')))
         AND d.state IN ('sending', 'unknown'))`, [jobId],
    );
    return Number(result.affectedRows) === 1;
  }
  async isDeadLetter(jobId: string): Promise<boolean> {
    const [rows] = await this.pool().execute<Array<{ id: string }>>(
      "SELECT id FROM workflow_jobs WHERE id = ? AND state = 'dead_letter' LIMIT 1", [jobId],
    );
    return rows.length === 1;
  }
  async listDeadLetters(limit = 50): Promise<Array<{ id: string; type: string; payload: Record<string, unknown>; attempts: number; lastError: string | null; createdAt: Date | string }>> {
    const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 50, 1), 200);
    const [rows] = await this.pool().execute<Array<any>>(
      `SELECT id, job_type AS type, payload, attempts, last_error AS lastError, created_at AS createdAt
       FROM workflow_jobs WHERE state = 'dead_letter' AND job_type IN ('notification.deliver', 'report.notify')
       ORDER BY updated_at DESC LIMIT ${safeLimit}`,
    );
    return rows.map((row) => ({ ...row, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload }));
  }
  async claim(workerId: string, leaseSeconds: number, filter?: ClaimFilter): Promise<ClaimedJob | null> {
    const pool = this.pool();
    const typeFilter = filter?.types.length ? `AND job_type ${filter.exclude ? 'NOT IN' : 'IN'} (${filter.types.map(() => '?').join(', ')})` : '';
    // A locking UPDATE over a queue scan acquires cross-lane gap locks and can
    // deadlock even when job types differ. Read an optimistic candidate, then
    // fence a primary-key-only update; a raced claimant simply returns idle.
    const [candidates] = await pool.execute<Array<{ id: string }>>(
      `SELECT id FROM workflow_jobs WHERE state IN ('queued', 'retry', 'running')
       AND available_at <= NOW() AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
       ${process.env.ANALYSIS_DISPATCH_ENABLED === 'false' ? "AND job_type <> 'analysis.dispatch'" : ''}
       ${typeFilter} ORDER BY available_at, created_at, id LIMIT 1`, [...(filter?.types ?? [])],
    );
    if (!candidates[0]) return null;
    const candidateId = candidates[0].id;
    const [result] = await pool.execute<{ affectedRows: number }>(
      `UPDATE workflow_jobs SET state = 'running', attempts = attempts + 1, lease_owner = ?,
       lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND), fencing_token = fencing_token + 1
       WHERE id = ? AND state IN ('queued', 'retry', 'running') AND available_at <= NOW()
       AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`,
      [workerId, leaseSeconds, candidateId],
    );
    if (Number(result.affectedRows) !== 1) return null;
    const [rows] = await pool.execute<Array<any>>(
      `SELECT id, job_type AS type, payload, attempts, max_attempts AS maxAttempts, fencing_token AS fencingToken,
         GREATEST(0, TIMESTAMPDIFF(MICROSECOND, GREATEST(created_at, available_at), NOW(3)) / 1000) AS queueWaitMs
       FROM workflow_jobs WHERE id = ? AND lease_owner = ? AND state = 'running' AND lease_expires_at > NOW()
       LIMIT 1`, [candidateId, workerId],
    );
    const row = rows[0];
    return row ? { id: row.id, type: row.type, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload, attempts: Number(row.attempts), maxAttempts: Number(row.maxAttempts), fencingToken: Number(row.fencingToken),
      ...(row.queueWaitMs !== undefined ? { queueWaitMs: Number(row.queueWaitMs) } : {}) } : null;
  }
  /** Unknown/global handlers deliberately exclude every other resource. Never trust an added instanceId. */
  async resourcesFor(job: ClaimedJob): Promise<string[]> {
    let rows: Array<{ instanceId: number | null; type?: string }> = [];
    if (job.type === 'report.occurrence') {
      [rows] = await this.pool().execute<typeof rows>(`SELECT JSON_UNQUOTE(JSON_EXTRACT(config_snapshot, '$.instance_id')) AS instanceId,
        JSON_UNQUOTE(JSON_EXTRACT(config_snapshot, '$.type')) AS type FROM report_schedule_occurrences
        WHERE config_id = ? AND occurrence_at = ? AND workflow_job_id = ?`,
        [job.payload.configId, new Date(String(job.payload.occurrenceAt)), job.id]);
      if (rows[0]?.type === 'server_health') return ['*'];
    } else if (job.type === 'notification.deliver' || job.type === 'report.notify') {
      const alert = job.type === 'notification.deliver';
      [rows] = await this.pool().execute<typeof rows>(`SELECT instance_id AS instanceId FROM ${alert ? 'alerts' : 'reports'} WHERE id = ?`,
        [alert ? job.payload.alertId : job.payload.reportId]);
    } else if (job.type === 'metrics.collect') {
      // The collector validates this exact resource against its durable schedule before any I/O.
      const resource = job.payload.resource as { type?: string; id?: number } | undefined;
      if (resource?.type === 'instance' && Number.isSafeInteger(resource.id) && resource.id! > 0) return [`instance:${resource.id}`];
    }
    const id = Number(rows[0]?.instanceId);
    return Number.isSafeInteger(id) && id > 0 ? [`instance:${id}`] : ['*'];
  }
  async heartbeat(jobId: string, workerId: string, fencingToken: number, leaseSeconds: number): Promise<boolean> {
    const [result] = await this.pool().execute<{ affectedRows: number }>(
      `UPDATE workflow_jobs SET lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
       WHERE id = ? AND state = 'running' AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW()`,
      [leaseSeconds, jobId, workerId, fencingToken],
    );
    return Number(result.affectedRows) === 1;
  }
  async complete(jobId: string, workerId: string, fencingToken: number): Promise<boolean> {
    const [result] = await this.pool().execute<{ affectedRows: number }>(
      `UPDATE workflow_jobs SET state = 'completed', completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND state = 'running' AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW()`, [jobId, workerId, fencingToken],
    );
    return Number(result.affectedRows) === 1;
  }
  async fail(job: ClaimedJob, workerId: string, error: Error, retryAt: Date | null): Promise<boolean> {
    const state = retryAt ? 'retry' : 'dead_letter';
    const [result] = await this.pool().execute<{ affectedRows: number }>(
      `UPDATE workflow_jobs SET state = ?, available_at = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND state = 'running' AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW()`,
      [state, retryAt ?? new Date(), error.message.slice(0, 4096), job.id, workerId, job.fencingToken],
    );
    return Number(result.affectedRows) === 1;
  }
  private pool(): SqlPool { const pool = this.poolProvider(); if (!pool) throw new Error('WORKFLOW_STORE_UNAVAILABLE'); return pool; }
}
export interface JobExecutionContext { readonly signal: AbortSignal; readonly workerId: string; readonly fencingToken: number; }

export class WorkerRuntime {
  private runInFlight = false;
  private stopped = false;
  private controller?: AbortController;
  private activeRun?: Promise<void>;
  private pendingRenewal?: Promise<void>;

  /** Bounded drain. A non-cooperative handler remains quarantined until it settles. */
  async shutdown(timeoutMs = 5_000): Promise<boolean> {
    this.stopped = true;
    this.controller?.abort(new Error('WORKFLOW_SHUTDOWN'));
    if (!this.activeRun && !this.pendingRenewal) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([this.activeRun, this.pendingRenewal]).then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  constructor(private readonly store: WorkflowStore, readonly workerId: string, private readonly leaseSeconds = 30) {}
  async claim(): Promise<ClaimedJob | null> { return this.store.claim(this.workerId, this.leaseSeconds); }
  async heartbeat(job: ClaimedJob): Promise<boolean> { return this.store.heartbeat(job.id, this.workerId, job.fencingToken, this.leaseSeconds); }
  async runOnce(handler: (job: ClaimedJob, context: JobExecutionContext) => Promise<void>, now = Date.now()): Promise<'idle' | WorkflowState> {
    if (this.stopped) return 'cancelled';
    if (this.runInFlight || this.pendingRenewal) return 'running';
    this.runInFlight = true;
    const controller = new AbortController();
    this.controller = controller;
    let release!: () => void;
    this.activeRun = new Promise<void>(resolve => { release = resolve; });
    try {
      const job = await this.claim();
      if (controller.signal.aborted) return 'cancelled';
      if (!job) return 'idle';
      const startedAt = performance.now();
      const durationMs = () => Math.max(0, performance.now() - startedAt);
      platformLogs.record({ component: 'queue', eventType: 'job.claimed', status: 'ok', correlationId: job.id, jobType: job.type });
      if (Number.isFinite(job.queueWaitMs) && job.queueWaitMs! >= 0) {
        platformLogs.record({ component: 'queue', eventType: 'job.wait', status: 'ok', correlationId: job.id, jobType: job.type, durationMs: job.queueWaitMs });
      }

      let heartbeatStopped = false;
      let heartbeatInFlight: Promise<void> | null = null;
      let leaseLost = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      const heartbeatIntervalMs = Math.max(1, Math.floor(this.leaseSeconds * 1_000 / 3));
      const heartbeatTimeoutMs = Math.max(1, Math.floor(heartbeatIntervalMs / 2));
      const markLeaseLost = () => {
        if (leaseLost) return;
        leaseLost = true;
        controller.abort(new Error('WORKFLOW_LEASE_LOST'));
        platformLogs.record({ component: 'queue', eventType: 'job.lease_lost', status: 'unknown', correlationId: job.id, jobType: job.type, errorCode: 'WORKFLOW_LEASE_LOST' });
        heartbeatStopped = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        console.error(`[WorkerRuntime] WORKFLOW_LEASE_LOST:${job.id}`);
      };
      const stopHeartbeat = () => {
        heartbeatStopped = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      };
      controller.signal.addEventListener('abort', stopHeartbeat, { once: true });
      const heartbeat = () => {
        if (heartbeatStopped || heartbeatInFlight) return;
        let heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let onAbort!: () => void;
        const cancelled = new Promise<boolean>(resolve => {
          onAbort = () => resolve(true);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const heartbeatTimeout = new Promise<boolean>((resolve) => {
          heartbeatTimeoutTimer = setTimeout(() => resolve(false), heartbeatTimeoutMs);
          heartbeatTimeoutTimer.unref?.();
        });
        const renewal = this.heartbeat(job);
        // The DB driver cannot cancel this request. Keep the runtime quarantined
        // after timeout until it settles, rather than accumulating pending queries.
        this.pendingRenewal = renewal.then(() => {}, () => {}).finally(() => { this.pendingRenewal = undefined; });
        heartbeatInFlight = Promise.race([renewal, heartbeatTimeout, cancelled])
          .then((renewed) => { if (!renewed && !controller.signal.aborted) markLeaseLost(); })
          .catch(() => { if (!controller.signal.aborted) markLeaseLost(); })
          .finally(() => {
            if (heartbeatTimeoutTimer) clearTimeout(heartbeatTimeoutTimer);
            controller.signal.removeEventListener('abort', onAbort);
            heartbeatInFlight = null;
          });
      };

      try {
        heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs);
        heartbeatTimer.unref?.();

        let handlerFailed = false;
        let handlerError: unknown;
        try {
          await handler(job, { signal: controller.signal, workerId: this.workerId, fencingToken: job.fencingToken });
        } catch (error) {
          handlerFailed = true;
          handlerError = error;
        }
        platformLogs.record({ component: 'queue', eventType: 'job.executed', status: controller.signal.aborted ? 'unknown' : handlerFailed ? 'failed' : 'ok',
          correlationId: job.id, jobType: job.type, durationMs: durationMs() });

        heartbeatStopped = true;
        clearInterval(heartbeatTimer);
        const pendingHeartbeat = heartbeatInFlight;
        if (pendingHeartbeat) await pendingHeartbeat;
        if (controller.signal.aborted) {
          if (!leaseLost) platformLogs.record({ component: 'queue', eventType: 'job.cancelled', status: 'unknown', correlationId: job.id, jobType: job.type });
          return leaseLost ? 'retry' : 'cancelled';
        }

        if (!handlerFailed) {
          const complete = await this.store.complete(job.id, this.workerId, job.fencingToken);
          platformLogs.record({ component: 'queue', eventType: complete ? 'job.completed' : 'job.lease_lost', status: complete ? 'ok' : 'unknown',
            correlationId: job.id, jobType: job.type, durationMs: durationMs(), errorCode: complete ? undefined : 'WORKFLOW_LEASE_LOST' });
          return complete ? 'completed' : 'retry';
        }
        const retryAt = job.attempts >= job.maxAttempts ? null : new Date(now + Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1)));
        const recorded = await this.store.fail(job, this.workerId, handlerError instanceof Error ? handlerError : new Error(String(handlerError)), retryAt);
        platformLogs.record({ component: 'queue', eventType: recorded ? retryAt ? 'job.retry' : 'job.dead_letter' : 'job.lease_lost', status: recorded ? 'failed' : 'unknown',
          correlationId: job.id, jobType: job.type, durationMs: durationMs(), errorCode: recorded ? 'WORKFLOW_HANDLER_FAILED' : 'WORKFLOW_LEASE_LOST' });
        return !recorded || retryAt ? 'retry' : 'dead_letter';
      } finally {
        stopHeartbeat();
        controller.signal.removeEventListener('abort', stopHeartbeat);
      }
    } catch (error) {
      platformLogs.record({ component: 'queue', eventType: 'worker.error', status: 'failed', errorCode: 'WORKFLOW_STORE_OR_HANDLER_ERROR' });
      throw error;
    } finally {
      this.runInFlight = false;
      this.controller = undefined;
      this.activeRun = undefined;
      release();
    }
  }
}
