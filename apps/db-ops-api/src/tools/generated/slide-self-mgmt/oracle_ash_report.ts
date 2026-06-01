/**
 * Oracle ASH (Active Session History) 报告工具
 *
 * 使用 DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML() 生成 ASH 报告
 * 保留 Oracle 原生 HTML 格式 (D-11)
 */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { databaseService } from '../../../database-service.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';

/**
 * ASH 报告参数
 */
interface AshReportArgs {
  /** 实例 ID */
  instance_id: number;
  /** 开始时间 (ISO 8601 格式, 例如 2026-05-19 10:00:00) */
  start_time: string;
  /** 结束时间 (ISO 8601 格式, 例如 2026-05-19 11:00:00) */
  end_time: string;
}

export const oracleAshReportTool: AnyAgentTool = {
  name: 'slide_oracle_ash_report',
  description: '获取 Oracle ASH (Active Session History) 活跃会话历史报告，需要 Oracle Enterprise Edition + Diagnostics Pack 许可证',
  parameters: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'number',
        description: 'Oracle 数据库实例 ID',
      },
      start_time: {
        type: 'string',
        description: '开始时间 (ISO 8601 格式, 例如 2026-05-19 10:00:00)',
      },
      end_time: {
        type: 'string',
        description: '结束时间 (ISO 8601 格式, 例如 2026-05-19 11:00:00)',
      },
    },
    required: ['instance_id', 'start_time', 'end_time'],
  },
  group: 'db_ops',
  handler: async (args) => {
    const typedArgs = args as unknown as AshReportArgs;

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

      // 获取 DBID
      const dbidResult = await conn.oracleConnection.execute(
        'SELECT dbid FROM V$DATABASE'
      );
      const dbid = dbidResult.rows[0]?.[0] as number || 0;

      // 执行 ASH 报告查询 (D-11: 保留 Oracle 原生 HTML 格式)
      const result = await conn.oracleConnection.execute(
        `SELECT * FROM TABLE(DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML(
          l_dbid => :dbid,
          l_inst_num => 1,
          l_bnstime => TO_TIMESTAMP(:start, 'YYYY-MM-DD HH24:MI:SS'),
          l_etime => TO_TIMESTAMP(:end, 'YYYY-MM-DD HH24:MI:SS')
        ))`,
        { dbid, start: typedArgs.start_time, end: typedArgs.end_time }
      );

      // 收集 HTML 报告
      const lines: string[] = [];
      for (const row of (result.rows || [])) {
        const text = (row[0] || row as any).toString();
        if (text) lines.push(text);
      }

      if (lines.length === 0) {
        return {
          success: true,
          data: { html: '' },
          summary: 'ASH 报告生成完成，但内容为空（指定时间范围内可能没有活跃会话数据）',
        };
      }

      const htmlContent = lines.join('\n');

      return {
        success: true,
        data: {
          html: htmlContent,
          format: 'html',
          instance_id: typedArgs.instance_id,
          start_time: typedArgs.start_time,
          end_time: typedArgs.end_time,
        },
        summary: `✅ ASH 报告生成完成（${typedArgs.start_time} ~ ${typedArgs.end_time}）`,
        details: {
          format: 'Oracle 原生 HTML (D-11)',
          size_bytes: htmlContent.length,
        },
      };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // Diagnostics Pack 许可证检查
      if (errMsg.includes('ORA-00942') || errMsg.includes('DBMS_WORKLOAD_REPOSITORY') || errMsg.includes('insufficient privileges')) {
        return {
          success: false,
          error: 'ASH 报告需要 Oracle Enterprise Edition + Diagnostics Pack 许可证。请确认目标实例已安装 Diagnostics Pack，且当前用户有访问 DBMS_WORKLOAD_REPOSITORY 的权限。',
          errorCode: 'DIAGNOSTICS_PACK_REQUIRED',
        };
      }
      return {
        success: false,
        error: `获取 ASH 报告失败：${errMsg}`,
        errorCode: 'ASH_REPORT_FAILED',
      };
    }
  },
};

// 注册工具
toolCatalog.register(oracleAshReportTool);
