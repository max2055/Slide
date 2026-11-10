import type { Pool, PoolConnection } from 'mysql2/promise';
import { dbConnection } from '../db-connection.js';
import { authorizeApprovedSqlExecution, type ApprovalExecutionGrant } from '../security/approval-execution-authorizer.js';

const RECEIPT_STATES = new Set(['rolled_back', 'not_executed']);

/** True only when information_schema already lists this exact ENUM member. */
export function sqlIntentEnumAccepts(columnType: string, state: string): boolean {
  const match = /^enum\((.*)\)$/i.exec(columnType.trim());
  if (!match) return false;
  const body = match[1];
  const members: string[] = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === ' ' || char === ',') { index += 1; continue; }
    if (char !== "'") return false;
    index += 1;
    let value = '';
    while (index < body.length) {
      if (body[index] === '\\' && index + 1 < body.length) {
        value += body[index + 1];
        index += 2;
        continue;
      }
      if (body[index] === "'") {
        if (body[index + 1] === "'") { value += "'"; index += 2; continue; }
        index += 1;
        break;
      }
      value += body[index];
      index += 1;
    }
    members.push(value);
  }
  return members.includes(state);
}

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

  async finish(operationId: string, state: 'succeeded' | 'unknown' | 'rolled_back' | 'not_executed', result: unknown): Promise<void> {
    const connection = await this.pool().getConnection();
    let started = false;
    try {
      // Reject an unsupported receipt before any UPDATE. A non-strict session
      // would otherwise store an empty ENUM and still report affectedRows = 1.
      if (RECEIPT_STATES.has(state) && !await this.receiptColumnAccepts(connection, state)) {
        throw new Error('SQL_INTENT_STATE_UNSUPPORTED');
      }
      await connection.beginTransaction();
      started = true;
      const [updated] = await connection.execute<any>(
        `UPDATE sql_execution_intents SET state = ?, result_json = ? WHERE operation_id = ? AND state = 'unknown' AND reconciliation_json IS NULL`,
        [state, JSON.stringify(result), operationId]);
      if (updated.affectedRows !== 1) throw new Error('SQL_INTENT_RESULT_NOT_RECORDED');
      if (RECEIPT_STATES.has(state)) {
        const [rows] = await connection.execute<any[]>(
          'SELECT state FROM sql_execution_intents WHERE operation_id = ?', [operationId]);
        if (rows[0]?.state !== state) throw new Error('SQL_INTENT_STATE_UNSUPPORTED');
      }
      await connection.commit();
      started = false;
    } catch (error) {
      if (started) await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  private async receiptColumnAccepts(connection: PoolConnection, state: string): Promise<boolean> {
    const [rows] = await connection.query<any[]>(
      `SELECT COLUMN_TYPE AS column_type
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sql_execution_intents' AND COLUMN_NAME = 'state'`);
    return sqlIntentEnumAccepts(String(rows[0]?.column_type ?? ''), state);
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
