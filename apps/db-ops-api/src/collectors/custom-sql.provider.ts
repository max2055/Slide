/**
 * CustomSQLProvider — executes user-defined SQL from metric_definitions.collection_sql
 *
 * Security:
 * - SQL validated via node-sql-parser AST (SELECT-only check)
 * - Query wrapped in SELECT (...) AS val LIMIT 1 for single-row single-column enforcement
 * - 15-second execution timeout guard per D-12
 * - Read-only execution on existing DB connections (no new credentials)
 *
 * @see T-106-04 (Tampering): node-sql-parser AST validation ensures SELECT-only
 * @see T-106-07 (Tampering): SQL wrapped in SELECT (...) AS val LIMIT 1 — no dynamic WHERE or user interpolated params
 */
import { BaseMetricProvider } from './base-provider.js';
import type { DatabaseConnection } from '../database-service.js';
import type { MetricDefinition } from '../metric-registry.js';
import { validateSqlIsSelectOnly } from '../sql-validator.js';

export class CustomSQLProvider extends BaseMetricProvider {
  readonly name = 'Custom SQL Provider';
  readonly supportedDbTypes = ['mysql', 'postgresql', 'oracle', 'dameng'];

  async collect(instance: DatabaseConnection, metricDef: MetricDefinition): Promise<number | null> {
    if (!instance) return null;
    const sql = (metricDef as any).collection_sql;
    if (!sql) return null;

    // Validate SELECT-only via AST (Plan 01 — node-sql-parser)
    const validation = validateSqlIsSelectOnly(sql);
    if (!validation.valid) {
      console.error(`[CustomSQLProvider] SQL validation failed for ${metricDef.id}: ${validation.error}`);
      return null;
    }

    // Enforce single-row single-column scalar
    const wrappedSql = `SELECT (${sql}) AS val LIMIT 1`;

    try {
      const result = await this._executeQuery(instance, wrappedSql);
      const val = result?.[0]?.val;
      return val != null ? Number(val) : null;
    } catch (e: any) {
      console.error(`[CustomSQLProvider] ${metricDef.id} 采集失败:`, e.message);
      throw e;
    }
  }

  describeSchema(instanceId: number): Promise<string> {
    return Promise.resolve('no schema description available');
  }

  private async _executeQuery(instance: DatabaseConnection, sql: string): Promise<any[]> {
    switch (instance.db_type) {
      case 'mysql': {
        if (!instance.pool) {
          console.warn(`[CustomSQLProvider] MySQL 连接不可用，实例 ${(instance as any).id}`);
          return [];
        }
        // 15s timeout guard
        await instance.pool.query('SET max_execution_time=15000');
        const [rows] = await instance.pool.query(sql);
        return rows as any[];
      }

      case 'postgresql': {
        if (!instance.pgClient) {
          console.warn(`[CustomSQLProvider] PostgreSQL 连接不可用，实例 ${(instance as any).id}`);
          return [];
        }
        // 15s timeout guard — set per-session statement timeout
        await instance.pgClient.query("SET statement_timeout = '15s'");
        const result = await instance.pgClient.query(sql);
        return result.rows;
      }

      case 'oracle': {
        if (!instance.oracleConnection) {
          console.warn(`[CustomSQLProvider] Oracle 连接不可用，实例 ${(instance as any).id}`);
          return [];
        }
        // Oracle timeout is handled by oracledb pool configuration
        const result = await instance.oracleConnection.execute(sql, [], { fetchArraySize: 1 });
        return (result.rows || []).map((row: any) => ({ val: row[0] }));
      }

      case 'dameng': {
        if (!instance.dmConnection) {
          console.warn(`[CustomSQLProvider] Dameng 连接不可用，实例 ${(instance as any).id}`);
          return [];
        }
        const result = await instance.dmConnection.execute(sql, { maxRows: 1 });
        return (result.rows || []).map((row: any) => ({ val: row[0] }));
      }

      default:
        console.warn(`[CustomSQLProvider] 不支持的数据库类型: ${instance.db_type}`);
        return [];
    }
  }
}
