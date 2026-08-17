/**
 * SQL 执行服务
 * 安全执行 SQL 查询，支持 SELECT 直接执行、DDL/DML 走审批流
 */
import { databaseService } from './database-service';
import { auditLogManager } from './audit/audit-log';
import { classifySql } from './sql-validator.js';
import { dbConnection } from './db-connection.js';
import { authorizeApprovedSqlExecution, type ApprovalExecutionGrant } from './security/approval-execution-authorizer.js';
import { securityEventService } from './security/security-event-service.js';

const DEFAULT_SQL_TIMEOUT_MS = 15_000;
const MAX_SQL_TIMEOUT_MS = 30_000;
const MAX_SQL_ROWS = 1_000;

class SqlExecutor {
  private readonly executionQueues = new Map<number, Promise<void>>();

  private normalizeTimeout(timeoutMs?: number): number {
    if (!Number.isFinite(timeoutMs)) return DEFAULT_SQL_TIMEOUT_MS;
    return Math.max(100, Math.min(Math.trunc(timeoutMs!), MAX_SQL_TIMEOUT_MS));
  }

  private async serializeForInstance<T>(instanceId: number, action: () => Promise<T>): Promise<T> {
    const previous = this.executionQueues.get(instanceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.executionQueues.set(instanceId, queued);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.executionQueues.get(instanceId) === queued) this.executionQueues.delete(instanceId);
    }
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

    // 先确保连接可用（触发重连如果需要）
    const alive = await databaseService.ensureConnectionAlive(instanceId);
    if (!alive) {
      return { success: false, error: '实例未连接或重连失败' };
    }

    const conn = databaseService.getConnection(instanceId);
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

    try {
      let result: any;
      const isReadOnly = reclassification.commandType === 'read';
      const timeoutMs = this.normalizeTimeout(context?.timeoutMs);

      if (conn.db_type === 'mysql' && conn.pool) {
        result = await this.serializeForInstance(instanceId, async () => {
          const connection = await conn.pool!.getConnection();
          let transactionStarted = false;
          try {
            await connection.query(`SET SESSION max_execution_time = ${timeoutMs}`);
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
            await connection.query('SET SESSION max_execution_time = 0').catch(() => undefined);
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
          const oracleConnection = conn.oraclePool ? await conn.oraclePool.getConnection() : conn.oracleConnection!;
          const previousCallTimeout = oracleConnection.callTimeout;
          try {
            oracleConnection.callTimeout = timeoutMs;
            if (isReadOnly) await oracleConnection.execute('SET TRANSACTION READ ONLY');
            const oracleResult = await oracleConnection.execute(sql, [], { maxRows: isReadOnly ? MAX_SQL_ROWS + 1 : 0 });
            if (isReadOnly) await oracleConnection.rollback();
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
            if (isReadOnly) await oracleConnection.rollback().catch(() => undefined);
            throw error;
          } finally {
            oracleConnection.callTimeout = previousCallTimeout;
            if (conn.oraclePool) await oracleConnection.close().catch(() => undefined);
          }
        });
      } else if (conn.db_type === 'dameng' && conn.dmConnection) {
        const dmResult = await conn.dmConnection.execute(sql, [], { maxRows: isReadOnly ? MAX_SQL_ROWS + 1 : 0 });
        const fields = dmResult.metaData?.map((m: any) => ({ name: m.name })) || [];
        const rows = Array.isArray(dmResult.rows) && dmResult.rows.length > 0 && !Array.isArray(dmResult.rows[0])
          ? dmResult.rows
          : (dmResult.rows || []).map((row: any) => {
              const obj: any = {};
              fields.forEach((f: any, i: number) => { obj[f.name] = row[i]; });
              return obj;
            });
        result = { rows, fields };
      } else {
        return { success: false, error: `不支持的数据库类型: ${conn.db_type}` };
      }

      const duration_ms = Date.now() - startTime;
      const allRows = Array.isArray(result.rows) ? result.rows : [];
      const truncated = isReadOnly && allRows.length > MAX_SQL_ROWS;
      const rows = truncated ? allRows.slice(0, MAX_SQL_ROWS) : allRows;
      const columns = Array.isArray(result.fields)
        ? result.fields.map((f: any) => f.name)
        : Object.keys(rows[0] || {});

      // 审计记录
      if (context?.userId) {
        try {
          await auditLogManager.logSqlExecution({
            userId: context.userId,
            username: context.username || 'unknown',
            instanceId,
            instanceName: conn.name,
            dbType: conn.db_type,
            sqlText: sql.substring(0, 500),
            durationMs: duration_ms,
            status: 'success',
            rowCount: rows.length,
            ipAddress: context.ipAddress,
            approvalRequestId: context.approvalGrant?.approvalRequestId,
          });
        } catch { /* audit non-blocking */ }
      }

      return { success: true, columns, rows, rowCount: rows.length, truncated, duration_ms };
    } catch (error: any) {
      const duration_ms = Date.now() - startTime;
      if (context?.userId) {
        try {
          await auditLogManager.logSqlExecution({
            userId: context.userId,
            username: context.username || 'unknown',
            instanceId,
            instanceName: conn.name,
            dbType: conn.db_type,
            sqlText: sql.substring(0, 500),
            durationMs: duration_ms,
            status: 'error',
            errorMessage: error.message,
            ipAddress: context.ipAddress,
            approvalRequestId: context.approvalGrant?.approvalRequestId,
          });
        } catch { /* audit non-blocking */ }
      }
      return { success: false, error: error.message };
    }
  }
}

export const sqlExecutor = new SqlExecutor();
