/**
 * get_instance_summary — 获取数据库实例健康摘要（单个或全部）
 *
 * RBAC: 当调用方提供 request context（userId）时，只返回用户有权限访问的实例。
 *       无 context 时（service account 方式）返回所有实例，向后兼容。
 */
import type { AnyAgentTool } from '../types.js';
import { toolCatalog } from '../catalog.js';
import { instanceDatabaseService } from '../../instance-database-service.js';
import { RbacService } from '../../auth/rbac-service.js';

const rbacService = new RbacService();

export const getInstanceSummaryTool: AnyAgentTool = {
  name: 'get_instance_summary',
  description: '获取数据库实例健康摘要，支持查询单个实例或所有实例',
  parameters: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'number',
        description: '实例 ID（可选，不传则返回所有实例摘要）',
      },
    },
    required: [],
  },
  group: 'db_ops',
  handler: async (args, context) => {
    try {
      const typedArgs = args as {
        instance_id?: number;
      };

      if (typedArgs.instance_id !== undefined) {
        if (!Number.isSafeInteger(typedArgs.instance_id) || typedArgs.instance_id <= 0) {
          return { success: false, status: 'error', error: 'instance_id 必须为正整数', errorCode: 'INVALID_ARGUMENTS' };
        }
        // 查询单个实例 — 检查用户是否有权限访问
        if (context?.userId) {
          const userInstances = await rbacService.getUserInstanceAccess(context.userId);
          const hasAccess = userInstances.some(ui => ui.instance_id === typedArgs.instance_id);
          if (!hasAccess) {
            return { success: false, status: 'error', error: '无权访问该数据库实例', errorCode: 'INSTANCE_SCOPE_DENIED' };
          }
        }

        const instance = await instanceDatabaseService.getInstanceById(typedArgs.instance_id);

        if (!instance) {
          return { success: false, status: 'error', error: `未找到实例 ID=${typedArgs.instance_id}`, errorCode: 'INSTANCE_NOT_FOUND', next_actions: ['先调用 list_database_instances 获取有效实例 ID'] };
        }

        const summary: Record<string, any> = {
          id: instance.id,
          name: instance.name,
          db_type: instance.db_type,
          status: instance.status,
          host: instance.host,
          port: instance.port,
          health_score: instance.health_score,
          health_status: instance.health_status,
        };

        return {
          success: true,
          status: 'success',
          data: {
            count: 1,
            instances: [summary],
          },
        };
      }

      // 查询所有实例
      let instances = await instanceDatabaseService.getAllInstances();

      // RBAC 过滤：根据用户权限缩小可见实例范围
      if (context?.userId) {
        const userInstances = await rbacService.getUserInstanceAccess(context.userId);
        const allowedIds = new Set(userInstances.map(ui => ui.instance_id));
        instances = instances.filter((inst: any) => allowedIds.has(inst.id));
      }

      const summaries = instances.map((inst: any) => ({
        id: inst.id,
        name: inst.name,
        db_type: inst.db_type,
        status: inst.status,
        host: inst.host,
        port: inst.port,
        health_score: inst.health_score,
        health_status: inst.health_status,
      }));

      return {
        success: true,
        status: 'success',
        data: {
          count: summaries.length,
          instances: summaries,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        status: 'error',
        error: `获取实例摘要失败: ${error.message}`,
        errorCode: 'INSTANCE_SUMMARY_FAILED',
        next_actions: ['检查后端数据库连接后重试'],
      };
    }
  },
};

toolCatalog.register(getInstanceSummaryTool);
