/**
 * Oracle 表空间详情工具
 *
 * 查询 DBA_TABLESPACES + DBA_DATA_FILES + DBA_SEGMENTS 获取详细的表空间信息
 * 支持按表空间名称过滤
 */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { databaseService } from '../../../database-service.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';

/**
 * 表空间详情参数
 */
interface TablespaceDetailArgs {
  /** 实例 ID */
  instance_id: number;
  /** 表空间名称（可选，不传则返回全部） */
  tablespace_name?: string;
}

export const oracleTablespaceDetailTool: AnyAgentTool = {
  name: 'slide_oracle_tablespace_detail',
  description: '获取 Oracle 表空间使用详情，包括大小、使用率、自动扩展状态、Top 段信息',
  parameters: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'number',
        description: 'Oracle 数据库实例 ID',
      },
      tablespace_name: {
        type: 'string',
        description: '表空间名称（可选，不传则返回全部表空间）',
      },
    },
    required: ['instance_id'],
  },
  group: 'db_ops',
  handler: async (args) => {
    const typedArgs = args as unknown as TablespaceDetailArgs;

    if (!typedArgs.instance_id) {
      return {
        success: false,
        error: '请提供实例 ID (instance_id)',
        errorCode: 'MISSING_ARGUMENTS',
      };
    }

    try {
      const conn = databaseService.getConnection(typedArgs.instance_id);
      if (!conn || !conn.connected) {
        return {
          success: false,
          error: `实例 ${typedArgs.instance_id} 未连接`,
          errorCode: 'NOT_CONNECTED',
        };
      }

      if (conn.db_type !== 'oracle' || !conn.oracleConnection) {
        return {
          success: false,
          error: `实例 ${typedArgs.instance_id} 不是 Oracle 数据库`,
          errorCode: 'WRONG_DB_TYPE',
        };
      }

      // 1. 获取表空间概览信息 (DBA_TABLESPACES + DBA_DATA_FILES)
      let tablespaceFilter = '';
      const bindParams: any = {};
      if (typedArgs.tablespace_name) {
        tablespaceFilter = 'AND t.tablespace_name = :ts_name';
        bindParams.ts_name = typedArgs.tablespace_name;
      }

      let tsRows: any[];
      try {
        const tsResult = await conn.oracleConnection.execute(
          `SELECT
            t.tablespace_name as name,
            t.status,
            t.contents,
            t.extent_management,
            t.allocation_type,
            ROUND(NVL(d.total_bytes, 0) / 1024 / 1024 / 1024, 2) as total_gb,
            ROUND(NVL(d.used_bytes, 0) / 1024 / 1024 / 1024, 2) as used_gb,
            ROUND((NVL(d.used_bytes, 0) / NULLIF(NVL(d.total_bytes, 1), 0)) * 100, 2) as usage_percent,
            ROUND(NVL(d.max_bytes, 0) / 1024 / 1024 / 1024, 2) as max_gb,
            d.autoextensible,
            NVL(s.segment_count, 0) as segment_count
          FROM dba_tablespaces t
          LEFT JOIN (
            SELECT
              tablespace_name,
              SUM(bytes) as total_bytes,
              SUM(CASE WHEN autoextensible = 'YES' THEN maxbytes ELSE bytes END) as max_bytes,
              SUM(CASE WHEN autoextensible = 'YES' THEN maxbytes ELSE bytes END) - SUM(bytes) as free_bytes,
              SUM(bytes) - NVL((
                SELECT SUM(bytes) FROM dba_free_space f
                WHERE f.tablespace_name = d.tablespace_name
              ), 0) as used_bytes
            FROM dba_data_files d
            GROUP BY tablespace_name
          ) d ON t.tablespace_name = d.tablespace_name
          LEFT JOIN (
            SELECT tablespace_name, COUNT(*) as segment_count
            FROM dba_segments
            GROUP BY tablespace_name
          ) s ON t.tablespace_name = s.tablespace_name
          WHERE t.contents != 'UNDO'
          ${tablespaceFilter}
          ORDER BY d.total_bytes DESC NULLS LAST`,
          bindParams
        );
        tsRows = tsResult.rows || [];
      } catch {
        // DBA_TABLESPACES 权限不足 — 尝试降级查询
        return {
          success: false,
          error: '表空间详情需要 DBA 或 SELECT ANY DICTIONARY 权限。请为监控用户授予相应权限。\n\n需要的权限：\n- SELECT ON dba_tablespaces\n- SELECT ON dba_data_files\n- SELECT ON dba_segments\n\n或使用 SYS/SYSTEM 用户连接重试。',
          errorCode: 'DBA_PRIVILEGE_REQUIRED',
        };
      }

      // 2. 获取 Top 段信息 (每个表空间 Top 10)
      let topSegments: any[] = [];
      try {
        const filterClause = typedArgs.tablespace_name
          ? 'AND s.tablespace_name = :ts_name2'
          : '';
        const segResult = await conn.oracleConnection.execute(
          `SELECT *
          FROM (
            SELECT
              s.tablespace_name,
              s.segment_name,
              s.owner,
              s.segment_type,
              ROUND(s.bytes / 1024 / 1024, 2) as size_mb,
              RANK() OVER (PARTITION BY s.tablespace_name ORDER BY s.bytes DESC) as rnk
            FROM dba_segments s
            WHERE s.segment_type IN ('TABLE', 'INDEX', 'TABLE PARTITION', 'INDEX PARTITION')
            ${filterClause}
          )
          WHERE rnk <= 10
          ORDER BY tablespace_name, rnk`,
          typedArgs.tablespace_name
            ? { ts_name2: typedArgs.tablespace_name }
            : {}
        );
        topSegments = (segResult.rows || []).map((row: any) => ({
          tablespace: row[0],
          segment_name: row[1],
          owner: row[2],
          segment_type: row[3],
          size_mb: Number(row[4]),
        }));
      } catch {
        // DBA_SEGMENTS 可选 — 不影响主体功能
        topSegments = [];
      }

      // 格式化响应
      const tablespaces = tsRows.map((row: any) => {
        return {
          name: row[0],
          status: row[1],
          contents: row[2],
          extent_management: row[3],
          allocation_type: row[4],
          total_gb: Number(row[5] || 0),
          used_gb: Number(row[6] || 0),
          usage_percent: Number(row[7] || 0),
          max_gb: row[8] ? Number(row[8]) : null,
          autoextensible: row[9],
          segment_count: Number(row[10] || 0),
          free_gb: row[8] ? Math.round((Number(row[8]) - Number(row[6] || 0)) * 100) / 100 : null,
        };
      });

      const totalSize = tablespaces.reduce((s: number, ts: any) => s + ts.total_gb, 0);
      const totalUsed = tablespaces.reduce((s: number, ts: any) => s + ts.used_gb, 0);

      return {
        success: true,
        data: {
          tablespaces,
          top_segments: topSegments,
          summary: {
            total_tablespaces: tablespaces.length,
            total_size_gb: Math.round(totalSize * 100) / 100,
            total_used_gb: Math.round(totalUsed * 100) / 100,
            overall_usage_percent: totalSize > 0 ? Math.round((totalUsed / totalSize) * 10000) / 100 : 0,
          },
        },
        summary: `✅ 获取到 ${tablespaces.length} 个表空间信息，总大小 ${Math.round(totalSize * 100) / 100} GB，已用 ${Math.round(totalUsed * 100) / 100} GB`,
      };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `获取表空间详情失败：${errMsg}`,
        errorCode: 'TABLESPACE_DETAIL_FAILED',
      };
    }
  },
};

// 注册工具
toolCatalog.register(oracleTablespaceDetailTool);
