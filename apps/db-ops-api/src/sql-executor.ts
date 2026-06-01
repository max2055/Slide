/**
 * SQL 执行服务
 * 安全执行 SQL 查询，支持 SELECT 直接执行、DDL/DML 走审批流
 */
import { databaseService } from './database-service';
import { auditLogManager } from './audit/audit-log';

class SqlExecutor {
  /**
   * 执行 SQL 查询（仅 SELECT）
   */
  async executeSql(instanceId: number, sql: string, context?: {
    userId?: string; username?: string; ipAddress?: string; database?: string;
  }): Promise<{
    success: boolean;
    columns?: string[];
    rows?: any[];
    rowCount?: number;
    duration_ms?: number;
    error?: string;
  }> {
    const startTime = Date.now();

    // 先确保连接可用（触发重连如果需要）
    const alive = await databaseService.ensureConnectionAlive(instanceId);
    if (!alive) {
      return { success: false, error: '实例未连接或重连失败' };
    }

    const conn = databaseService.getConnection(instanceId);
    if (!conn) {
      return { success: false, error: '实例未连接' };
    }

    // 切换数据库/模式（如果指定了 database 参数）
    if (context?.database) {
      if (conn.db_type === 'mysql' && conn.pool) {
        const escapedDb = context.database.replace(/`/g, '``');
        await conn.pool.query('USE `' + escapedDb + '`');
      } else if (conn.db_type === 'postgresql' && conn.pgClient) {
        await conn.pgClient.query('SET search_path TO ' + conn.pgClient.escapeIdentifier(context.database));
      } else {
        console.warn(`[SqlExecutor] Database switching not supported for db_type: ${conn.db_type}`);
      }
    }

    try {
      let result: any;

      if (conn.db_type === 'mysql' && conn.pool) {
        const [rows, fields] = await conn.pool.query(sql);
        result = { rows, fields };
      } else if (conn.db_type === 'postgresql' && conn.pgClient) {
        const pgResult = await conn.pgClient.query(sql);
        result = { rows: pgResult.rows, fields: pgResult.fields };
      } else if (conn.db_type === 'oracle' && conn.oracleConnection) {
        const oracleResult = await conn.oracleConnection.execute(sql);
        const fields = oracleResult.metaData?.map((m: any) => ({ name: m.name })) || [];
        const rows = Array.isArray(oracleResult.rows) && oracleResult.rows.length > 0 && !Array.isArray(oracleResult.rows[0])
          ? oracleResult.rows
          : (oracleResult.rows || []).map((row: any) => {
              const obj: any = {};
              fields.forEach((f: any, i: number) => { obj[f.name] = row[i]; });
              return obj;
            });
        result = { rows, fields };
      } else if (conn.db_type === 'dameng' && conn.dmConnection) {
        const dmResult = await conn.dmConnection.execute(sql);
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
      const rows = Array.isArray(result.rows) ? result.rows : [];
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
          });
        } catch { /* audit non-blocking */ }
      }

      return { success: true, columns, rows, rowCount: rows.length, duration_ms };
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
          });
        } catch { /* audit non-blocking */ }
      }
      return { success: false, error: error.message };
    }
  }
}

export const sqlExecutor = new SqlExecutor();
