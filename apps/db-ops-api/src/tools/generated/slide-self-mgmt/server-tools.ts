/**
 * 服务器管理 AI 分析工具集
 *
 * Agent 工具：list_server_instances, get_server_metrics,
 * get_server_alerts, analyze_server_health
 *
 * 用途：Agent 可以在对话中查询服务器状态、指标、告警信息，
 * 以及生成结构化的健康诊断分析。
 */

import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { serverDatabaseService } from '../../../server-database-service.js';
import { alertDatabaseService } from '../../../alert-database-service.js';
import { dbConnection } from '../../../db-connection.js';

// ============== 类型定义 ==============

/**
 * 最新指标摘要
 */
interface MetricsSummary {
  cpu_usage: number | null;
  memory_usage: number | null;
  disk_usage: number | null;
  load_1min: number | null;
  uptime: number | null;
  recorded_at: string | null;
}

/**
 * 指标记录点
 */
interface ServerMetricPoint {
  metric_name: string;
  metric_value: number;
  recorded_at: string;
}

/**
 * 告警信息
 */
interface ServerAlertInfo {
  id: number;
  level: string;
  title: string;
  message: string;
  status: string;
  created_at: string;
  instance_id: number | null;
  instance_name: string;
}

/**
 * 健康分析结果
 */
interface HealthAnalysis {
  overall_health: 'healthy' | 'warning' | 'critical' | 'unknown';
  cpu_analysis: MetricAnalysis;
  memory_analysis: MetricAnalysis;
  disk_analysis: MetricAnalysis;
  recommendations: string[];
}

interface MetricAnalysis {
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  current_value: number | null;
  threshold_warning: number;
  threshold_critical: number;
  message: string;
}

// ============== 数据库辅助函数 ==============

/**
 * 获取指定服务器的最新指标摘要
 */
async function getLatestMetrics(serverId: number): Promise<MetricsSummary> {
  const pool = dbConnection.getPool();
  if (!pool) {
    return {
      cpu_usage: null, memory_usage: null, disk_usage: null,
      load_1min: null, uptime: null, recorded_at: null,
    };
  }

  try {
    const metricNames = ['cpu_usage', 'memory_usage', 'disk_usage', 'load_1min', 'uptime'];
    const results: MetricsSummary = {
      cpu_usage: null, memory_usage: null, disk_usage: null,
      load_1min: null, uptime: null, recorded_at: null,
    };
    let latestTime: string | null = null;

    for (const name of metricNames) {
      const [rows] = await pool.execute(
        `SELECT metric_value, recorded_at
         FROM server_metrics
         WHERE server_id = ? AND metric_name = ?
         ORDER BY recorded_at DESC
         LIMIT 1`,
        [serverId, name]
      ) as any;

      if (rows && rows.length > 0) {
        const row = rows[0];
        const key = name as keyof MetricsSummary;
        (results as any)[key] = Number(row.metric_value);
        if (!latestTime || row.recorded_at > latestTime) {
          latestTime = row.recorded_at;
        }
      }
    }

    results.recorded_at = latestTime;
    return results;
  } catch (error) {
    console.error(`获取服务器 #${serverId} 最新指标失败:`, error);
    return {
      cpu_usage: null, memory_usage: null, disk_usage: null,
      load_1min: null, uptime: null, recorded_at: null,
    };
  }
}

/**
 * 获取指定服务器的指标历史数据
 */
