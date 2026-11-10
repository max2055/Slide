import type { Pool, PoolConnection } from 'mysql2/promise';
import { dbConnection } from '../db-connection.js';
import { cleanupDeadline, instanceAccessLifecycle, type InstanceAccessLifecycle } from './instance-access-lifecycle.js';

export type RemovalLifecycle = 'available' | 'deleting' | 'deleted';

/** Begin failed before commit. The local fence may be released. */
export class RemovalIntentUncommittedError extends Error {
  constructor(cause?: unknown) {
    super('INSTANCE_REMOVAL_INTENT_UNCOMMITTED', cause === undefined ? undefined : { cause });
    this.name = 'RemovalIntentUncommittedError';
  }
}

/** Commit was attempted and its outcome was not observed. Do not release the fence until a durable read. */
export class RemovalIntentUnknownError extends Error {
  constructor(cause?: unknown) {
    super('INSTANCE_REMOVAL_INTENT_UNKNOWN', cause === undefined ? undefined : { cause });
    this.name = 'RemovalIntentUnknownError';
  }
}

export interface RemovalStore {
  begin(id: number): Promise<'deleting' | 'deleted' | null>;
  observe(id: number): Promise<RemovalLifecycle | null>;
  detach(id: number): Promise<void>;
  record(id: number, reasons: string[]): Promise<void>;
  complete(id: number): Promise<void>;
}
export interface RemovalRuntime {
  stopTasks(id: number): Promise<void>;
  stopCollection(id: number): Promise<void>;
  closeConnections(id: number): Promise<void>;
}
export type RemovalResult = { success: boolean; state: 'deleting' | 'deleted'; statusCode?: 400 | 404 | 409 | 503; error?: string; reasons?: string[] };

/** Socket cleanup cannot be rolled back by SQL. Every phase is idempotent/retryable. */
export class InstanceRemovalService {
  private pending = new Map<number, Promise<RemovalResult>>();
  constructor(private store: RemovalStore, private access: InstanceAccessLifecycle,
    private runtime?: RemovalRuntime, private deadlineMs = 5000) {}
  configure(runtime: RemovalRuntime): void { this.runtime = runtime; }
  remove(id: number): Promise<RemovalResult> {
    if (!Number.isSafeInteger(id) || id <= 0) return Promise.resolve({ success: false, state: 'deleting', statusCode: 400, error: 'INVALID_INSTANCE_ID' });
    const existing = this.pending.get(id);
    if (existing) return existing;
    const pending = this.perform(id).finally(() => this.pending.delete(id));
    this.pending.set(id, pending);
    return pending;
  }
  private async perform(id: number): Promise<RemovalResult> {
    if (!this.runtime) return { success: false, state: 'deleting', statusCode: 503, error: 'INSTANCE_CLEANUP_UNAVAILABLE' };
    // Block new access before the first await, but do not abort in-flight work until intent is durable.
    const fence = this.access.hold(id);
    let state: 'deleting' | 'deleted' | null;
    try { state = await this.store.begin(id); }
    catch (error) { return this.recoverFailedIntent(id, fence, error); }
    if (!state) {
      this.access.forgetMissing(id, fence);
      return { success: false, state: 'deleting', statusCode: 404, error: 'INSTANCE_NOT_FOUND' };
    }
    this.access.revoke(id);
    if (state === 'deleted') return { success: true, state: 'deleted' };
    return this.finishRemoval(id);
  }

