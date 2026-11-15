/**
 * Oracle ASH (Active Session History) 报告工具
 *
 * 使用 DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML() 生成 ASH 报告
 * 保留 Oracle 原生 HTML 格式 (D-11)
 */

import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { databaseService } from '../../../database-service.js';

/**
 * ASH 报告参数
 */
interface AshReportArgs {
  /** 实例 ID */
  instance_id: number;
  /** 数据库墙钟开始时间，不带时区，精确到秒 */
  start_time: string;
  /** 数据库墙钟结束时间，不带时区，精确到秒 */
  end_time: string;
}

export const oracleAshReportTool: AnyAgentTool = {
  name: 'slide_oracle_ash_report',
  description: '获取当前连接实例的 Oracle ASH 活跃会话历史报告，需要 Oracle Enterprise Edition + Diagnostics Pack 许可证。时间使用目标数据库的墙钟时间（精确到秒，不带 Z 或时区偏移），不自动转换时区；不支持选择其他 RAC 实例。',
  parameters: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'number',
        description: 'Oracle 数据库实例 ID',
      },
      start_time: {
        type: 'string',
        description: '数据库墙钟开始时间，YYYY-MM-DD HH:mm:ss 或 YYYY-MM-DDTHH:mm:ss，不带 Z 或时区偏移，例如 2026-05-19 10:00:00',
      },
      end_time: {
        type: 'string',
        description: '数据库墙钟结束时间，YYYY-MM-DD HH:mm:ss 或 YYYY-MM-DDTHH:mm:ss，不带 Z 或时区偏移，例如 2026-05-19 11:00:00',
      },
    },
    required: ['instance_id', 'start_time', 'end_time'],
  },
  group: 'db_ops',
  handler: async (args) => {
    const typedArgs = args as unknown as AshReportArgs;

    if (!Number.isSafeInteger(typedArgs.instance_id) || typedArgs.instance_id <= 0) {
      return {
        success: false,
        error: '请提供实例 ID (instance_id)',
        errorCode: 'MISSING_ARGUMENTS',
      };
    }

    // Only the connected instance is supported; never silently honor or ignore a target override.
    if (Object.keys(args).some(key => !['instance_id', 'start_time', 'end_time'].includes(key))) {
      return { success: false, status: 'error', error: '仅支持当前连接实例，参数仅允许 instance_id、start_time、end_time', errorCode: 'INVALID_ARGUMENTS' };
    }

    const start = normalizeOracleTimestamp(typedArgs.start_time);
    const end = normalizeOracleTimestamp(typedArgs.end_time);
    if (!start || !end || end.order <= start.order) {
      return { success: false, status: 'error', error: 'start_time/end_time 必须是有效数据库墙钟时间（YYYY-MM-DD HH:mm:ss，不带 Z、时区偏移或小数秒），且 end_time 晚于 start_time；请按目标数据库时钟提供时间', errorCode: 'INVALID_ARGUMENTS' };
    }
    if (end.order - start.order > 7 * 24 * 60 * 60 * 1000) {
      return { success: false, status: 'error', error: 'ASH 时间范围不能超过 7 天', errorCode: 'TIME_RANGE_TOO_LARGE' };
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
      const oracleConnection = conn.oracleConnection;

      // Read identity from the same connection used for the report. DBTIMEZONE is
      // storage configuration, not necessarily the host clock used by ASH.
      const identityResult = await oracleConnection.execute(
        `SELECT d.dbid, d.name, i.instance_number, i.instance_name,
          SYS_CONTEXT('USERENV', 'CON_NAME'), SESSIONTIMEZONE, DBTIMEZONE,
          TO_CHAR(SYSTIMESTAMP, 'TZH:TZM')
         FROM V$DATABASE d CROSS JOIN V$INSTANCE i`
      );
      const row = identityResult.rows?.[0];
      const identity = Array.isArray(row) ? row : [];
      const [dbid, databaseName, instanceNumber, instanceName, containerName,
        sessionTimezone, databaseTimezone, databaseHostOffset] = identity;
      if (!Number.isSafeInteger(dbid) || dbid <= 0 || !Number.isSafeInteger(instanceNumber) || instanceNumber <= 0
        || typeof databaseName !== 'string' || !databaseName || typeof instanceName !== 'string' || !instanceName) {
        return { success: false, status: 'error', error: '无法确认当前连接的 Oracle 数据库与实例身份', errorCode: 'ASH_IDENTITY_UNAVAILABLE' };
      }
      const metadata = {
        format: 'html',
        instance_id: typedArgs.instance_id,
        dbid,
        database_name: databaseName,
        instance_number: instanceNumber,
        instance_name: instanceName,
        container_name: containerName,
        target_strategy: 'connected_instance',
        time_semantics: 'database_wall_clock',
        session_timezone: sessionTimezone,
        database_timezone: databaseTimezone,
        database_host_current_offset: databaseHostOffset,
        start_time: start.value,
        end_time: end.value,
      };

      // 执行 ASH 报告查询 (D-11: 保留 Oracle 原生 HTML 格式)
      const result = await oracleConnection.execute(
        `SELECT * FROM TABLE(DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML(
          l_dbid => :b_dbid,
          l_inst_num => :b_instance_number,
          l_btime => TO_DATE(:b_start_time, 'FXYYYY-MM-DD HH24:MI:SS'),
          l_etime => TO_DATE(:b_end_time, 'FXYYYY-MM-DD HH24:MI:SS')
        ))`,
        { b_dbid: dbid, b_instance_number: instanceNumber, b_start_time: start.value, b_end_time: end.value }
      );

      // 收集 HTML 报告
      const lines: string[] = [];
      for (const row of (result.rows || [])) {
        const text = row[0] == null ? '' : String(row[0]);
        if (text) lines.push(text);
      }

      if (lines.length === 0) {
        return {
          success: true,
          status: 'warning',
          data: { ...metadata, html: '' },
          summary: 'ASH 报告生成完成，但内容为空（指定时间范围内可能没有活跃会话数据）',
          next_actions: ['确认时间范围内存在 ASH 数据，或检查实例采集状态'],
        };
      }

      const htmlContent = lines.join('\n');

      return {
        success: true,
        status: 'success',
        data: {
          ...metadata,
          html: htmlContent,
        },
        summary: `✅ ASH 报告生成完成（${databaseName}/${instanceName}，实例号 ${instanceNumber}；数据库墙钟 ${start.value} ~ ${end.value}）`,
        details: {
          format: 'Oracle 原生 HTML (D-11)',
          size_bytes: htmlContent.length,
        },
      };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // Oracle errors do not prove a customer's license entitlement. Preserve the
      // original diagnostic, including privilege, missing-object and binding errors.
      return {
        success: false,
        status: 'error',
        error: `获取 ASH 报告失败：${errMsg}`,
        errorCode: errMsg.match(/\b(?:ORA|PLS|NJS|DPI)-\d+\b/)?.[0] || 'ASH_REPORT_FAILED',
      };
    }
  },
};

function normalizeOracleTimestamp(value: unknown): { value: string; order: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  // UTC is only a calendar/range arithmetic frame here, never a timezone conversion.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return { value: value.replace('T', ' '), order: calendar.getTime() };
}

// 注册工具
toolCatalog.register(oracleAshReportTool);
