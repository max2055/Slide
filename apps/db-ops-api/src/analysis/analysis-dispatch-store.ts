import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { ActorContext } from '../auth/actor-context.js';
import type { ResourceRef } from '../resources/types.js';
import type { ClaimedJob, JobExecutionContext } from '../workflows/worker-runtime.js';
import { validateAnalysisEnvelope } from './analysis-envelope.js';

/** Immutable, secret-free input; callbacks and authorization are never supplied by the model. */
export interface AnalysisRequest {
  purpose: string;
  subject: ResourceRef;
  actor?: ActorContext;
  message: string;
  systemPrompt: string;
  evidenceVersion: string;
  configVersion: string;
  authorizationVersion: string;
  sessionKey?: string;
}
export interface AnalysisEnqueueInput {
  analysisType: string; cacheKey: string; triggerType: 'manual' | 'auto';
  request: AnalysisRequest; existingAnalysisId?: number; relatedId?: number;
  retryOf?: number; ttlMs?: number;
}
export interface OwnedAnalysis { analysisId: number; request: AnalysisRequest; job: ClaimedJob; context: JobExecutionContext; runtimeRunId: string }
export type AnalysisAcceptance = { analysisId: number; cached: boolean; status: 'pending' | 'running' | 'completed' | 'unknown'; success: boolean };
export const analysisHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;

