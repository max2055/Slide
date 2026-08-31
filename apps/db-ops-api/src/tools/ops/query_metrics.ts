/**
 * query_metrics — 查询实例指标数据（实时快照或历史趋势）
 */
import type { AnyAgentTool, ToolResult } from '../types.js';
import { toolCatalog } from '../catalog.js';
import { metricsDatabaseService } from '../../metrics-database-service.js';
import { metricRegistry } from '../../metric-registry.js';
import { instanceDatabaseService } from '../../instance-database-service.js';

export const queryMetricsTool: AnyAgentTool = {
  name: 'query_metrics',
  description:
    '查询数据库实例的指标数据。支持实时快照和历史趋势两种模式。' +
    '可用指标包括：qps（每秒查询数）、tps（每秒事务数）、cpu_usage（CPU使用率）、' +
    'memory_usage（内存使用率）、disk_usage（磁盘使用率）、connections（活跃连接数）、' +
    'slow_queries（慢查询数）、buffer_pool_hit_rate（缓冲池命中率）等。',
  parameters: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'number',
        description: '实例 ID（必填）',
      },
      mode: {
        type: 'string',
        description: '查询模式：realtime（实时快照，默认）或 history（历史趋势）',
        enum: ['realtime', 'history'],
      },
      metric_ids: {
        type: 'array',
        items: { type: 'string' },
        description: '要查询的指标 ID 列表（可选，不传则返回所有常用指标）。例如 ["qps", "cpu_usage", "connections"]',
      },
      period: {
        type: 'string',
        description: '历史查询的时间范围（仅 mode=history 时有效）：1h、6h、24h（默认）、7d',
        enum: ['1h', '6h', '24h', '7d'],
      },
      interval: {
        type: 'string',
        description: '历史查询的聚合粒度（仅 mode=history 时有效）：1m、5m、15m、1h。默认根据 period 自动选择',
        enum: ['1m', '5m', '15m', '1h'],
      },
    },
    required: ['instance_id'],
  },
  group: 'db_ops',
  handler: async (args) => {
    try {
      const typedArgs = args as {
        instance_id: number;
        mode?: 'realtime' | 'history';
        metric_ids?: string[];
        period?: '1h' | '6h' | '24h' | '7d';
        interval?: '1m' | '5m' | '15m' | '1h';
      };

      const instanceId = typedArgs.instance_id;
      const mode = typedArgs.mode || 'realtime';
      if (!Number.isSafeInteger(instanceId) || instanceId <= 0) {
        return { success: false, status: 'error', error: 'instance_id 必须为正整数', errorCode: 'INVALID_ARGUMENTS' };
      }
      if (mode !== 'realtime' && mode !== 'history') {
        return { success: false, status: 'error', error: 'mode 必须为 realtime 或 history', errorCode: 'INVALID_ARGUMENTS' };
      }
      if (typedArgs.metric_ids !== undefined && (!Array.isArray(typedArgs.metric_ids) || typedArgs.metric_ids.length > 32 || typedArgs.metric_ids.some((id) => typeof id !== 'string' || !/^[a-z][a-z0-9_]{1,80}$/.test(id)))) {
        return { success: false, status: 'error', error: 'metric_ids 必须是最多 32 个合法指标 ID', errorCode: 'INVALID_ARGUMENTS' };
      }
      const unknownMetric = typedArgs.metric_ids?.find((id) => !metricRegistry.getById(id));
      if (unknownMetric) {
        return { success: false, status: 'error', error: `未知指标 ID：${unknownMetric}`, errorCode: 'UNKNOWN_METRIC', next_actions: ['先使用已支持的指标 ID 重试'] };
      }
      const validPeriods = new Set(['1h', '6h', '24h', '7d']);
      const validIntervals = new Set(['1m', '5m', '15m', '1h']);
      if (typedArgs.period !== undefined && !validPeriods.has(typedArgs.period)) {
        return { success: false, status: 'error', error: 'period 无效', errorCode: 'INVALID_ARGUMENTS' };
      }
      if (typedArgs.interval !== undefined && !validIntervals.has(typedArgs.interval)) {
        return { success: false, status: 'error', error: 'interval 无效', errorCode: 'INVALID_ARGUMENTS' };
      }

      // Resolve instance name for context
      const inst = await instanceDatabaseService.getInstanceById(instanceId);
      if (!inst) {
        return { success: false, status: 'error', error: `未找到实例 ID=${instanceId}`, errorCode: 'INSTANCE_NOT_FOUND', next_actions: ['先调用 list_database_instances 获取有效实例 ID'] };
      }
      const instanceName = inst.name;
      const instanceDbType = inst.db_type || 'unknown';

      if (mode === 'history') {
        return await queryHistory(instanceId, instanceName, instanceDbType, typedArgs);
      }
      return await queryRealtime(instanceId, instanceName, instanceDbType, typedArgs);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `指标查询失败：${errorMessage}`,
        errorCode: 'QUERY_METRICS_FAILED',
      };
    }
  },
};

// ── Realtime mode ──