async function getMetricHistory(
  serverId: number,
  metricName?: string,
  range?: '1h' | '6h' | '24h' | '7d' | '30d'
): Promise<ServerMetricPoint[]> {
  const pool = dbConnection.getPool();
  if (!pool) return [];

  const rangeHours: Record<string, number> = {
    '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720,
  };

  const hours = range && range in rangeHours ? rangeHours[range] : 24;
  const since = new Date(Date.now() - hours * 3600000).toISOString().slice(0, 19).replace('T', ' ');

  try {
    let sql: string;
    const params: any[] = [serverId, since];

    if (metricName) {
      sql = `SELECT metric_name, metric_value, recorded_at
             FROM server_metrics
             WHERE server_id = ? AND recorded_at >= ? AND metric_name = ?
             ORDER BY recorded_at ASC`;
      params.push(metricName);
    } else {
      sql = `SELECT metric_name, metric_value, recorded_at
             FROM server_metrics
             WHERE server_id = ? AND recorded_at >= ?
             ORDER BY recorded_at ASC`;
    }

    const [rows] = await pool.execute(sql, params) as any;
    return (rows || []).map((row: any) => ({
      metric_name: row.metric_name,
      metric_value: Number(row.metric_value),
      recorded_at: new Date(row.recorded_at).toISOString(),
    }));
  } catch (error) {
    console.error(`获取服务器 #${serverId} 指标历史失败:`, error);
    return [];
  }
}

/**
 * 获取所有服务器的最新指标摘要（批量查询优化）
 */
async function getAllServersLatestMetrics(): Promise<Map<number, MetricsSummary>> {
  const pool = dbConnection.getPool();
  if (!pool) return new Map();

  try {
    const metricNames = ['cpu_usage', 'memory_usage', 'disk_usage', 'load_1min', 'uptime'];
    const result = new Map<number, MetricsSummary>();

    for (const name of metricNames) {
      const [rows] = await pool.execute(
        `SELECT m1.server_id, m1.metric_value, m1.recorded_at
         FROM server_metrics m1
         INNER JOIN (
           SELECT server_id, MAX(recorded_at) AS max_time
           FROM server_metrics
           WHERE metric_name = ?
           GROUP BY server_id
         ) m2 ON m1.server_id = m2.server_id AND m1.recorded_at = m2.max_time
         WHERE m1.metric_name = ?`,
        [name, name]
      ) as any;

      if (rows) {
        for (const row of rows) {
          let entry = result.get(row.server_id);
          if (!entry) {
            entry = {
              cpu_usage: null, memory_usage: null, disk_usage: null,
              load_1min: null, uptime: null, recorded_at: null,
            };
            result.set(row.server_id, entry);
          }
          const key = name as keyof MetricsSummary;
          (entry as any)[key] = Number(row.metric_value);
          if (!entry.recorded_at || row.recorded_at > entry.recorded_at) {
            entry.recorded_at = row.recorded_at;
          }
        }
      }
    }

    return result;
  } catch (error) {
    console.error('批量获取服务器最新指标失败:', error);
    return new Map();
  }
}

/**
 * 分析单项指标的健康状态
 */
function analyzeMetric(
  currentValue: number | null,
  metricName: string,
  thresholds: { warning: number; critical: number },
  unit: string = '%'
): MetricAnalysis {
  if (currentValue === null) {
    return {
      status: 'unknown',
      current_value: null,
      threshold_warning: thresholds.warning,
      threshold_critical: thresholds.critical,
      message: `${metricName}：无可用数据`,
    };
  }

  if (currentValue >= thresholds.critical) {
    return {
      status: 'critical',
      current_value: currentValue,
      threshold_warning: thresholds.warning,
      threshold_critical: thresholds.critical,
      message: `${metricName}：${currentValue}${unit}（严重，阈值 ${thresholds.critical}${unit}）`,
    };
  }

  if (currentValue >= thresholds.warning) {
    return {
      status: 'warning',
      current_value: currentValue,
      threshold_warning: thresholds.warning,
      threshold_critical: thresholds.critical,
      message: `${metricName}：${currentValue}${unit}（警告，阈值 ${thresholds.warning}${unit}）`,
    };
  }

  return {
    status: 'healthy',
    current_value: currentValue,
    threshold_warning: thresholds.warning,
    threshold_critical: thresholds.critical,
    message: `${metricName}：${currentValue}${unit}（正常）`,
  };
}

// ============== Tool 1: list_server_instances ==============

