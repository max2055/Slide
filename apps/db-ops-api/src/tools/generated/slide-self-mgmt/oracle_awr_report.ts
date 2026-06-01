/**
 * Oracle AWR (Automatic Workload Repository) 报告工具
 *
 * 使用 DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML() 生成 AWR 报告
 * 保留 Oracle 原生 HTML 格式 (D-11)
 */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { databaseService } from '../../../database-service.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';

/**
 * AWR 报告参数
 */
interface AwrReportArgs {
  /** 实例 ID */
  instance_id: number;
  /** 开始快照 ID (从 DBA_HIST_SNAPSHOT 查询) */
  begin_snap_id: number;
  /** 结束快照 ID (从 DBA_HIST_SNAPSHOT 查询) */
  end_snap_id: number;
}

export const oracleAwrReportTool: AnyAgentTool = {
  name: 'slide_oracle_awr_report',
  description: '获取 Oracle AWR (Automatic Workload Repository) 自动工作负载报告，需要 Oracle Enterprise Edition + Diagnostics Pack 许可证。可以通过 V$ACTIVE_SESSION_HISTORY 查询快照 ID',
  parameters: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'number',
        description: 'Oracle 数据库实例 ID',
      },
      begin_snap_id: {
        type: 'number',
        description: '开始快照 ID (从 DBA_HIST_SNAPSHOT 获取)',
      },
      end_snap_id: {
        type: 'number',
        description: '结束快照 ID (从 DBA_HIST_SNAPSHOT 获取)',
      },
    },
    required: ['instance_id', 'begin_snap_id', 'end_snap_id'],
  },
  group: 'db_ops',
  handler: async (args) => {
    const typedArgs = args as unknown as AwrReportArgs;

    if (!typedArgs.instance_id) {
      return {
        success: false,
        error: '请提供实例 ID (instance_id)',
        errorCode: 'MISSING_ARGUMENTS',
      };
    }

    if (!typedArgs.begin_snap_id || !typedArgs.end_snap_id) {
      return {
        success: false,
        error: '请提供开始和结束快照 ID (begin_snap_id, end_snap_id)',
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

      // 执行 AWR 报告查询 (D-11: 保留 Oracle 原生 HTML 格式)
      const result = await conn.oracleConnection.execute(
        `SELECT * FROM TABLE(DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML(
          l_dbid => :dbid,
          l_inst_num => 1,
          l_bnstime => :begin,
          l_instime => :end
        ))`,
        { dbid, begin: typedArgs.begin_snap_id, end: typedArgs.end_snap_id }
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
          summary: 'AWR 报告生成完成，但内容为空（指定快照范围内可能没有数据）',
        };
      }

      const htmlContent = lines.join('\n');

      return {
        success: true,
        data: {
          html: htmlContent,
          format: 'html',
          instance_id: typedArgs.instance_id,
          begin_snap_id: typedArgs.begin_snap_id,
          end_snap_id: typedArgs.end_snap_id,
        },
        summary: `✅ AWR 报告生成完成（快照 ${typedArgs.begin_snap_id} ~ ${typedArgs.end_snap_id}）`,
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
          error: 'AWR 报告需要 Oracle Enterprise Edition + Diagnostics Pack 许可证。请确认目标实例已安装 Diagnostics Pack，且当前用户有访问 DBMS_WORKLOAD_REPOSITORY 的权限。',
          errorCode: 'DIAGNOSTICS_PACK_REQUIRED',
        };
      }
      return {
        success: false,
        error: `获取 AWR 报告失败：${errMsg}`,
        errorCode: 'AWR_REPORT_FAILED',
      };
    }
  },
};

// 注册工具
toolCatalog.register(oracleAwrReportTool);