async function queryRealtime(
  instanceId: number,
  instanceName: string,
  instanceDbType: string,
  args: { metric_ids?: string[] },
): Promise<ToolResult> {
  const read = await metricsDatabaseService.getRealtimeMetricsWithStatus(instanceId);

  if (!read.available) {
    return {
      success: false,
      status: 'error',
      errorCode: read.errorCode,
      error: '指标存储当前不可用，未能读取实时指标',
      next_actions: ['检查指标数据库连接和服务状态，恢复后重试 query_metrics'],
    };
  }
  const record = read.data;

  if (!record) {
    return {
      success: true,
      status: 'warning',
      data: {
        instance_id: instanceId,
        instance_name: instanceName,
        mode: 'realtime',
        metrics: null,
        message: `实例 "${instanceName}" 暂无指标数据，可能采集尚未开始或连接不可用`,
      },
      summary: `实例 "${instanceName}" 暂无实时指标`,
      next_actions: ['确认采集任务和数据库连接状态；稍后重试 query_metrics'],
    };
  }

  // Always include recorded_at for context
  const filtered = filterMetrics(record as any, args.metric_ids);

  return {
    success: true,
    status: 'success',
    data: {
      instance_id: instanceId,
      instance_name: instanceName,
      db_type: instanceDbType,
      mode: 'realtime',
      recorded_at: record.recorded_at,
      metrics: filtered,
    },
    summary: `已获取实例 "${instanceName}" 的实时指标`,
  };
}

// ── History mode ──

function autoInterval(period: string): '1m' | '5m' | '15m' | '1h' {
  if (period === '1h') return '1m';
  if (period === '6h') return '5m';
  if (period === '24h') return '15m';
  return '1h'; // 7d
}

async function queryHistory(
  instanceId: number,
  instanceName: string,
  instanceDbType: string,
  args: { metric_ids?: string[]; period?: '1h' | '6h' | '24h' | '7d'; interval?: '1m' | '5m' | '15m' | '1h' },
): Promise<ToolResult> {
  const period = args.period || '24h';
  const interval = args.interval || autoInterval(period);

  const read = await metricsDatabaseService.getHistoricalMetricsWithRangeStatus(
    instanceId,
    period,
    interval,
    args.metric_ids,
  );

  if (!read.available) {
    return {
      success: false,
      status: 'error',
      errorCode: read.errorCode,
      error: '指标存储当前不可用，未能读取历史指标',
      next_actions: ['检查指标数据库连接和服务状态，恢复后重试 query_metrics'],
    };
  }
  const result = read.data;

  if (!result || result.time.length === 0) {
    return {
      success: true,
      status: 'warning',
      data: {
        instance_id: instanceId,
        instance_name: instanceName,
        mode: 'history',
        period,
        interval,
        data_points: 0,
        metrics: {},
        message: `实例 "${instanceName}" 在过去 ${period} 内无历史数据`,
      },
      summary: `实例 "${instanceName}" 在 ${period} 内暂无历史指标`,
      next_actions: ['确认采集任务已运行或扩大查询时间范围'],
    };
  }

  // Attach metric definitions for interpretation
  const metricDefs: Record<string, { name: string; unit: string; threshold_template: unknown }> = {};
  for (const id of Object.keys(result.metrics)) {
    const def = metricRegistry.getById(id);
    if (def) {
      metricDefs[id] = {
        name: def.name,
        unit: def.unit,
        threshold_template: def.threshold_template,
      };
    }
  }

  // Compute summary stats for each metric
  const summaries: Record<string, { min: number; max: number; avg: number; latest: number }> = {};
  for (const [key, values] of Object.entries(result.metrics)) {
    if (values.length === 0) continue;
    const nums = values.filter((v) => typeof v === 'number' && !isNaN(v));
    if (nums.length === 0) continue;
    summaries[key] = {
      min: Math.round(Math.min(...nums) * 100) / 100,
      max: Math.round(Math.max(...nums) * 100) / 100,
      avg: Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100,
      latest: Math.round(nums[nums.length - 1] * 100) / 100,
    };
  }

  // Return condensed view: time array + metric arrays + summaries + definitions
  // Limit time array to 200 points max to keep response manageable
  const maxPoints = 200;
  const skip = result.time.length > maxPoints ? Math.ceil(result.time.length / maxPoints) : 1;
  const time = skip > 1 ? result.time.filter((_, i) => i % skip === 0) : result.time;
  const metrics: Record<string, number[]> = {};
  for (const [key, values] of Object.entries(result.metrics)) {
    metrics[key] = skip > 1 ? values.filter((_, i) => i % skip === 0) : values;
  }

  return {
    success: true,
    status: 'success',
    data: {
      instance_id: instanceId,
      instance_name: instanceName,
      db_type: instanceDbType,
      mode: 'history',
      period,
      interval,
      data_points: result.time.length,
      returned_points: time.length,
      time_range: { start: time[0], end: time[time.length - 1] },
      time,
      metrics,
      summaries,
      definitions: metricDefs,
    },
  };
}

// ── Helpers ──

const DEFAULT_METRIC_IDS = [
  'qps', 'tps', 'cpu_usage', 'memory_usage', 'disk_usage',
  'connections', 'slow_queries', 'buffer_pool_hit_rate',
];

function filterMetrics(
  record: Record<string, unknown>,
  metricIds?: string[],
): Record<string, number> {
  const ids = metricIds && metricIds.length > 0 ? metricIds : DEFAULT_METRIC_IDS;
  const result: Record<string, number> = {};

  for (const id of ids) {
    const val = record[id];
    if (typeof val === 'number') {
      result[id] = Math.round(val * 100) / 100;
    } else if (record.metrics_data && typeof record.metrics_data === 'object') {
      const extra = (record.metrics_data as Record<string, unknown>)[id];
      if (typeof extra === 'number') {
        result[id] = Math.round(extra * 100) / 100;
      }
    }
    // Also check for dedicated extended columns (e.g. dead_tuples, replication_lag_seconds)
  }

  return result;
}

toolCatalog.register(queryMetricsTool);