export const listServerInstancesTool: AnyAgentTool = {
  name: 'list_server_instances',
  description: '列出所有已纳管的服务器及其基本信息和健康状态。返回每台服务器的 ID、主机地址、标签、端口、OS 类型、状态（online/offline/error/unreachable）、最后检查时间和最新 CPU/内存/磁盘使用率。用于查询服务器概览。',
  parameters: {
    type: 'object',
    properties: {},
  },
  group: 'slide_self_mgmt',
  handler: async () => {
    try {
      const servers = await serverDatabaseService.getAllServers();
      const latestMetrics = await getAllServersLatestMetrics();

      const items = servers.map(server => {
        const metrics = latestMetrics.get(server.id) || {
          cpu_usage: null, memory_usage: null, disk_usage: null,
          load_1min: null, uptime: null, recorded_at: null,
        };

        return {
          id: server.id,
          host: server.host,
          label: server.label,
          port: server.port,
          os_type: server.os_type,
          status: server.status,
          last_check_at: server.last_check_at
            ? new Date(server.last_check_at).toISOString()
            : null,
          metrics_summary: {
            cpu_usage: metrics.cpu_usage,
            memory_usage: metrics.memory_usage,
            disk_usage: metrics.disk_usage,
            recorded_at: metrics.recorded_at,
          },
        };
      });

      return {
        success: true,
        data: items,
        summary: `找到 ${items.length} 台服务器`,
        details: {
          count: items.length,
          online_count: items.filter(s => s.status === 'online').length,
          servers: items,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `获取服务器列表失败：${errorMessage}`,
        errorCode: 'LIST_SERVERS_FAILED',
      };
    }
  },
};

// ============== Tool 2: get_server_metrics ==============

export const getServerMetricsTool: AnyAgentTool = {
  name: 'get_server_metrics',
  description: '获取指定服务器的指标数据和历史趋势。可选的 metricName 参数可过滤特定指标（如 cpu_usage, memory_usage, disk_usage, load_1min, uptime）；range 参数指定历史范围（1h, 6h, 24h, 7d, 30d），不传则只返回最新指标。',
  parameters: {
    type: 'object',
    properties: {
      serverId: {
        type: 'number',
        description: '服务器 ID',
      },
      metricName: {
        type: 'string',
        description: '指标名称（可选）：cpu_usage, memory_usage, disk_usage, load_1min, uptime。不传则返回所有指标',
      },
      range: {
        type: 'string',
        description: '历史时间范围（可选）：1h, 6h, 24h, 7d, 30d。不传则只返回最新指标',
        enum: ['1h', '6h', '24h', '7d', '30d'],
      },
    },
    required: ['serverId'],
  },
  group: 'slide_self_mgmt',
  handler: async (args) => {
    const serverId = args.serverId as number;
    const metricName = args.metricName as string | undefined;
    const range = args.range as '1h' | '6h' | '24h' | '7d' | '30d' | undefined;

    if (typeof serverId !== 'number' || isNaN(serverId) || serverId <= 0) {
      return {
        success: false,
        error: '参数错误：serverId 必须为正整数',
        errorCode: 'INVALID_PARAMETER',
      };
    }

    try {
      const server = await serverDatabaseService.getServerById(serverId);
      if (!server) {
        return {
          success: false,
          error: `服务器 #${serverId} 不存在`,
          errorCode: 'SERVER_NOT_FOUND',
        };
      }

      // 获取最新指标
      const latestMetrics = await getLatestMetrics(serverId);

      // 获取历史数据（如果指定了 range）
      let history: ServerMetricPoint[] = [];
      if (range) {
        history = await getMetricHistory(serverId, metricName, range);
      }

      return {
        success: true,
        data: {
          server: {
            id: server.id,
            host: server.host,
            label: server.label,
            port: server.port,
            os_type: server.os_type,
            status: server.status,
          },
          latest_metrics: latestMetrics,
          history: history.length > 0 ? history : undefined,
          history_range: range || null,
        },
        summary: `服务器 ${server.label || server.host} 指标数据${range ? `（${range} 历史）` : ''}`,
        details: {
          server_id: serverId,
          metric_count: history.length > 0 ? new Set(history.map(h => h.metric_name)).size : 0,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `获取服务器指标失败：${errorMessage}`,
        errorCode: 'GET_METRICS_FAILED',
      };
    }
  },
};

// ============== Tool 3: get_server_alerts ==============

export const getServerAlertsTool: AnyAgentTool = {
  name: 'get_server_alerts',
  description: '获取与服务器相关的告警信息。返回告警的 ID、级别（critical/error/warning/info）、标题、消息、状态（unread/read/acknowledged/resolved/closed）和时间。可选 activeOnly 参数只返回未解决的告警。',
  parameters: {
    type: 'object',
    properties: {
      serverId: {
        type: 'number',
        description: '服务器 ID（用于关联告警上下文）',
      },
      activeOnly: {
        type: 'boolean',
        description: '是否只返回未解决的告警（默认 true）',
        default: true,
      },
      limit: {
        type: 'number',
        description: '返回条数上限（默认 20，最大 100）',
      },
    },
    required: ['serverId'],
  },
  group: 'slide_self_mgmt',
  handler: async (args) => {
    const serverId = args.serverId as number;
    const activeOnly = args.activeOnly !== false;
    const limit = Math.min(
      typeof args.limit === 'number' && args.limit > 0 ? args.limit : 20,
      100
    );

    if (typeof serverId !== 'number' || isNaN(serverId) || serverId <= 0) {
      return {
        success: false,
        error: '参数错误：serverId 必须为正整数',
        errorCode: 'INVALID_PARAMETER',
      };
    }

    try {
      const server = await serverDatabaseService.getServerById(serverId);
      if (!server) {
        return {
          success: false,
          error: `服务器 #${serverId} 不存在`,
          errorCode: 'SERVER_NOT_FOUND',
        };
      }

      // 查询系统告警（alerts 表使用 instance_id，没有 server_id 关联）
      // 返回最近的系统告警，Agent 可结合服务器上下文做关联分析
      const alertResult = await alertDatabaseService.getAlerts({
        status: activeOnly ? 'unread,read,acknowledged' : undefined,
        limit,
      });

      const items = (alertResult.items || []).map((alert: any) => ({
        id: alert.id,
        level: alert.severity || alert.level,
        title: alert.title,
        message: alert.message,
        status: alert.status,
        created_at: alert.created_at,
        instance_id: alert.instance_id,
        instance_name: alert.instance_name,
      }));

      return {
        success: true,
        data: {
          server_context: {
            id: server.id,
            host: server.host,
            label: server.label,
            status: server.status,
          },
          alerts: items,
          total: alertResult.total || items.length,
          unread: alertResult.unread || 0,
          critical: alertResult.critical || 0,
        },
        summary: `服务器 ${server.label || server.host} 相关告警：共 ${items.length} 条${activeOnly ? '（未解决）' : ''}`,
        details: {
          server_id: serverId,
          active_only: activeOnly,
          alert_count: items.length,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `获取告警信息失败：${errorMessage}`,
        errorCode: 'GET_ALERTS_FAILED',
      };
    }
  },
};

// ============== Tool 4: analyze_server_health ==============

export const analyzeServerHealthTool: AnyAgentTool = {
  name: 'analyze_server_health',
  description: '分析指定服务器的健康状态，生成诊断摘要。基于最新 CPU 使用率、内存使用率、磁盘使用率等指标，评估服务器整体健康水平并给出运维建议。',
  parameters: {
    type: 'object',
    properties: {
      serverId: {
        type: 'number',
        description: '服务器 ID',
      },
    },
    required: ['serverId'],
  },
  group: 'slide_self_mgmt',
  handler: async (args) => {
    const serverId = args.serverId as number;

    if (typeof serverId !== 'number' || isNaN(serverId) || serverId <= 0) {
      return {
        success: false,
        error: '参数错误：serverId 必须为正整数',
        errorCode: 'INVALID_PARAMETER',
      };
    }

    try {
      const server = await serverDatabaseService.getServerById(serverId);
      if (!server) {
        return {
          success: false,
          error: `服务器 #${serverId} 不存在`,
          errorCode: 'SERVER_NOT_FOUND',
        };
      }

      const metrics = await getLatestMetrics(serverId);

      // 分析各项指标
      const cpuAnalysis = analyzeMetric(metrics.cpu_usage, 'CPU 使用率', { warning: 70, critical: 85 });
      const memoryAnalysis = analyzeMetric(metrics.memory_usage, '内存使用率', { warning: 70, critical: 85 });
      const diskAnalysis = analyzeMetric(metrics.disk_usage, '磁盘使用率', { warning: 80, critical: 90 });

      // 计算整体健康状态
      const statuses = [cpuAnalysis.status, memoryAnalysis.status, diskAnalysis.status];
      let overallHealth: 'healthy' | 'warning' | 'critical' | 'unknown';

      if (statuses.every(s => s === 'unknown')) {
        overallHealth = 'unknown';
      } else if (statuses.some(s => s === 'critical')) {
        overallHealth = 'critical';
      } else if (statuses.some(s => s === 'warning')) {
        overallHealth = 'warning';
      } else if (statuses.some(s => s === 'healthy')) {
        overallHealth = 'healthy';
      } else {
        overallHealth = 'unknown';
      }

      // 生成运维建议
      const recommendations: string[] = [];

      if (cpuAnalysis.status === 'critical') {
        recommendations.push(`CPU 使用率 ${metrics.cpu_usage}% 已达严重级别，建议立即检查是否有异常进程或扩容 CPU`);
      } else if (cpuAnalysis.status === 'warning') {
        recommendations.push(`CPU 使用率 ${metrics.cpu_usage}% 偏高，建议监控趋势并评估是否需要扩容`);
      }

      if (memoryAnalysis.status === 'critical') {
        recommendations.push(`内存使用率 ${metrics.memory_usage}% 已达严重级别，建议检查内存泄漏并扩容`);
      } else if (memoryAnalysis.status === 'warning') {
        recommendations.push(`内存使用率 ${metrics.memory_usage}% 偏高，建议关注占用并考虑扩容`);
      }

      if (diskAnalysis.status === 'critical') {
        recommendations.push(`磁盘使用率 ${metrics.disk_usage}% 已达严重级别，建议清理磁盘或扩容`);
      } else if (diskAnalysis.status === 'warning') {
        recommendations.push(`磁盘使用率 ${metrics.disk_usage}% 偏高，建议定期清理或扩容`);
      }

      if (server.status === 'offline' || server.status === 'error') {
        recommendations.push(`服务器状态为 "${server.status}"，请检查网络或 SSH 连接`);
      }

      if (recommendations.length === 0 && overallHealth === 'healthy') {
        recommendations.push('所有指标正常，无需操作');
      }

      const analysis: HealthAnalysis = {
        overall_health: overallHealth,
        cpu_analysis: cpuAnalysis,
        memory_analysis: memoryAnalysis,
        disk_analysis: diskAnalysis,
        recommendations,
      };

      return {
        success: true,
        data: analysis,
        summary: `服务器 ${server.label || server.host} 健康状态：${translateHealth(overallHealth)}`,
        details: {
          server_id: serverId,
          server_host: server.host,
          server_label: server.label,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `分析服务器健康失败：${errorMessage}`,
        errorCode: 'HEALTH_ANALYSIS_FAILED',
      };
    }
  },
};

// ============== 辅助函数 ==============

function translateHealth(status: string): string {
  const map: Record<string, string> = {
    healthy: '健康',
    warning: '警告',
    critical: '严重',
    unknown: '未知',
  };
  return map[status] || status;
}

// ============== 注册工具 ==============

toolCatalog.register(listServerInstancesTool);
toolCatalog.register(getServerMetricsTool);
toolCatalog.register(getServerAlertsTool);
toolCatalog.register(analyzeServerHealthTool);
