/**
 * 列出所有数据库实例
 *
 * 返回所有活跃实例的基本信息，不包含密码。
 * Agent 可以使用此工具了解可用的数据库实例。
 */

import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { canReadResource } from '../../../resources/resource-service.js';

export const listDatabaseInstancesTool: AnyAgentTool = {
  name: 'list_database_instances',
  description: '列出所有数据库实例的基本信息（id, name, db_type, host, port, health_status, environment）。用于获取可用实例列表和实例 ID。不返回密码等敏感信息。',
  parameters: {
    type: 'object',
    properties: {
      /** 过滤特定数据库类型 */
      db_type: {
        type: 'string',
        description: '按数据库类型过滤（mysql, postgresql, oracle, dameng 等），不传则返回所有',
      },
    },
  },
  group: 'slide_self_mgmt',
  handler: async (args, context) => {
    const dbTypeFilter = args.db_type as string | undefined;
    if (!context?.actor) {
      return { success: false, status: 'error', data: [], error: '缺少已认证的操作员上下文', errorCode: 'MISSING_ACTOR', next_actions: ['通过已认证的 Agent 会话调用此工具'] };
    }
    if (dbTypeFilter !== undefined && (typeof dbTypeFilter !== 'string' || dbTypeFilter.trim().length === 0)) {
      return { success: false, status: 'error', error: 'db_type 不能为空', errorCode: 'INVALID_ARGUMENTS' };
    }

    try {
      const instances = await instanceDatabaseService.getAllInstances();

      const actorVisible = context?.actor
        ? instances.filter((instance) => canReadResource(context.actor!, { type: 'instance', id: instance.id }))
        : [];
      const filtered = dbTypeFilter
        ? actorVisible.filter(inst => inst.db_type === dbTypeFilter)
        : actorVisible;

      const items = filtered.map(inst => ({
        id: inst.id,
        name: inst.name,
        db_type: inst.db_type,
        host: inst.host,
        port: inst.port,
        health_status: inst.health_status,
        environment: inst.environment,
        status: inst.status,
      }));

      return {
        success: true,
        status: 'success',
        data: items,
        summary: `找到 ${items.length} 个${dbTypeFilter ? ` ${dbTypeFilter}` : ''}数据库实例`,
        details: {
          count: items.length,
          instances: items,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `获取数据库实例列表失败：${errorMessage}`,
        errorCode: 'LIST_INSTANCES_FAILED',
      };
    }
  },
};

// 注册工具到全局目录
toolCatalog.register(listDatabaseInstancesTool);