  private intentFailed(): RemovalResult {
    return { success: false, state: 'deleting', statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' };
  }

  private async recoverFailedIntent(id: number, fence: number, error: unknown): Promise<RemovalResult> {
    if (error instanceof RemovalIntentUnknownError) this.access.retainUnresolved(id, fence);
    // A known rollback of this attempt does not prove an older unknown commit finished.
    if (error instanceof RemovalIntentUncommittedError && !this.access.hasUnresolved(id)) {
      this.access.releaseIfCurrent(id, fence);
      return this.intentFailed();
    }
    if (!(error instanceof RemovalIntentUnknownError) && !(error instanceof RemovalIntentUncommittedError)) {
      return this.intentFailed();
    }
    const pending = this.access.unresolvedSnapshot(id);
    let observed: RemovalLifecycle | null;
    try { observed = await this.store.observe(id); }
    catch { return this.intentFailed(); }
    this.access.resolveVerified(id, pending);
    if (observed === 'deleted') {
      this.access.revoke(id);
      return { success: true, state: 'deleted' };
    }
    if (observed === 'deleting') {
      this.access.revoke(id);
      return this.finishRemoval(id);
    }
    // A newer unknown may have been retained while this read was in flight.
    if (this.access.hasUnresolved(id)) return this.intentFailed();
    this.access.releaseIfCurrent(id, fence);
    return this.intentFailed();
  }

  private async finishRemoval(id: number): Promise<RemovalResult> {
    const reasons: string[] = [];
    const attempt = async (code: string, action: () => Promise<void>) => {
      try { await cleanupDeadline(Promise.resolve().then(action), this.deadlineMs); }
      catch { reasons.push(code); }
    };
    await attempt('TASK_CLEANUP_PENDING', () => this.runtime!.stopTasks(id));
    await attempt('COLLECTION_CLEANUP_PENDING', () => this.runtime!.stopCollection(id));
    await attempt('TEMPORARY_CONNECTION_CLEANUP_PENDING', () => this.access.closeTemporary(id));
    await attempt('CONNECTION_CLEANUP_PENDING', () => this.runtime!.closeConnections(id));
    await attempt('INFLIGHT_CLEANUP_PENDING', () => this.access.drain(id));
    // A connector may have returned a handle after the first close pass.
    if (!reasons.length) {
      await attempt('TEMPORARY_CONNECTION_CLEANUP_PENDING', () => this.access.closeTemporary(id));
      await attempt('CONNECTION_CLEANUP_PENDING', () => this.runtime!.closeConnections(id));
    }
    await attempt('RELATION_CLEANUP_PENDING', () => this.store.detach(id));
    if (!reasons.length) await attempt('TOMBSTONE_COMMIT_FAILED', () => this.store.complete(id));
    if (reasons.length) {
      try {
        if (await this.store.observe(id) === 'deleted') return { success: true, state: 'deleted' };
      } catch { /* a failed read must not turn a pending cleanup into a false terminal state */ }
      try { await this.store.record(id, reasons); } catch { reasons.push('CLEANUP_RECORD_FAILED'); }
      return { success: false, state: 'deleting', statusCode: 409, error: 'INSTANCE_REMOVAL_PENDING', reasons };
    }
    return { success: true, state: 'deleted' };
  }
}

export class MysqlInstanceRemovalStore implements RemovalStore {
  constructor(private poolProvider: () => Pool | null = () => dbConnection.getPool()) {}
  private pool(): Pool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('INSTANCE_REMOVAL_STORE_UNAVAILABLE');
    return pool;
  }
  async begin(id: number): Promise<'deleting' | 'deleted' | null> {
    let connection: PoolConnection;
    try {
      connection = await this.pool().getConnection();
    } catch (error) {
      throw new RemovalIntentUncommittedError(error);
    }
    let isolate = false;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<any[]>('SELECT lifecycle_state FROM database_instances WHERE id = ? FOR UPDATE', [id]);
      if (!rows.length) {
        await connection.rollback();
        return null;
      }
      await connection.execute(`UPDATE database_instances SET lifecycle_state = 'deleting', status = 'inactive',
        removal_requested_at = COALESCE(removal_requested_at, NOW(6)) WHERE id = ? AND lifecycle_state <> 'deleted'`, [id]);
      try {
        await connection.commit();
      } catch (error) {
        isolate = true;
        throw new RemovalIntentUnknownError(error);
      }
      return rows[0].lifecycle_state === 'deleted' ? 'deleted' : 'deleting';
    } catch (error) {
      if (error instanceof RemovalIntentUnknownError) throw error;
      try {
        await connection.rollback();
      } catch (rollbackError) {
        // A failed ROLLBACK is not proof the write was undone. Destroy the session
        // so the server cannot implicitly commit it on the next START TRANSACTION.
        isolate = true;
        throw new RemovalIntentUnknownError(rollbackError);
      }
      throw new RemovalIntentUncommittedError(error);
    } finally {
      if (isolate) this.isolate(connection);
      else {
        try { connection.release(); } catch { this.isolate(connection); }
      }
    }
  }
  /** Close the socket and drop the pool slot. release() would keep the open transaction reusable. */
  private isolate(connection: PoolConnection): void {
    try { connection.destroy(); } catch { /* the slot is already detached or the socket is gone */ }
  }
  private async cleanConnection(): Promise<PoolConnection> {
    const pool = this.pool();
    for (let attempt = 0; attempt < 8; attempt++) {
      const connection = await pool.getConnection();
      try {
        const [rows] = await connection.query<any[]>(`SELECT
          (SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id = CONNECTION_ID()) AS innodb_pending,
          (SELECT c.state FROM performance_schema.events_transactions_current c
             JOIN performance_schema.threads t ON t.thread_id = c.thread_id
             WHERE t.processlist_id = CONNECTION_ID() LIMIT 1) AS tx_state`);
        const open = Number(rows?.[0]?.innodb_pending) > 0 || rows?.[0]?.tx_state === 'ACTIVE';
        if (!open) return connection;
      } catch (error) {
        this.isolate(connection);
        throw error;
      }
      this.isolate(connection);
    }
    throw new Error('INSTANCE_REMOVAL_OBSERVE_DIRTY');
  }
  async observe(id: number): Promise<RemovalLifecycle | null> {
    const connection = await this.cleanConnection();
    try {
      const [rows] = await connection.execute<any[]>('SELECT lifecycle_state FROM database_instances WHERE id = ?', [id]);
      if (!rows.length) return null;
      const state = rows[0].lifecycle_state;
      if (state === 'available' || state === 'deleting' || state === 'deleted') return state;
      throw new Error('INSTANCE_REMOVAL_STATE_UNKNOWN');
    } finally {
      try { connection.release(); } catch { this.isolate(connection); }
    }
  }
  async detach(id: number): Promise<void> {
    const c = await this.pool().getConnection();
    try {
      await c.beginTransaction();
      // Match explicit targets AND multi-instance Agent ceilings; never null the target.
      await c.execute(`UPDATE cron_jobs SET enabled = 0, next_run_at = NULL
        WHERE target_instance_id = ? OR JSON_CONTAINS(resource_scope, CAST(? AS JSON), '$.instanceIds')`, [id, String(id)]);
      await c.execute(`UPDATE cron_runs r JOIN cron_jobs j ON j.id = r.job_id
        SET r.status = 'cancelled', r.error_code = 'INSTANCE_REMOVED'
        WHERE r.status = 'queued' AND (j.target_instance_id = ?
          OR JSON_CONTAINS(j.resource_scope, CAST(? AS JSON), '$.instanceIds'))`, [id, String(id)]);
      await c.execute(`UPDATE workflow_jobs w JOIN cron_runs r ON BINARY r.run_id = BINARY w.id
        SET w.state = 'cancelled', w.last_error = 'INSTANCE_REMOVED'
        WHERE w.job_type = 'cron.execute' AND w.state IN ('queued','retry')
          AND r.status = 'cancelled' AND r.error_code = 'INSTANCE_REMOVED'`);
      await c.execute(`UPDATE workflow_jobs SET state = 'cancelled', last_error = 'INSTANCE_REMOVED'
        WHERE job_type = 'metrics.collect' AND state IN ('queued','retry')
          AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resource.type')) = 'instance'
          AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resource.id')) = ?`, [String(id)]);
      await c.execute('UPDATE report_configs SET enabled = 0 WHERE instance_id = ?', [id]);
      await c.execute(`UPDATE resource_relations SET valid_until = GREATEST(valid_from, NOW(6))
        WHERE ((source_type = 'instance' AND source_id = ?) OR (target_type = 'instance' AND target_id = ?))
          AND (valid_until IS NULL OR valid_until > NOW(6))`, [id, id]);
      await c.execute(`UPDATE resource_capabilities SET state = 'unsupported', reason = 'INSTANCE_REMOVED',
        valid_until = NOW(6) WHERE resource_type = 'instance' AND resource_id = ?`, [id]);
      await c.commit();
    } catch (error) { await c.rollback().catch(() => {}); throw error; }
    finally { c.release(); }
  }
  async record(id: number, reasons: string[]): Promise<void> {
    await this.pool().execute(
      `UPDATE database_instances SET removal_reasons = ? WHERE id = ? AND lifecycle_state = 'deleting'`,
      [JSON.stringify(reasons), id],
    );
  }
  async complete(id: number): Promise<void> {
    await this.pool().execute(`UPDATE database_instances SET lifecycle_state = 'deleted', status = 'inactive',
      removed_at = COALESCE(removed_at, NOW(6)), removal_reasons = NULL,
      password_encrypted = '', connection_string = NULL WHERE id = ?`, [id]);
  }
  async available(id: number): Promise<boolean> {
    const [rows] = await this.pool().execute<any[]>(`SELECT id FROM database_instances WHERE id = ? AND lifecycle_state = 'available'`, [id]);
    return rows.length === 1;
  }
  async pendingIds(): Promise<number[]> {
    const [rows] = await this.pool().execute<any[]>(`SELECT id FROM database_instances WHERE lifecycle_state = 'deleting' ORDER BY id`);
    return rows.map(row => Number(row.id));
  }
}
export const instanceRemovalStore = new MysqlInstanceRemovalStore();
export const instanceRemovalService = new InstanceRemovalService(instanceRemovalStore, instanceAccessLifecycle);
