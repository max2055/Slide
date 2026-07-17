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
  async claim(workerId: string, leaseSeconds: number): Promise<ClaimedJob | null> {
    const pool = this.pool();
    await pool.execute(
      `UPDATE workflow_jobs SET state = 'running', attempts = attempts + 1, lease_owner = ?,
       lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND), fencing_token = fencing_token + 1
       WHERE id = (SELECT id FROM (SELECT id FROM workflow_jobs
         WHERE state IN ('queued', 'retry') AND available_at <= NOW() AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
         ORDER BY available_at, created_at LIMIT 1) candidate)
       AND state IN ('queued', 'retry') AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`,
      [workerId, leaseSeconds],
    );
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
  constructor(private readonly store: WorkflowStore, readonly workerId: string, private readonly leaseSeconds = 30) {}
  async claim(): Promise<ClaimedJob | null> { return this.store.claim(this.workerId, this.leaseSeconds); }
  async heartbeat(job: ClaimedJob): Promise<boolean> { return this.store.heartbeat(job.id, this.workerId, job.fencingToken, this.leaseSeconds); }
  async runOnce(handler: (job: ClaimedJob) => Promise<void>, now = Date.now()): Promise<'idle' | WorkflowState> {
    const job = await this.claim();
    if (!job) return 'idle';
    try { await handler(job); return await this.store.complete(job.id, this.workerId, job.fencingToken) ? 'completed' : 'retry'; }
    catch (error) {
      const retryAt = job.attempts >= job.maxAttempts ? null : new Date(now + Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1)));
      await this.store.fail(job, this.workerId, error instanceof Error ? error : new Error(String(error)), retryAt);
      return retryAt ? 'retry' : 'dead_letter';
    }
  }
}
