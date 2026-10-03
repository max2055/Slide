import { createHash, randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { normalizeCronOutputSchema } from './cron-output-schema.js';
import { dbConnection } from '../db-connection.js';

export type CronRunStatus = 'queued' | 'running' | 'success' | 'partial' | 'failed' | 'unknown' | 'cancelled';
export interface CronCompletion { status: 'success' | 'failure' | 'partial'; summary: string; result?: Record<string, unknown>; details?: Record<string, unknown>; }
export interface CronRun {
  runId: string; jobId: number; triggeredBy: number | null; status: CronRunStatus;
  queuedAt: string; startedAt: string | null; runnerFinishedAt: string | null;
  completedAt: string | null; completion: CronCompletion | null; outputSchema: Record<string, unknown> | null;
  logId: number | null; errorCode: string | null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const json = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
export class CronRunStore {
  private pool() { const pool = dbConnection.getPool(); if (!pool) throw new Error('CRON_RUN_STORE_UNAVAILABLE'); return pool; }
  async enqueue(jobId: number, triggeredBy: number | null, key: string, params: unknown, outputSchema: Record<string, unknown> | null): Promise<CronRun> {
    if (!key || key.length > 200) throw new Error('CRON_IDEMPOTENCY_KEY_INVALID');
    const requestKey = hash([triggeredBy, jobId, key]);
    const requestHash = hash(params);
    const connection = await this.pool().getConnection();
    const runId = randomUUID();
    try {
      await connection.beginTransaction();
      await connection.execute(`INSERT INTO cron_runs (run_id, job_id, triggered_by, request_key, request_hash, output_schema)
        VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE run_id = run_id`,
      [runId, jobId, triggeredBy, requestKey, requestHash, outputSchema ? JSON.stringify(outputSchema) : null]);
      const [rows] = await connection.execute<any[]>('SELECT run_id, request_hash FROM cron_runs WHERE request_key = ? FOR UPDATE', [requestKey]);
      if (rows[0].request_hash !== requestHash) throw new Error('CRON_IDEMPOTENCY_CONFLICT');
      const id = rows[0].run_id;
      await connection.execute(`INSERT INTO workflow_jobs (id, job_type, schema_version, payload, idempotency_key, max_attempts)
        VALUES (?, 'cron.execute', 1, ?, ?, 1) ON DUPLICATE KEY UPDATE id = id`, [id, JSON.stringify({ runId: id }), `cron-run:${id}`]);
      await connection.commit();
      return (await this.get(id))!;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async get(runId: string): Promise<CronRun | null> {
    const [rows] = await this.pool().execute<any[]>(`SELECT run_id AS runId, job_id AS jobId, triggered_by AS triggeredBy, status,
      queued_at AS queuedAt, started_at AS startedAt, runner_finished_at AS runnerFinishedAt, completed_at AS completedAt,
      completion, output_schema AS outputSchema, log_id AS logId, error_code AS errorCode FROM cron_runs WHERE run_id = ?`, [runId]);
    return rows[0] ? { ...rows[0], completion: json(rows[0].completion), outputSchema: json(rows[0].outputSchema) } : null;
  }
  async findRequest(jobId: number, triggeredBy: number, key: string): Promise<CronRun | null> {
    const [rows] = await this.pool().execute<any[]>('SELECT run_id FROM cron_runs WHERE request_key = ?', [hash([triggeredBy, jobId, key])]);
    return rows[0] ? this.get(rows[0].run_id) : null;
  }
  async start(runId: string): Promise<boolean> {
    const [result] = await this.pool().execute<any>("UPDATE cron_runs SET status = 'running', started_at = NOW(3) WHERE run_id = ? AND status = 'queued'", [runId]);
    return result.affectedRows === 1;
  }
  async bindLog(runId: string, logId: number): Promise<void> {
    await this.pool().execute('UPDATE cron_runs SET log_id = ? WHERE run_id = ?', [logId, runId]);
    await this.pool().execute('UPDATE cron_job_logs SET run_id = ? WHERE id = ?', [runId, logId]);
  }
  async saveCompletion(runId: string, completion: CronCompletion): Promise<void> {
    const connection = await this.pool().getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<any[]>('SELECT status, completion_hash, output_schema FROM cron_runs WHERE run_id = ? FOR UPDATE', [runId]);
      const row = rows[0]; const digest = hash(completion);
      if (!row) throw new Error('CRON_RUN_NOT_FOUND');
      if (!['success', 'failure', 'partial'].includes(completion.status) || typeof completion.summary !== 'string' || !completion.summary.trim()) throw new Error('CRON_COMPLETION_INVALID');
      if (row.completion_hash) {
        if (row.completion_hash !== digest) throw new Error('CRON_COMPLETION_CONFLICT');
      } else {
        const schema = json(row.output_schema);
        if (schema) {
          const validate = new Ajv({ strict: false, allErrors: true }).compile(normalizeCronOutputSchema(schema));
          if (!validate(completion.result)) throw new Error('CRON_OUTPUT_SCHEMA_INVALID');
        }
        if (row.status !== 'running') throw new Error('CRON_RUN_NOT_RUNNING');
        await connection.execute(`UPDATE cron_runs SET completion = ?, completion_hash = ?, completed_at = NOW(3), status = ? WHERE run_id = ?`,
          [JSON.stringify(completion), digest, completion.status === 'failure' ? 'failed' : completion.status, runId]);
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async finish(runId: string, status: CronRunStatus, errorCode?: string): Promise<void> {
    // A runner result never overwrites a committed business completion.
    await this.pool().execute(`UPDATE cron_runs SET runner_finished_at = NOW(3),
      status = IF(completion_hash IS NULL, ?, status), error_code = ? WHERE run_id = ? AND started_at IS NOT NULL`, [status, errorCode ?? null, runId]);
  }
  async recover(): Promise<void> {
    // Preserve a live workflow owner's run. Only expired/unowned started runs
    // become unknown; queued intents survive and legacy logs need manual review.
    await this.pool().execute(`UPDATE cron_runs r LEFT JOIN workflow_jobs w ON BINARY w.id = BINARY r.run_id
      SET r.status = IF(r.completion_hash IS NULL, 'unknown', r.status),
      r.runner_finished_at = NOW(3), r.error_code = 'CRON_RESTART_INTERRUPTED'
      WHERE r.started_at IS NOT NULL AND r.runner_finished_at IS NULL
      AND (w.id IS NULL OR w.state <> 'running' OR w.lease_owner IS NULL OR w.lease_expires_at IS NULL OR w.lease_expires_at <= NOW())`);
    await this.pool().execute(`UPDATE cron_job_logs l JOIN cron_runs r ON r.run_id = l.run_id
      SET l.status = IF(r.status = 'failed', 'error', r.status), l.finished_at = r.runner_finished_at,
      l.structured_result = COALESCE(r.completion, l.structured_result), l.error_message = r.error_code
      WHERE l.status = 'running' AND r.runner_finished_at IS NOT NULL`);
  }
}
export const cronRunStore = new CronRunStore();
