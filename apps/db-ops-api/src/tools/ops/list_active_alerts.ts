/**
 * list_active_alerts — 列出活跃告警，支持按严重级别和时间过滤
 *
 * RBAC: 当调用方提供 request context（userId）时，只返回用户有权限访问的实例的告警。
 *       无 context 时（service account 方式）返回所有告警，向后兼容。
 */
import type { AnyAgentTool } from '../types.js';
import { toolCatalog } from '../catalog.js';
import { alertDatabaseService } from '../../alert-database-service.js';
import { RbacService } from '../../auth/rbac-service.js';

const rbacService = new RbacService();

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
  handler: async (args, context) => {
    try {
      if (!context?.actor) {
        return { success: false, status: 'error', error: '缺少已认证的操作员上下文', errorCode: 'MISSING_ACTOR' };
      }
      const typedArgs = args as {
        severity?: string;
        since?: string;
        limit?: number;
      };

      const severity = typedArgs.severity?.toLowerCase();
      const since = typedArgs.since;
      const validSeverities = new Set(['critical', 'error', 'warning', 'info']);
      if (severity !== undefined && !validSeverities.has(severity)) {
        return { success: false, status: 'error', error: 'severity 必须为 critical、error、warning 或 info', errorCode: 'INVALID_ARGUMENTS' };
      }
      let sinceDate: Date | undefined;
      if (since !== undefined) {
        sinceDate = new Date(since);
        if (Number.isNaN(sinceDate.getTime())) {
          return { success: false, status: 'error', error: 'since 必须是有效的 ISO 时间', errorCode: 'INVALID_ARGUMENTS' };
        }
      }
      const limit = typedArgs.limit === undefined ? 20 : typedArgs.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return { success: false, status: 'error', error: 'limit 必须为 1-100 的整数', errorCode: 'INVALID_ARGUMENTS' };
      }

      // 获取告警列表（alertDatabaseService.getAlerts 支持 level/limit 过滤）
      const alerts = await alertDatabaseService.getAlerts({
        level: severity,
        limit,
      });

      // 应用 since 时间过滤（getAlerts 不支持 since 参数，在此做内存过滤）
      let filtered = alerts;
      if (sinceDate) {
        filtered = alerts.filter((a: any) => {
            const createdAt = new Date(a.created_at);
            return createdAt >= sinceDate;
        });
      }

      // RBAC 过滤：根据用户权限缩小可见告警范围
      if (context?.userId) {
        const userInstances = await rbacService.getUserInstanceAccess(context.userId);
        const allowedIds = new Set(userInstances.map(ui => ui.instance_id));
        filtered = filtered.filter((a: any) => allowedIds.has(a.instance_id));
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
        status: 'success',
        data: {
          total: summaries.length,
          alerts: summaries,
        },
        summary: `找到 ${summaries.length} 条活跃告警`,
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
