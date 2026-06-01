/**
 * list_active_alerts — 列出活跃告警，支持按严重级别和时间过滤
 */
// TODO(D-08): Add RBAC user-context scope when available. Current: queries all data the service account can see.
import type { AnyAgentTool } from '../types.js';
import { toolCatalog } from '../catalog.js';
import { alertDatabaseService } from '../../alert-database-service.js';

export const listActiveAlertsTool: AnyAgentTool = {
  name: 'list_active_alerts',
  description: '列出当前活跃的数据库告警，支持按严重级别和时间范围过滤',
  parameters: {
    type: 'object',
    properties: {
      severity: {
        type: 'string',
        description: '严重级别过滤：critical, error, warning, info（可选，不传则返回所有级别）',
      },
      since: {
        type: 'string',
        description: '起始时间 ISO 字符串（可选，如 2026-05-01T00:00:00Z）',
      },
      limit: {
        type: 'number',
        description: '返回条数上限（可选，默认 20）',
      },
    },
    required: [],
  },
  group: 'db_ops',
  handler: async (args) => {
    try {
      const typedArgs = args as {
        severity?: string;
        since?: string;
        limit?: number;
      };

      const severity = typedArgs.severity?.toLowerCase();
      const since = typedArgs.since;
      const limit = typeof typedArgs.limit === 'number' && typedArgs.limit > 0
        ? typedArgs.limit
        : 20;

      // 获取告警列表（alertDatabaseService.getAlerts 支持 level/limit 过滤）
      const alerts = await alertDatabaseService.getAlerts({
        level: severity,
        limit,
      });

      // 应用 since 时间过滤（getAlerts 不支持 since 参数，在此做内存过滤）
      let filtered = alerts;
      if (since) {
        const sinceDate = new Date(since);
        if (!isNaN(sinceDate.getTime())) {
          filtered = alerts.filter((a: any) => {
            const createdAt = new Date(a.created_at);
            return createdAt >= sinceDate;
          });
        }
      }

      // 返回摘要数据
      const summaries = filtered.map((a: any) => ({
        id: a.id,
        level: a.severity || a.level,
        title: a.title,
        instance_id: a.instance_id,
        instance_name: a.instance_name,
        created_at: a.created_at,
        status: a.status,
      }));

      return {
        success: true,
        data: {
          total: summaries.length,
          alerts: summaries,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `查询告警列表失败: ${error.message}`,
      };
    }
  },
};

toolCatalog.register(listActiveAlertsTool);
