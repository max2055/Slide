/**
 * SQL 执行服务
 * 安全执行 SQL 查询，支持 SELECT 直接执行、DDL/DML 走审批流
 */
import { sqlExecutionIntent } from './audit/sql-execution-intent.js';
import { databaseService } from './database-service';
import { auditLogManager } from './audit/audit-log';
import { classifySql } from './sql-validator.js';
import { dbConnection } from './db-connection.js';
import { authorizeApprovedSqlExecution, type ApprovalExecutionGrant } from './security/approval-execution-authorizer.js';
import { securityEventService } from './security/security-event-service.js';
import { withInstanceExecutionLock } from './instance-execution-lock.js';

const DEFAULT_SQL_TIMEOUT_MS = 15_000;
const MAX_SQL_TIMEOUT_MS = 30_000;
const MAX_SQL_ROWS = 1_000;

type DamengSession = {
  execute: (sql: string, binds?: unknown[], options?: { maxRows?: number; autoCommit?: boolean }) => Promise<any>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  close?: () => Promise<void>;
  // dmdb copies ConnectionAttributes.sessionTimeout onto each statement as queryTimeout.
  // The public attribute is integer seconds; 0 disables the server limit.
  conn_prop_sessionTimeout?: number;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function damengTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function quoteDamengIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function damengCell(result: any): string {
  const row = result?.rows?.[0];
  const value = Array.isArray(row) ? row[0] : row && Object.values(row)[0];
  if (typeof value !== 'string' || !value.trim()) throw new Error('DAMENG_SCHEMA_UNAVAILABLE');
  return value;
}

class SqlExecutor {
  private readonly retiredDamengSessions = new WeakSet<object>();

  private normalizeTimeout(timeoutMs?: number): number {
    if (!Number.isFinite(timeoutMs)) return DEFAULT_SQL_TIMEOUT_MS;
    return Math.max(100, Math.min(Math.trunc(timeoutMs!), MAX_SQL_TIMEOUT_MS));
  }

  private serializeForInstance<T>(instanceId: number, action: () => Promise<T>): Promise<T> {
    return withInstanceExecutionLock(instanceId, action);
  }

  private async acquireOwnedDameng(instanceId: number) {
    let conn = databaseService.getConnection(instanceId);
    if (conn?.dmConnection && this.retiredDamengSessions.has(conn.dmConnection)) {
      conn.connected = false;
      const replaced = await databaseService.reconnect(instanceId).catch(() => false);
      if (!replaced) throw new Error('实例未连接或重连失败');
    }
    const alive = await databaseService.ensureConnectionAlive(instanceId);
    if (!alive) throw new Error('实例未连接或重连失败');
    conn = databaseService.getConnection(instanceId);
    if (!conn?.dmConnection || conn.db_type !== 'dameng' || this.retiredDamengSessions.has(conn.dmConnection)) {
      throw new Error('实例未连接或重连失败');
    }
    return conn;
  }

  private async quarantineDamengSession(
    instanceId: number,
    dm: DamengSession,
    context: { userId?: string; username?: string; ipAddress?: string; approvalGrant?: ApprovalExecutionGrant } | undefined,
    sql: string,
    instanceName: string,
    detail: string,
  ): Promise<void> {
    this.retiredDamengSessions.add(dm);
    const current = databaseService.getConnection(instanceId);
    if (current?.dmConnection === dm) current.connected = false;
    try { await dm.close?.(); } catch { /* The session is already unusable. */ }
    let rebuilt = false;
    try { rebuilt = await databaseService.reconnect(instanceId); } catch { rebuilt = false; }
    const userId = context?.userId || (context?.approvalGrant ? String(context.approvalGrant.reviewerId) : '');
    if (!userId) return;
    await auditLogManager.logSqlExecution({
      userId,
      username: context?.username || 'unknown',
      instanceId,
      instanceName,
      dbType: 'dameng',
      sqlText: sql.substring(0, 500),
      durationMs: 0,
      status: 'error',
      errorMessage: `${detail} reconnect=${rebuilt ? 'ok' : 'failed'}`,
      ipAddress: context?.ipAddress,
      approvalRequestId: context?.approvalGrant?.approvalRequestId,
    }).catch(() => undefined);
  }

  /**
   * 执行 SQL 查询（仅 SELECT）
   */
  async executeSql(instanceId: number, sql: string, context?: {
    userId?: string; username?: string; ipAddress?: string; database?: string; timeoutMs?: number;
    approvalGrant?: ApprovalExecutionGrant;
  }): Promise<{
    success: boolean;
    columns?: string[];
    rows?: any[];
    rowCount?: number;
    truncated?: boolean;
    duration_ms?: number;
    error?: string;
    executionState?: 'succeeded' | 'unknown' | 'not_started';
    operationId?: string;
    retryable?: false;
  }> {
    const startTime = Date.now();
    let approvalAuthorized = false;

    const verifyApproval = async (): Promise<boolean> => {
      if (approvalAuthorized) return true;
      const pool = dbConnection.getPool();
      approvalAuthorized = Boolean(pool && context?.approvalGrant && await authorizeApprovedSqlExecution(
        pool as any,
        context.approvalGrant,
        { instanceId, sql },
      ));
      return approvalAuthorized;
    };

    // Classify SQL BEFORE connection check — reject non-read statements even
    // when the target instance is unreachable.
    const classification = classifySql(sql, 'mysql'); // db_type hint; re-classified after connection
    if (classification.commandType !== 'read') {
      if (
        classification.reasonCode === 'MULTI_STATEMENT' ||
        ['transaction', 'session', 'procedure'].includes(classification.commandType)
      ) {
        return {
          success: false,
          error: `SQL_STATEMENT_NOT_ALLOWED_${classification.reasonCode === 'UNCLASSIFIED'
            ? classification.commandType
            : classification.reasonCode}`,
        };
      }
      if (!await verifyApproval()) {
        await securityEventService.record({
          eventType: 'approval_execution_denied', reasonCode: classification.reasonCode,
          actorId: context?.approvalGrant?.reviewerId, resourceType: 'database-instance', resourceId: String(instanceId),
        }).catch(() => undefined);
        return { success: false, error: `SQL_APPROVAL_REQUIRED_${classification.reasonCode}` };
      }
    }

    // Approval above returns before any probe. Dameng shares one session, so its
    // probe, reconnect and the handle used for the statement stay inside the lock.
    const preview = databaseService.getConnection(instanceId);
    const damengOwned = preview?.db_type === 'dameng' && Boolean(preview.dmConnection);
    if (!damengOwned) {
      const alive = await databaseService.ensureConnectionAlive(instanceId);
      if (!alive) {
        return { success: false, error: '实例未连接或重连失败' };
      }
    }

    let conn = databaseService.getConnection(instanceId);
    if (!conn) {
      return { success: false, error: '实例未连接' };
    }

    // Re-classify with actual db_type for dialect-specific rules
    const reclassification = classifySql(sql, conn.db_type as 'mysql' | 'postgresql' | 'oracle' | 'dameng');
    if (reclassification.commandType !== 'read') {
      if (!['write', 'ddl'].includes(reclassification.commandType)) {
        return {
          success: false,
          error: `SQL_STATEMENT_NOT_ALLOWED_${reclassification.reasonCode === 'UNCLASSIFIED'
            ? reclassification.commandType
            : reclassification.reasonCode}`,
        };
      }
      if (!await verifyApproval()) {
        return { success: false, error: `SQL_APPROVAL_REQUIRED_${reclassification.reasonCode}` };
      }
    }

    const isMutation = reclassification.commandType !== 'read';
    const operationId = context?.approvalGrant?.operationId;
    let intentStarted = false;
    const rejectIntent = (error: { message?: string }) => ({
      success: false as const,
      executionState: error.message === 'SQL_OPERATION_ALREADY_RECORDED_RECONCILE_DO_NOT_RETRY' ? 'unknown' as const : 'not_started' as const,
      operationId,
      retryable: false as const,
      error: `SQL_INTENT_REJECTED: ${error.message}; inspect operation before any retry`,
    });
    const beginIntent = async () => {
      await sqlExecutionIntent.begin({ instanceId, sql, database: context?.database, userId: context?.userId }, context!.approvalGrant!);
      intentStarted = true;
    };
    if (isMutation && !damengOwned) {
      try {
        await beginIntent();
      } catch (error: any) {
        return rejectIntent(error);
      }
    }
    let targetAcknowledged = false;
    try {
      let result: any;
      const isReadOnly = reclassification.commandType === 'read';
      const timeoutMs = this.normalizeTimeout(context?.timeoutMs);

      if (conn.db_type === 'mysql' && conn.pool) {
        result = await this.serializeForInstance(instanceId, async () => {
          const connection = await conn.pool!.getConnection();
          let transactionStarted = false;
          try {
            // MySQL max_execution_time bounds SELECT only, not DML/DDL.
            if (isReadOnly) await connection.query(`SET SESSION max_execution_time = ${timeoutMs}`);
            if (isReadOnly) await connection.query(`SET SESSION sql_select_limit = ${MAX_SQL_ROWS + 1}`);
            if (context?.database) {
              const escapedDb = context.database.replace(/`/g, '``');
              await connection.query('USE `' + escapedDb + '`');
            }
            if (isReadOnly) {
              await connection.query('START TRANSACTION READ ONLY');
              transactionStarted = true;
            }
            const [rows, fields] = await connection.query(sql);
            if (transactionStarted) {
              await connection.query('COMMIT');
              transactionStarted = false;
            }
            return { rows, fields };
          } catch (error) {
            if (transactionStarted) await connection.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            if (isReadOnly) await connection.query('SET SESSION max_execution_time = 0').catch(() => undefined);
            if (isReadOnly) await connection.query('SET SESSION sql_select_limit = DEFAULT').catch(() => undefined);
            connection.release();
          }
        });
      } else if (conn.db_type === 'postgresql' && conn.pgClient) {
        result = await this.serializeForInstance(instanceId, async () => {
          let transactionStarted = false;
          try {
            await conn.pgClient!.query(isReadOnly ? 'BEGIN READ ONLY' : 'BEGIN');
            transactionStarted = true;
            await conn.pgClient!.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
            if (context?.database) {
              await conn.pgClient!.query('SET LOCAL search_path TO ' + conn.pgClient!.escapeIdentifier(context.database));
            }
            const cleanSql = sql.trim().replace(/;+\s*$/, '');
            const boundedSql = isReadOnly
              ? `SELECT * FROM (${cleanSql}) AS slide_read_limit LIMIT ${MAX_SQL_ROWS + 1}`
              : cleanSql;
            const pgResult = await conn.pgClient!.query(boundedSql);
            await conn.pgClient!.query('COMMIT');
            transactionStarted = false;
            return { rows: pgResult.rows, fields: pgResult.fields };
          } catch (error) {
            if (transactionStarted) await conn.pgClient!.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
        });
      } else if (conn.db_type === 'oracle' && conn.oracleConnection) {
        result = await this.serializeForInstance(instanceId, async () => {
          const fromPool = Boolean(conn.oraclePool);
          const oracleConnection = fromPool ? await conn.oraclePool.getConnection() : conn.oracleConnection!;
          const previousCallTimeout = oracleConnection.callTimeout;
          // DDL commits inside Oracle. DML does not: releasing a pooled connection
          // rolls the change back, so a write is succeeded only after commit().
          let readOnlyTransaction = false;
          try {
            oracleConnection.callTimeout = timeoutMs;
            if (isReadOnly) {
              await oracleConnection.execute('SET TRANSACTION READ ONLY', [], { autoCommit: false });
              readOnlyTransaction = true;
            }
            const oracleResult = await oracleConnection.execute(sql, [], {
              maxRows: isReadOnly ? MAX_SQL_ROWS + 1 : 0,
              autoCommit: false,
            });
            if (readOnlyTransaction) {
              await oracleConnection.rollback();
              readOnlyTransaction = false;
            } else if (reclassification.commandType === 'write') {
              await oracleConnection.commit();
            }
            const fields = oracleResult.metaData?.map((m: any) => ({ name: m.name })) || [];
            const rows = Array.isArray(oracleResult.rows) && oracleResult.rows.length > 0 && !Array.isArray(oracleResult.rows[0])
              ? oracleResult.rows
              : (oracleResult.rows || []).map((row: any) => {
                  const obj: any = {};
                  fields.forEach((f: any, i: number) => { obj[f.name] = row[i]; });
                  return obj;
                });
            return { rows, fields };
          } catch (error) {
            if (readOnlyTransaction || reclassification.commandType === 'write') {
              await oracleConnection.rollback().catch(() => undefined);
            }
            throw error;
          } finally {
            oracleConnection.callTimeout = previousCallTimeout;
            if (fromPool) await oracleConnection.close().catch(() => undefined);
          }
        });
      } else if (conn.db_type === 'dameng' && conn.dmConnection) {
        // One shared session. Ownership covers the production probe, reconnect,
        // statement, commit/rollback, schema restore and timeout restore.
        // An external ensure/reconnect also waits on this lock before close.
        // dmdb socketTimeout (error 20010) drops the socket and is not a cancel.
        // sessionTimeout is the server statement limit (DM8 error -608). It is
        // integer seconds, so a sub-second request becomes one second; 0 would disable it.
        const owned = await this.serializeForInstance(instanceId, async () => {
          const live = await this.acquireOwnedDameng(instanceId);
          conn = live;
          if (isMutation && !intentStarted) {
            try {
              await beginIntent();
            } catch (error: any) {
              return { intentRejected: error as { message?: string } };
            }
          }
          const dm = live.dmConnection as DamengSession;
          const previousTimeout = dm.conn_prop_sessionTimeout;
          dm.conn_prop_sessionTimeout = damengTimeoutSeconds(timeoutMs);
          let readOnlyTransaction = false;
          let restoreSchema: string | null = null;
          let primaryError: unknown;
          let rollbackError: unknown;
          let restoreError: unknown;
          try {
            if (context?.database) {
              const current = await dm.execute(
                "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL",
                [],
                { maxRows: 1, autoCommit: true },
              );
              restoreSchema = damengCell(current);
              await dm.execute(`SET SCHEMA ${quoteDamengIdentifier(context.database)}`, [], { autoCommit: true });
            }
            if (isReadOnly) {
              await dm.execute('SET TRANSACTION READ ONLY', [], { autoCommit: false });
              readOnlyTransaction = true;
            }
            const dmResult = await dm.execute(sql, [], {
              maxRows: isReadOnly ? MAX_SQL_ROWS + 1 : 0,
              autoCommit: false,
            });
            if (readOnlyTransaction) {
              await dm.rollback();
              readOnlyTransaction = false;
            } else if (reclassification.commandType === 'write') {
              await dm.commit();
            }
            const fields = dmResult.metaData?.map((m: any) => ({ name: m.name })) || [];
            const rows = Array.isArray(dmResult.rows) && dmResult.rows.length > 0 && !Array.isArray(dmResult.rows[0])
              ? dmResult.rows
              : (dmResult.rows || []).map((row: any) => {
                  const obj: any = {};
                  fields.forEach((f: any, i: number) => { obj[f.name] = row[i]; });
                  return obj;
                });
            return { statement: { rows, fields } };
          } catch (error) {
            primaryError = error;
            if (readOnlyTransaction || reclassification.commandType === 'write') {
              try {
                await dm.rollback();
                readOnlyTransaction = false;
              } catch (rollbackFailure) {
                rollbackError = rollbackFailure;
              }
            }
            throw error;
          } finally {
            // SET SCHEMA auto-commits. Skip it when rollback did not clear the transaction.
            if (restoreSchema && !rollbackError) {
              try {
                await dm.execute(`SET SCHEMA ${quoteDamengIdentifier(restoreSchema)}`, [], { autoCommit: true });
              } catch (error) {
                restoreError = error;
              }
            }
            const dirty = Boolean(rollbackError || restoreError);
            if (!dirty) dm.conn_prop_sessionTimeout = previousTimeout;
            if (dirty) {
              const parts = ['DAMENG_SESSION_QUARANTINED'];
              if (rollbackError) parts.push(`rollback=${errorText(rollbackError)}`);
              if (restoreError) parts.push(`schema=${errorText(restoreError)}`);
              if (primaryError) parts.push(`cause=${errorText(primaryError)}`);
              try {
                await this.quarantineDamengSession(instanceId, dm, context, sql, live.name, parts.join(' '));
              } catch { /* Keep the statement error. */ }
            }
            if (restoreError && !primaryError) throw restoreError;
          }
        });
        if (owned.intentRejected) return rejectIntent(owned.intentRejected);
        if (!owned.statement) throw new Error('实例未连接或重连失败');
        result = owned.statement;
      } else {
        return { success: false, error: `不支持的数据库类型: ${conn.db_type}` };
      }

      targetAcknowledged = true;
      const duration_ms = Date.now() - startTime;
      const allRows = Array.isArray(result.rows) ? result.rows : [];
      const truncated = isReadOnly && allRows.length > MAX_SQL_ROWS;
      const rows = truncated ? allRows.slice(0, MAX_SQL_ROWS) : allRows;
      const columns = Array.isArray(result.fields)
        ? result.fields.map((f: any) => f.name)
        : Object.keys(rows[0] || {});

      // 审计记录
      if (context?.userId || isMutation) {
        try {
          await auditLogManager.logSqlExecution({
            userId: context?.userId || String(context!.approvalGrant!.reviewerId),
            username: context?.username || 'unknown',
            instanceId,
            instanceName: conn.name,
            dbType: conn.db_type,
            sqlText: sql.substring(0, 500),
            durationMs: duration_ms,
            status: 'success',
            rowCount: rows.length,
            ipAddress: context?.ipAddress,
            approvalRequestId: context?.approvalGrant?.approvalRequestId,
          });
        } catch (error) { if (isMutation) throw error; }
      }

      if (isMutation) await sqlExecutionIntent.finish(operationId!, 'succeeded', { duration_ms, targetAcknowledged: true });
      return { success: true, columns, rows, rowCount: rows.length, truncated, duration_ms,
        ...(isMutation ? { executionState: 'succeeded' as const, operationId, retryable: false as const } : {}) };
    } catch (error: any) {
      if (isMutation && intentStarted) {
        await sqlExecutionIntent.finish(operationId!, 'unknown', { targetAcknowledged, error: 'SQL_EXECUTION_OR_AUDIT_FAILED' }).catch(() => undefined);
        return { success: false, executionState: 'unknown', operationId, retryable: false,
          error: 'SQL_OUTCOME_REQUIRES_RECONCILIATION: SQL may have committed; do not retry; inspect durable intent and target database' };
      }
      if (isMutation) {
        return { success: false, executionState: 'not_started', operationId, retryable: false, error: error.message };
      }
      const duration_ms = Date.now() - startTime;
      if (context?.userId || isMutation) {
        try {
          await auditLogManager.logSqlExecution({
            userId: context?.userId || String(context!.approvalGrant!.reviewerId),
            username: context?.username || 'unknown',
            instanceId,
            instanceName: conn.name,
            dbType: conn.db_type,
            sqlText: sql.substring(0, 500),
            durationMs: duration_ms,
            status: 'error',
            errorMessage: error.message,
            ipAddress: context?.ipAddress,
            approvalRequestId: context?.approvalGrant?.approvalRequestId,
          });
        } catch { /* audit non-blocking */ }
      }
      return { success: false, error: error.message };
    }
  }
}

export const sqlExecutor = new SqlExecutor();
