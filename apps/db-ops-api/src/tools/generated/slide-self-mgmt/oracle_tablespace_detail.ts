/**
 * Oracle 表空间详情工具
 *
 * 查询 DBA_TABLESPACES + DBA_DATA_FILES + DBA_SEGMENTS 获取详细的表空间信息
 * 支持按表空间名称过滤
 */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { databaseService } from '../../../database-service.js';

/** Only expose a validated driver code, never driver messages, SQL or connection details. */
function tablespaceFailure(error: unknown, phase: string): ToolResult {
  const source = error && typeof error === 'object'
    ? error as { code?: unknown; errorNum?: unknown; message?: unknown } : {};
  const candidate = typeof source.code === 'string' ? source.code
    : Number.isInteger(source.errorNum) && Number(source.errorNum) > 0 && Number(source.errorNum) <= 99999
      ? `ORA-${String(source.errorNum).padStart(5, '0')}`
      : typeof source.message === 'string' ? source.message.match(/^(ORA-\d{5}|NJS-\d{3}|DPI-\d{4})\b/)?.[1] : undefined;
  const code = candidate && /^(ORA-\d{5}|NJS-\d{3}|DPI-\d{4}|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND)$/.test(candidate)
    ? candidate : 'UNKNOWN';
  console.warn('[oracle_tablespace_detail] query failed', { phase, code });
  if (code === 'ORA-01031' || code === 'ORA-00942') {
    return { success: false, status: 'error', errorCode: 'DBA_PRIVILEGE_REQUIRED',
      error: '无法读取表空间数据字典，请由管理员核对当前用户对 DBA_TABLESPACES、DBA_DATA_FILES、DBA_FREE_SPACE、DBA_SEGMENTS 的 SELECT 权限。' };
  }
  if (['ORA-01012', 'ORA-03113', 'ORA-03114', 'ORA-03135', 'ORA-12170',
    'NJS-003', 'NJS-500', 'NJS-501', 'NJS-510', 'NJS-511', 'NJS-518', 'DPI-1010', 'DPI-1080',
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(code) || /^ORA-125\d{2}$/.test(code)) {
    return { success: false, status: 'error', errorCode: 'TABLESPACE_CONNECTION_FAILED',
      error: '表空间查询连接失败，请检查 Oracle 连接状态和网络。' };
  }
  if (/^ORA-/.test(code)) {
    return { success: false, status: 'error', errorCode: 'TABLESPACE_QUERY_FAILED',
      error: 'Oracle 表空间查询失败，请联系管理员根据日志中的错误码排查。' };
  }
  return { success: false, status: 'error', errorCode: 'TABLESPACE_DETAIL_FAILED',
    error: '获取表空间详情失败，请根据服务端日志排查。' };
}

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
  description: '获取 Oracle 表空间使用详情，包括大小、使用率、自动扩展状态、Top 段信息；自动扩展 YES 表示任一数据文件可扩展，NO 表示全部不可扩展',
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

    if (!Number.isSafeInteger(typedArgs.instance_id) || typedArgs.instance_id <= 0) {
      return {
        success: false,
        error: '请提供实例 ID (instance_id)',
        errorCode: 'MISSING_ARGUMENTS',
      };
    }
    if (typedArgs.tablespace_name !== undefined && (typeof typedArgs.tablespace_name !== 'string' || typedArgs.tablespace_name.trim().length === 0)) {
      return { success: false, status: 'error', error: 'tablespace_name 不能为空', errorCode: 'INVALID_ARGUMENTS' };
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
      if (typedArgs.tablespace_name !== undefined) {
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
              -- 任一数据文件可自动扩展，则表空间标记为 YES；全部不可扩展则为 NO
              CASE WHEN MAX(CASE WHEN autoextensible = 'YES' THEN 1 ELSE 0 END) = 1
                THEN 'YES' ELSE 'NO' END as autoextensible,
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
      } catch (error) {
        return tablespaceFailure(error, 'overview');
      }

      // 2. 获取 Top 段信息 (每个表空间 Top 10)
      let topSegments: any[] = [];
      let topSegmentsError: ToolResult | undefined;
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
      } catch (error) {
        // DBA_SEGMENTS 可选 — 不影响主体功能
        topSegments = [];
        topSegmentsError = tablespaceFailure(error, 'top_segments');
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
          max_gb: row[8] != null ? Number(row[8]) : null,
          autoextensible: row[9],
          segment_count: Number(row[10] || 0),
          free_gb: row[8] != null ? Math.round((Number(row[8]) - Number(row[6] || 0)) * 100) / 100 : null,
        };
      });

      const totalSize = tablespaces.reduce((s: number, ts: any) => s + ts.total_gb, 0);
      const totalUsed = tablespaces.reduce((s: number, ts: any) => s + ts.used_gb, 0);

      return {
        success: true,
        status: tablespaces.length === 0 || topSegmentsError ? 'warning' : 'success',
        ...(topSegmentsError ? { details: { top_segments_error: topSegmentsError } } : {}),
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
        next_actions: tablespaces.length === 0 ? ['确认表空间名称和数据库用户权限'] : [],
      };
    } catch (error: unknown) {
      return tablespaceFailure(error, 'handler');
    }
  },
};

// 注册工具
toolCatalog.register(oracleTablespaceDetailTool);