export class AnalysisDispatchStore {
  constructor(private readonly poolProvider: () => Pool | null) {}
  private pool() { const pool = this.poolProvider(); if (!pool) throw new Error('ANALYSIS_STORE_UNAVAILABLE'); return pool; }
  async assertSchema(): Promise<void> {
    await this.pool().execute(`SELECT d.current_run_id, a.runtime_run_id FROM analysis_dispatches d
      LEFT JOIN analysis_dispatch_attempts a ON a.analysis_id = d.analysis_id LIMIT 0`);
    await this.pool().execute('SELECT scope_key FROM analysis_dispatch_keys LIMIT 0');
  }
  private async transaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool().getConnection();
    try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; }
    catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }

  async enqueue(input: AnalysisEnqueueInput): Promise<AnalysisAcceptance> {
    const { request } = input;
    if (!Number.isSafeInteger(request.subject.id) || request.subject.id <= 0
      || !['instance', 'server', 'network_device'].includes(request.subject.type)
      || JSON.stringify(request).length > 1_000_000) throw new Error('ANALYSIS_REQUEST_INVALID');
    // A pre-existing legacy row has no proof that it was never sent. All new
    // callers create their analysis in this transaction; legacy retry creates a new ID.
    if (input.existingAnalysisId !== undefined) throw new Error('ANALYSIS_LEGACY_BINDING_REQUIRES_CONFIRMATION');
    const scope = analysisHash([input.analysisType, request.subject, input.triggerType, request.actor?.userId ?? 'system', input.relatedId ?? null]);
    return this.transaction(async connection => {
      await connection.execute('INSERT INTO analysis_dispatch_keys (scope_key) VALUES (?) ON DUPLICATE KEY UPDATE scope_key = scope_key', [scope]);
      const [keys] = await connection.execute<any[]>('SELECT analysis_id FROM analysis_dispatch_keys WHERE scope_key = ? FOR UPDATE', [scope]);
      // Explicit operator reconciliation may adopt an automatic unknown into a
      // manual scope. It never grants access to another user's manual request.
      if (input.retryOf !== undefined && !keys[0]?.analysis_id) {
        const [predecessors] = await connection.execute<any[]>(`SELECT a.*, d.request_snapshot
          FROM ai_analysis a LEFT JOIN analysis_dispatches d ON d.analysis_id = a.id
          WHERE a.id = ? AND a.status = 'unknown' FOR UPDATE`, [input.retryOf]);
        const previous = predecessors[0];
        const previousRequest = previous?.request_snapshot ? parse<AnalysisRequest>(previous.request_snapshot) : null;
        const field = request.subject.type === 'instance' ? 'instance_id' : request.subject.type === 'server' ? 'server_id' : 'network_device_id';
        const sameActor = previousRequest ? previousRequest.actor?.userId === request.actor?.userId
          : previous?.cache_key?.includes(`:user:${request.actor?.userId ?? 0}:`);
        if (!previous || previous.analysis_type !== input.analysisType || Number(previous[field]) !== request.subject.id
          || Number(previous.related_id ?? 0) !== Number(input.relatedId ?? 0)
          || (!sameActor && previous.trigger_type !== 'auto' && (previousRequest || input.analysisType === 'fault_diagnosis'))) throw new Error('ANALYSIS_RETRY_SUPERSEDED');
        keys[0].analysis_id = input.retryOf;
        await connection.execute('UPDATE analysis_dispatch_keys SET analysis_id = ? WHERE scope_key = ?', [input.retryOf, scope]);
      }
      if (input.existingAnalysisId === undefined) {
        const pattern = request.purpose === 'fault_diagnosis'
          ? `fault:${request.subject.id}:%:${input.triggerType}:user:${request.actor?.userId ?? 0}:session:%`
          : `${input.cacheKey.slice(0, input.cacheKey.lastIndexOf(':') + 1)}%`;
        const field = request.subject.type === 'instance' ? 'instance_id' : request.subject.type === 'server' ? 'server_id' : 'network_device_id';
        const [legacy] = await connection.execute<any[]>(`SELECT a.id FROM ai_analysis a LEFT JOIN analysis_dispatches d ON d.analysis_id = a.id
          WHERE d.analysis_id IS NULL AND a.status = 'unknown' AND a.analysis_type = ? AND a.${field} = ?
          AND a.trigger_type = ? AND ((a.cache_key LIKE ? OR a.cache_key LIKE ?)
          OR (a.analysis_type IN ('topsql_analysis','alert_rca') AND a.related_id = ?)) ORDER BY a.id DESC LIMIT 1 FOR UPDATE`,
        [input.analysisType, request.subject.id, input.triggerType, pattern,
          input.analysisType === 'fault_diagnosis' && request.subject.type === 'instance'
            ? `fault:${request.subject.id}:%:${input.triggerType}:user:${request.actor?.userId ?? 0}:session:%` : pattern, input.relatedId ?? null]);
        if (legacy.length && !keys[0]?.analysis_id) {
          keys[0].analysis_id = Number(legacy[0].id);
          await connection.execute('UPDATE analysis_dispatch_keys SET analysis_id = ? WHERE scope_key = ?', [keys[0].analysis_id, scope]);
        }
        if (legacy.length && Number(keys[0]?.analysis_id) === Number(legacy[0].id) && input.retryOf !== Number(legacy[0].id)) {
          return { analysisId: Number(legacy[0].id), cached: false, success: false, status: 'unknown' };
        }
      }
      if (keys[0]?.analysis_id) {
        const row = await this.lock(connection, keys[0].analysis_id);
        if (row) {
          await this.reconcile(connection, row);
          if (row.status === 'unknown' && input.retryOf !== Number(row.analysis_id)) {
            return { analysisId: Number(row.analysis_id), cached: false, success: false, status: 'unknown' };
          }
          if (['pending', 'running'].includes(row.status) && ['queued', 'retry', 'running'].includes(row.job_state)) {
            // A queued durable intent is admission reuse, not an active-result cache.
            return { analysisId: Number(row.analysis_id), cached: false, success: true, status: row.status };
          }
          if (input.retryOf === undefined && row.status === 'completed'
            && row.evidence_version === request.evidenceVersion && row.config_version === request.configVersion
            && row.authorization_version === request.authorizationVersion
            && row.completed_at && Date.now() - new Date(row.completed_at).getTime() < (input.ttlMs ?? 1_800_000)) {
            return { analysisId: Number(row.analysis_id), cached: true, success: true, status: 'completed' };
          }
        }
      }
      if (input.retryOf !== undefined && Number(keys[0]?.analysis_id) !== input.retryOf) throw new Error('ANALYSIS_RETRY_SUPERSEDED');
      const [insert] = await connection.execute<any>(`INSERT INTO ai_analysis
        (analysis_type, target_type, instance_id, server_id, network_device_id, related_id, status, trigger_type, cache_key)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [input.analysisType, request.subject.type, request.subject.type === 'instance' ? request.subject.id : null,
        request.subject.type === 'server' ? request.subject.id : null, request.subject.type === 'network_device' ? request.subject.id : null,
        input.relatedId ?? null, input.triggerType, input.cacheKey]);
      const id = Number(insert.insertId);
      const jobId = randomUUID();
      const snapshot = { ...request, message: request.message.replaceAll('__ANALYSIS_ID__', String(id)), sessionKey: `${request.sessionKey ?? 'analysis'}-${id}` };
      const payload = JSON.stringify({ analysisId: id });
      const idempotencyKey = `analysis.dispatch:${id}`;
      await connection.execute(`INSERT INTO analysis_dispatches
        (analysis_id, job_id, request_snapshot, evidence_version, config_version, authorization_version, retry_of)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, jobId, JSON.stringify(snapshot), request.evidenceVersion, request.configVersion, request.authorizationVersion, input.retryOf ?? null]);
      await connection.execute(`INSERT INTO outbox_events
        (id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, payload, idempotency_key, published_at)
        VALUES (?, 'analysis.dispatch', 1, 'analysis', ?, 1, ?, ?, NOW())`, [randomUUID(), String(id), payload, idempotencyKey]);
      await connection.execute(`INSERT INTO workflow_jobs (id, job_type, schema_version, payload, idempotency_key)
        VALUES (?, 'analysis.dispatch', 1, ?, ?)`, [jobId, payload, idempotencyKey]);
      await connection.execute("UPDATE ai_analysis SET status = 'pending', session_key = ?, started_at = NULL WHERE id = ?", [snapshot.sessionKey, id]);
      await connection.execute('UPDATE analysis_dispatch_keys SET analysis_id = ? WHERE scope_key = ?', [id, scope]);
      return { analysisId: id, cached: false, success: true, status: 'pending' };
    });
  }

  private async lock(connection: PoolConnection, id: number) {
    const [rows] = await connection.execute<any[]>(`SELECT d.*, a.status, a.completed_at, j.state AS job_state,
      j.lease_owner, j.fencing_token AS job_fence, j.attempts AS job_attempts, j.lease_expires_at > NOW() AS live_lease
      FROM analysis_dispatches d JOIN ai_analysis a ON a.id = d.analysis_id JOIN workflow_jobs j ON j.id = d.job_id
      WHERE d.analysis_id = ? FOR UPDATE`, [id]);
    return rows[0] ?? null;
  }
  private async reconcile(connection: PoolConnection, row: any) {
    if (!['pending', 'running'].includes(row.status)) return;
    const lost = !row.live_lease || row.job_state !== 'running' || row.owner_id !== row.lease_owner
      || Number(row.fencing_token) !== Number(row.job_fence) || Number(row.attempt_number) !== Number(row.job_attempts);
    if (['sending', 'responded'].includes(row.request_state) && lost) {
      await this.terminal(connection, Number(row.analysis_id), 'unknown', 'ANALYSIS_PROVIDER_RESULT_UNKNOWN');
      row.status = 'unknown'; row.request_state = 'unknown';
    } else if (row.request_state === 'unsent' && ['dead_letter', 'cancelled', 'completed'].includes(row.job_state)) {
      await this.terminal(connection, Number(row.analysis_id), 'failed', 'ANALYSIS_UNSENT_JOB_TERMINAL'); row.status = 'failed';
    } else if (row.request_state === 'unsent' && lost && row.status === 'running') {
      await connection.execute("UPDATE ai_analysis SET status = 'pending', recovery_reason = 'ANALYSIS_UNSENT_LEASE_EXPIRED' WHERE id = ?", [row.analysis_id]);
      row.status = 'pending';
    }
  }
  async claim(analysisId: number, job: ClaimedJob, context: JobExecutionContext): Promise<OwnedAnalysis | null> {
    context.signal.throwIfAborted();
    return this.transaction(async connection => {
      const row = await this.lock(connection, analysisId);
      if (!row || !['pending', 'running'].includes(row.status)) return null;
      await this.reconcile(connection, row);
      if (!['pending', 'running'].includes(row.status)) return null;
      await this.assertJob(connection, row.job_id, job, context);
      if (row.request_state !== 'unsent') throw new Error('ANALYSIS_ATTEMPT_ALREADY_SENDING');
      await connection.execute("UPDATE analysis_dispatch_attempts SET request_state = 'abandoned', finished_at = NOW() WHERE analysis_id = ? AND request_state = 'unsent'", [analysisId]);
      const runtimeRunId = randomUUID();
      await connection.execute(`UPDATE analysis_dispatches SET attempt_number = ?, owner_id = ?, fencing_token = ?, current_run_id = ? WHERE analysis_id = ?`, [job.attempts, context.workerId, job.fencingToken, runtimeRunId, analysisId]);
      await connection.execute(`INSERT INTO analysis_dispatch_attempts (analysis_id, attempt_number, job_id, owner_id, fencing_token, runtime_run_id)
        VALUES (?, ?, ?, ?, ?, ?)`, [analysisId, job.attempts, job.id, context.workerId, job.fencingToken, runtimeRunId]);
      await connection.execute("UPDATE ai_analysis SET status = 'running', started_at = NOW() WHERE id = ?", [analysisId]);
      await this.assertJob(connection, row.job_id, job, context);
      return { analysisId, request: parse<AnalysisRequest>(row.request_snapshot), job, context, runtimeRunId };
    });
  }
  private async assertJob(connection: PoolConnection, jobId: string, job: ClaimedJob, context: JobExecutionContext) {
    context.signal.throwIfAborted();
    const [rows] = await connection.execute<any[]>(`SELECT id FROM workflow_jobs WHERE id = ? AND id = ? AND state = 'running'
      AND lease_owner = ? AND fencing_token = ? AND attempts = ? AND lease_expires_at > NOW()`, [jobId, job.id, context.workerId, context.fencingToken, job.attempts]);
    if (rows.length !== 1 || job.fencingToken !== context.fencingToken) throw new Error('ANALYSIS_LEASE_LOST');
  }
  private async owned<T>(owned: OwnedAnalysis, work: (connection: PoolConnection, row: any) => Promise<T>) {
    return this.transaction(async connection => {
      const row = await this.lock(connection, owned.analysisId);
      if (!row || row.owner_id !== owned.context.workerId || Number(row.fencing_token) !== owned.context.fencingToken
        || Number(row.attempt_number) !== owned.job.attempts || row.current_run_id !== owned.runtimeRunId) throw new Error('ANALYSIS_LEASE_LOST');
      await this.assertJob(connection, row.job_id, owned.job, owned.context);
      const result = await work(connection, row);
      await this.assertJob(connection, row.job_id, owned.job, owned.context);
      return result;
    });
  }
  async beforeSend(owned: OwnedAnalysis): Promise<void> {
    await this.owned(owned, async (connection, row) => {
      if (!['pending', 'running'].includes(row.status) || !['unsent', 'sending'].includes(row.request_state)) throw new Error('ANALYSIS_ALREADY_TERMINAL');
      await this.state(connection, owned, 'sending');
    });
  }
  async responded(owned: OwnedAnalysis): Promise<void> {
    await this.owned(owned, async (connection, row) => {
      if (row.status === 'completed') return;
      if (row.request_state !== 'sending') throw new Error('ANALYSIS_ALREADY_TERMINAL');
      await this.state(connection, owned, 'responded');
    });
  }
  private async state(connection: PoolConnection, owned: OwnedAnalysis, state: string) {
    await connection.execute('UPDATE analysis_dispatches SET request_state = ? WHERE analysis_id = ?', [state, owned.analysisId]);
    await connection.execute(`UPDATE analysis_dispatch_attempts SET request_state = ?, finished_at = IF(? IN ('completed','failed','unknown'), NOW(), NULL)
      WHERE analysis_id = ? AND attempt_number = ?`, [state, state, owned.analysisId, owned.job.attempts]);
  }
  async completeEnvelope(owned: OwnedAnalysis, envelope: unknown): Promise<{ success: boolean; error?: string }> {
    const parsed = validateAnalysisEnvelope(envelope);
    if (!parsed.ok) return { success: false, error: 'ANALYSIS_ENVELOPE_INVALID' };
    if (parsed.value.subject.type !== owned.request.subject.type || parsed.value.subject.id !== owned.request.subject.id) return { success: false, error: 'ANALYSIS_SUBJECT_MISMATCH' };
    return this.owned(owned, async (connection, row) => {
      if (row.status === 'completed') return { success: true };
      if (row.status !== 'running' || !['sending', 'responded'].includes(row.request_state)) throw new Error('ANALYSIS_ALREADY_TERMINAL');
      await connection.execute(`UPDATE ai_analysis SET status = 'completed', result = ?, analysis_envelope = ?,
        envelope_backfill_status = 'parsed', completed_at = NOW(), error_message = NULL WHERE id = ?`,
      [JSON.stringify(parsed.value.displayMarkdown), JSON.stringify(parsed.value), owned.analysisId]);
      await this.state(connection, owned, 'completed');
      return { success: true };
    });
  }
  async fail(owned: OwnedAnalysis, reason: string, knownResponse = false, rejectUnsent = false): Promise<boolean> {
    return this.owned(owned, async (connection, row) => {
      if (!['pending', 'running'].includes(row.status)) return true;
      // Before sending, leave the durable intent retryable. After sending, no paid retry.
      if (row.request_state === 'unsent') {
        if (!rejectUnsent) return false;
        await this.terminal(connection, owned.analysisId, 'failed', reason); return true;
      }
      await this.terminal(connection, owned.analysisId, knownResponse ? 'failed' : 'unknown', reason);
      return true;
    });
  }
  private async terminal(connection: PoolConnection, id: number, status: 'failed' | 'unknown', reason: string) {
    await connection.execute('UPDATE analysis_dispatches SET request_state = ?, reason = ? WHERE analysis_id = ?', [status, reason.slice(0, 128), id]);
    await connection.execute(`UPDATE analysis_dispatch_attempts SET request_state = ?, finished_at = NOW()
      WHERE analysis_id = ? AND request_state IN ('unsent','sending','responded')`, [status, id]);
    await connection.execute('UPDATE ai_analysis SET status = ?, error_message = ?, recovery_reason = ?, completed_at = IF(? = \'failed\', NOW(), NULL) WHERE id = ?', [status, reason.slice(0, 128), reason.slice(0, 128), status, id]);
  }
  async recover(): Promise<void> {
    const [rows] = await this.pool().execute<any[]>(`SELECT d.analysis_id FROM analysis_dispatches d
      JOIN ai_analysis a ON a.id = d.analysis_id JOIN workflow_jobs j ON j.id = d.job_id
      WHERE a.status IN ('pending','running') AND
        ((d.request_state IN ('sending','responded') AND (j.state <> 'running' OR j.lease_expires_at IS NULL OR j.lease_expires_at <= NOW()
          OR d.owner_id IS NULL OR j.lease_owner IS NULL OR d.owner_id <> j.lease_owner
          OR d.fencing_token <> j.fencing_token OR d.attempt_number <> j.attempts))
        OR (d.request_state = 'unsent' AND j.state IN ('dead_letter','completed','cancelled')))
      ORDER BY d.updated_at LIMIT 100`);
    for (const row of rows) await this.transaction(async connection => { const locked = await this.lock(connection, Number(row.analysis_id)); if (locked) await this.reconcile(connection, locked); });
  }
  async recoverLegacy(): Promise<void> {
    // No absence of a session marker proves an old request was not sent. Preserve all results.
    await this.pool().execute(`UPDATE ai_analysis a LEFT JOIN analysis_dispatches d ON d.analysis_id = a.id
      SET a.legacy_status = a.status, a.status = 'unknown', a.recovery_reason = IF(a.result IS NULL, 'LEGACY_DISPATCH_UNCONFIRMED', 'LEGACY_RESULT_PRESENT'),
      a.error_message = '历史请求是否已发送无法确认；重试可能再次计费'
      WHERE d.analysis_id IS NULL AND a.status IN ('pending','running')`);
  }
}
