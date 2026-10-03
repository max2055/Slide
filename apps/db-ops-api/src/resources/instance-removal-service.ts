import type { Pool } from 'mysql2/promise';
import { dbConnection } from '../db-connection.js';
import { cleanupDeadline, instanceAccessLifecycle, type InstanceAccessLifecycle } from './instance-access-lifecycle.js';

export interface RemovalStore {
  begin(id: number): Promise<'deleting' | 'deleted' | null>;
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
    // Fence locally before the first await; durable intent commits before any socket cleanup.
    this.access.revoke(id);
    let state: 'deleting' | 'deleted' | null;
    try { state = await this.store.begin(id); }
    catch { return { success: false, state: 'deleting', statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' }; }
    if (!state) {
      this.access.forgetMissing(id);
      return { success: false, state: 'deleting', statusCode: 404, error: 'INSTANCE_NOT_FOUND' };
    }
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
    const c = await this.pool().getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.execute<any[]>('SELECT lifecycle_state FROM database_instances WHERE id = ? FOR UPDATE', [id]);
      if (!rows.length) { await c.rollback(); return null; }
      await c.execute(`UPDATE database_instances SET lifecycle_state = 'deleting', status = 'inactive',
        removal_requested_at = COALESCE(removal_requested_at, NOW(6)) WHERE id = ? AND lifecycle_state <> 'deleted'`, [id]);
      await c.commit();
      return rows[0].lifecycle_state === 'deleted' ? 'deleted' : 'deleting';
    } catch (error) { await c.rollback().catch(() => {}); throw error; }
    finally { c.release(); }
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
    await this.pool().execute('UPDATE database_instances SET removal_reasons = ? WHERE id = ?', [JSON.stringify(reasons), id]);
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
