import type { Pool } from 'mysql2/promise';
import { dbConnection } from '../db-connection.js';
import { authorizeApprovedSqlExecution, type ApprovalExecutionGrant } from '../security/approval-execution-authorizer.js';

/** Control DB only. No in-memory fallback and no cross-database exactly-once claim. */
export class SqlExecutionIntentStore {
  constructor(private readonly getPool: () => Pool | null = () => dbConnection.getPool()) {}

  private pool(): Pool {
    const pool = this.getPool();
    if (!pool) throw new Error('SQL_INTENT_STORAGE_UNAVAILABLE');
    return pool;
  }

  async begin(command: { instanceId: number; sql: string; database?: string; userId?: string }, grant: ApprovalExecutionGrant): Promise<void> {
    const connection = await this.pool().getConnection();
    try {
      await connection.beginTransaction();
      // Lock the approval while revalidating and reserving the unique dispatch.
      const [rows] = await connection.execute<any[]>(
        'SELECT target_database FROM approval_requests WHERE id = ? FOR UPDATE', [grant.approvalRequestId]);
      if (!rows.length || (rows[0].target_database || '') !== (command.database || '') ||
          !await authorizeApprovedSqlExecution({ execute: (sql, values) => connection.execute(sql, values as (string | number | null)[]) }, grant, command)) {
        throw new Error('SQL_INTENT_APPROVAL_INVALID');
      }
      await connection.execute(
        `INSERT INTO sql_execution_intents
         (operation_id, approval_request_id, instance_id, target_database, sql_text, reviewer_id, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [grant.operationId, grant.approvalRequestId, command.instanceId, command.database || null,
          command.sql, grant.reviewerId, command.userId || String(grant.reviewerId)]);
      // A lost commit acknowledgement also prevents target dispatch. Recovery inspects the row.
      await connection.commit();
    } catch (error: any) {
      await connection.rollback().catch(() => undefined);
      if (error.code === 'ER_DUP_ENTRY') throw new Error('SQL_OPERATION_ALREADY_RECORDED_RECONCILE_DO_NOT_RETRY');
      throw error;
    } finally {
      connection.release();
    }
  }

  async finish(operationId: string, state: 'succeeded' | 'unknown', result: unknown): Promise<void> {
    const [updated] = await this.pool().execute<any>(
      `UPDATE sql_execution_intents SET state = ?, result_json = ? WHERE operation_id = ? AND state = 'unknown' AND reconciliation_json IS NULL`,
      [state, JSON.stringify(result), operationId]);
    if (updated.affectedRows !== 1) throw new Error('SQL_INTENT_RESULT_NOT_RECORDED');
  }

  async inspect(operationId: string): Promise<unknown> {
    const [rows] = await this.pool().execute<any[]>(
      'SELECT * FROM sql_execution_intents WHERE operation_id = ?', [operationId]);
    return rows[0] ?? null;
  }

  /** Operator must first stop/fence the executor and verify target DB evidence. Never dispatch SQL. */
  async reconcile(operationId: string, applied: boolean, operator: string, evidence: string): Promise<void> {
    if (!operator.trim() || !evidence.trim()) throw new Error('SQL_RECONCILIATION_EVIDENCE_REQUIRED');
    const [updated] = await this.pool().execute<any>(
      `UPDATE sql_execution_intents SET state = ?, reconciliation_json = ?
       WHERE operation_id = ? AND state = 'unknown' AND reconciliation_json IS NULL`,
      [applied ? 'reconciled_applied' : 'reconciled_not_applied', JSON.stringify({ operator, evidence }), operationId]);
    if (updated.affectedRows !== 1) throw new Error('SQL_INTENT_NOT_RECONCILABLE');
  }
}

export const sqlExecutionIntent = new SqlExecutionIntentStore();
