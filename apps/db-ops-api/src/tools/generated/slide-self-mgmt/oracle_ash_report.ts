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
  /** 无偏移为数据库墙钟；Z/偏移为绝对时刻，支持小数秒 */
  start_time: string;
  /** 同 start_time */
  end_time: string;
  /** 数据库主机时区区域名或固定偏移，用于绝对时刻转换 */
  database_time_zone?: string;
}

export const oracleAshReportTool: AnyAgentTool = {
  name: 'slide_oracle_ash_report',
  description: '获取当前连接实例的 Oracle ASH 活跃会话历史报告，需要 Oracle Enterprise Edition + Diagnostics Pack 许可证。无偏移时间为数据库墙钟；Z/偏移输入为绝对时刻，转换至数据库主机时区。支持小数秒，报告范围向外取整到秒；不支持选择其他 RAC 实例。',
  parameters: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'number',
        description: 'Oracle 数据库实例 ID',
      },
      start_time: {
        type: 'string',
        description: '开始时间，例如 2026-05-19 10:00:00、2026-05-19T02:00:00.123Z 或 2026-05-19T10:00:00+08:00；无偏移为数据库墙钟，带偏移为绝对时刻',
      },
      end_time: {
        type: 'string',
        description: '结束时间，格式和语义同 start_time，支持小数秒',
      },
      database_time_zone: {
        type: 'string',
        description: '数据库主机实际时区（如 Asia/Shanghai、Europe/London、+08:00），用于绝对时间转换及历史夏令时规则。省略时使用 SYSTIMESTAMP 当前主机偏移；该默认不代表历史夏令时规则，不使用 SESSIONTIMEZONE 或 DBTIMEZONE 猜测主机时区。',
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
    if (Object.keys(args).some(key => !['instance_id', 'start_time', 'end_time', 'database_time_zone'].includes(key))
      || (typedArgs.database_time_zone !== undefined && (typeof typedArgs.database_time_zone !== 'string'
        || !/^(?:[A-Za-z][A-Za-z0-9_+/-]{0,63}|[+-]\d{2}:\d{2})$/.test(typedArgs.database_time_zone)))) {
      return { success: false, status: 'error', error: '参数或 database_time_zone 无效，仅支持当前连接实例', errorCode: 'INVALID_ARGUMENTS' };
    }

    const start = normalizeOracleTimestamp(typedArgs.start_time);
    const end = normalizeOracleTimestamp(typedArgs.end_time);
    if (!start || !end) {
      return { success: false, status: 'error', error: 'start_time/end_time 必须是有效 ISO 日期时间，支持 Z、时区偏移和最多 9 位小数秒', errorCode: 'INVALID_ARGUMENTS' };
    }
    // Equal semantics can be checked before any DB access. Mixed inputs require
    // absolute times to be converted into the target database clock first.
    if (start.absolute === end.absolute) {
      const invalid = validateRange(start.order, end.order);
      if (invalid) return invalid;
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
          SYS_CONTEXT('USERENV', 'SERVICE_NAME'), SESSIONTIMEZONE, DBTIMEZONE,
          TO_CHAR(SYSTIMESTAMP, 'TZH:TZM')
         FROM V$DATABASE d CROSS JOIN V$INSTANCE i`
      );
      const row = identityResult.rows?.[0];
      const identity = Array.isArray(row) ? row : [];
      const [dbid, databaseName, instanceNumber, instanceName, serviceName,
        sessionTimezone, databaseTimezone, databaseHostOffset] = identity;
      if (!Number.isSafeInteger(dbid) || dbid <= 0 || !Number.isSafeInteger(instanceNumber) || instanceNumber <= 0
        || typeof databaseName !== 'string' || !databaseName || typeof instanceName !== 'string' || !instanceName) {
        return { success: false, status: 'error', error: '无法确认当前连接的 Oracle 数据库与实例身份', errorCode: 'ASH_IDENTITY_UNAVAILABLE' };
      }
      const hasAbsolute = start.absolute || end.absolute;
      const timezone = typedArgs.database_time_zone ?? databaseHostOffset;
      let wallStart = start;
      let wallEnd = end;
      if (hasAbsolute) {
        if (typeof timezone !== 'string' || !timezone) {
          return { success: false, status: 'error', error: '无法确定数据库主机时区，请提供 database_time_zone', errorCode: 'ASH_TIME_ZONE_UNAVAILABLE' };
        }
        // All values, including timezone names, are binds. Oracle's timezone
        // files apply historical region rules, independently of API/session TZ.
        const expression = (absolute: boolean, bind: string) => absolute
          ? `TO_CHAR(TO_TIMESTAMP_TZ(:${bind}, 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM') AT TIME ZONE (:b_timezone), 'YYYY-MM-DD HH24:MI:SS.FF9')`
          : `:${bind}`;
        const converted = await oracleConnection.execute(
          `SELECT ${expression(start.absolute, 'b_start')} AS start_wall, ${expression(end.absolute, 'b_end')} AS end_wall FROM dual`,
          { b_start: start.value, b_end: end.value, b_timezone: timezone }
        );
        const convertedRow = converted.rows?.[0];
        const convertedStart = normalizeOracleTimestamp(Array.isArray(convertedRow) ? convertedRow[0] : undefined);
        const convertedEnd = normalizeOracleTimestamp(Array.isArray(convertedRow) ? convertedRow[1] : undefined);
        if (!convertedStart || !convertedEnd || convertedStart.absolute || convertedEnd.absolute) {
          return { success: false, status: 'error', error: '数据库时间转换未返回有效墙钟范围', errorCode: 'ASH_TIME_CONVERSION_FAILED' };
        }
        wallStart = convertedStart;
        wallEnd = convertedEnd;
      }
      if (start.absolute !== end.absolute) {
        const invalid = validateRange(wallStart.order, wallEnd.order);
        if (invalid) return invalid;
      }
      if (wallEnd.order <= wallStart.order) {
        return { success: false, status: 'error', error: '转换后的数据库墙钟范围不递增；Oracle ASH DATE 接口不能区分夏令时回拨重叠时刻', errorCode: 'INVALID_ARGUMENTS' };
      }
      // ASH accepts DATE (whole seconds): cover the requested fractional range,
      // and disclose the effective bounds rather than silently discarding it.
      const effectiveStart = formatWholeSecond(wallStart.order, false);
      const effectiveEnd = formatWholeSecond(wallEnd.order, true);
      const metadata = {
        format: 'html',
        instance_id: typedArgs.instance_id,
        dbid,
        database_name: databaseName,
        instance_number: instanceNumber,
        instance_name: instanceName,
        service_name: serviceName,
        target_strategy: 'connected_instance',
        time_semantics: 'database_wall_clock',
        session_timezone: sessionTimezone,
        database_timezone: databaseTimezone,
        database_host_current_offset: databaseHostOffset,
        conversion_time_zone: hasAbsolute ? timezone : null,
        conversion_time_zone_source: hasAbsolute ? (typedArgs.database_time_zone ? 'caller_database_time_zone' : 'database_host_current_offset') : null,
        start_input_semantics: start.absolute ? 'absolute' : 'database_wall_clock',
        end_input_semantics: end.absolute ? 'absolute' : 'database_wall_clock',
        requested_start_time: typedArgs.start_time,
        requested_end_time: typedArgs.end_time,
        converted_start_time: wallStart.value,
        converted_end_time: wallEnd.value,
        precision_policy: 'outward_to_seconds',
        start_time: effectiveStart,
        end_time: effectiveEnd,
        time_zone_note: hasAbsolute && !typedArgs.database_time_zone
          ? '绝对时刻按数据库主机当前偏移转换；历史范围涉及夏令时或主机时区变更时，请提供实际 database_time_zone 区域名' : null,
      };

      // 执行 ASH 报告查询 (D-11: 保留 Oracle 原生 HTML 格式)
      const result = await oracleConnection.execute(
        `SELECT * FROM TABLE(DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML(
          l_dbid => :b_dbid,
          l_inst_num => :b_instance_number,
          l_btime => TO_DATE(:b_start_time, 'FXYYYY-MM-DD HH24:MI:SS'),
          l_etime => TO_DATE(:b_end_time, 'FXYYYY-MM-DD HH24:MI:SS')
        ))`,
        { b_dbid: dbid, b_instance_number: instanceNumber, b_start_time: effectiveStart, b_end_time: effectiveEnd }
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
        summary: `✅ ASH 报告生成完成（${databaseName}/${instanceName}，实例号 ${instanceNumber}；数据库墙钟 ${effectiveStart} ~ ${effectiveEnd}）`,
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

function normalizeOracleTimestamp(value: unknown): { value: string; order: bigint; absolute: boolean } | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(part => Number(part ?? 0));
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  // UTC is only a calendar/range arithmetic frame here, never a timezone conversion.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const fraction = (match[7] ?? '').padEnd(9, '0');
  const zone = match[8];
  const offset = zone?.toUpperCase() === 'Z' ? '+00:00' : zone?.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const offsetHour = Number(offset?.slice(1, 3) ?? 0);
  const offsetMinute = Number(offset?.slice(4, 6) ?? 0);
  if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  const offsetNanos = BigInt((offsetHour * 60 + offsetMinute) * (offset?.[0] === '-' ? -1 : 1)) * 60_000_000_000n;
  const millis = calendar.getTime() - Number(offsetNanos / 1_000_000n);
  const wall = `${new Date(millis).toISOString().slice(0, 19).replace('T', ' ')}.${fraction}`;
  return { value: wall + (offset ? ' +00:00' : ''), order: BigInt(millis) * 1_000_000n + BigInt(fraction), absolute: Boolean(offset) };
}

function validateRange(start: bigint, end: bigint) {
  if (end <= start) return { success: false, status: 'error' as const, error: 'end_time 必须晚于 start_time', errorCode: 'INVALID_ARGUMENTS' };
  if (end - start > 604_800_000_000_000n) return { success: false, status: 'error' as const, error: 'ASH 时间范围不能超过 7 天', errorCode: 'TIME_RANGE_TOO_LARGE' };
  return null;
}

function formatWholeSecond(nanos: bigint, roundUp: boolean): string {
  const second = 1_000_000_000n;
  const floor = nanos / second - (nanos < 0n && nanos % second !== 0n ? 1n : 0n);
  const rounded = floor + (roundUp && nanos % second !== 0n ? 1n : 0n);
  return new Date(Number(rounded * 1000n)).toISOString().slice(0, 19).replace('T', ' ');
}

// 注册工具
toolCatalog.register(oracleAshReportTool);
