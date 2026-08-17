export type WorkflowState = 'queued' | 'running' | 'retry' | 'completed' | 'dead_letter' | 'cancelled';
export interface ClaimedJob { id: string; type: string; payload: Record<string, unknown>; attempts: number; maxAttempts: number; fencingToken: number; }
export interface WorkflowStore {
  claim(workerId: string, leaseSeconds: number): Promise<ClaimedJob | null>;
  heartbeat(jobId: string, workerId: string, fencingToken: number, leaseSeconds: number): Promise<boolean>;
  complete(jobId: string, workerId: string, fencingToken: number): Promise<boolean>;
  fail(job: ClaimedJob, workerId: string, error: Error, retryAt: Date | null): Promise<boolean>;
}
interface SqlPool { execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }
export type WorkflowJobInput = { id: string; type: string; schemaVersion: number; payload: Record<string, unknown>; idempotencyKey: string; maxAttempts?: number; availableAt?: Date };

export class MysqlWorkflowStore implements WorkflowStore {
  constructor(private readonly poolProvider: () => SqlPool | null) {}
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
       WHERE id = ? AND state = 'dead_letter'`, [jobId],
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
       FROM workflow_jobs WHERE state = 'dead_letter' AND job_type = 'notification.deliver'
       ORDER BY updated_at DESC LIMIT ${safeLimit}`,
    );
    return rows.map((row) => ({ ...row, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload }));
  }
  async claim(workerId: string, leaseSeconds: number): Promise<ClaimedJob | null> {
    const pool = this.pool();
    const [result] = await pool.execute<{ affectedRows: number }>(
      `UPDATE workflow_jobs SET state = 'running', attempts = attempts + 1, lease_owner = ?,
       lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND), fencing_token = fencing_token + 1
       WHERE id = (SELECT id FROM (SELECT id FROM workflow_jobs
         WHERE state IN ('queued', 'retry', 'running') AND available_at <= NOW() AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
         ORDER BY available_at, created_at LIMIT 1) candidate)
       AND state IN ('queued', 'retry', 'running') AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`,
      [workerId, leaseSeconds],
    );
    if (Number(result.affectedRows) !== 1) return null;
    const [rows] = await pool.execute<Array<any>>(
      `SELECT id, job_type AS type, payload, attempts, max_attempts AS maxAttempts, fencing_token AS fencingToken
       FROM workflow_jobs WHERE lease_owner = ? AND state = 'running' AND lease_expires_at > NOW()
       ORDER BY updated_at DESC LIMIT 1`, [workerId],
    );
    const row = rows[0];
    return row ? { id: row.id, type: row.type, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload, attempts: Number(row.attempts), maxAttempts: Number(row.maxAttempts), fencingToken: Number(row.fencingToken) } : null;
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
export class WorkerRuntime {
  private runInFlight = false;
  constructor(private readonly store: WorkflowStore, readonly workerId: string, private readonly leaseSeconds = 30) {}
  async claim(): Promise<ClaimedJob | null> { return this.store.claim(this.workerId, this.leaseSeconds); }
  async heartbeat(job: ClaimedJob): Promise<boolean> { return this.store.heartbeat(job.id, this.workerId, job.fencingToken, this.leaseSeconds); }
  async runOnce(handler: (job: ClaimedJob) => Promise<void>, now = Date.now()): Promise<'idle' | WorkflowState> {
    if (this.runInFlight) return 'running';
    this.runInFlight = true;
    try {
      const job = await this.claim();
      if (!job) return 'idle';

      let heartbeatStopped = false;
      let heartbeatInFlight: Promise<void> | null = null;
      let leaseLost = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      const heartbeatIntervalMs = Math.max(1, Math.floor(this.leaseSeconds * 1_000 / 3));
      const heartbeatTimeoutMs = Math.max(1, Math.floor(heartbeatIntervalMs / 2));
      const markLeaseLost = () => {
        if (leaseLost) return;
        leaseLost = true;
        heartbeatStopped = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        console.error(`[WorkerRuntime] WORKFLOW_LEASE_LOST:${job.id}`);
      };
      const heartbeat = () => {
        if (heartbeatStopped || heartbeatInFlight) return;
        let heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
        const heartbeatTimeout = new Promise<boolean>((resolve) => {
          heartbeatTimeoutTimer = setTimeout(() => resolve(false), heartbeatTimeoutMs);
          heartbeatTimeoutTimer.unref?.();
        });
        heartbeatInFlight = Promise.race([this.heartbeat(job), heartbeatTimeout])
          .then((renewed) => { if (!renewed) markLeaseLost(); })
          .catch(() => markLeaseLost())
          .finally(() => {
            if (heartbeatTimeoutTimer) clearTimeout(heartbeatTimeoutTimer);
            heartbeatInFlight = null;
          });
      };

      try {
        heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs);
        heartbeatTimer.unref?.();

        let handlerFailed = false;
        let handlerError: unknown;
        try {
          await handler(job);
        } catch (error) {
          handlerFailed = true;
          handlerError = error;
        }

        heartbeatStopped = true;
        clearInterval(heartbeatTimer);
        const pendingHeartbeat = heartbeatInFlight;
        if (pendingHeartbeat) await pendingHeartbeat;
        if (leaseLost) return 'retry';

        if (!handlerFailed) {
          return await this.store.complete(job.id, this.workerId, job.fencingToken) ? 'completed' : 'retry';
        }
        const retryAt = job.attempts >= job.maxAttempts ? null : new Date(now + Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1)));
        await this.store.fail(job, this.workerId, handlerError instanceof Error ? handlerError : new Error(String(handlerError)), retryAt);
        return retryAt ? 'retry' : 'dead_letter';
      } finally {
        heartbeatStopped = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
    } finally {
      this.runInFlight = false;
    }
  }
}
