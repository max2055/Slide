/**
 * 获取数据库实例完整连接信息
 *
 * 返回单个实例的公开连接元数据。凭据只能在服务端连接层使用，绝不交给模型。
 */

import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';

export const getInstanceConnectionTool: AnyAgentTool = {
  name: 'get_instance_connection',
  description: '获取指定数据库实例的公开连接元数据（不含密码、令牌或连接字符串）。',
  parameters: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'number',
        description: '数据库实例 ID',
      },
    },
    required: ['instance_id'],
  },
  group: 'slide_self_mgmt',
  ownerOnly: true,
  requiresApproval: true,
  dangerLevel: 4,
  handler: async (args) => {
    const instanceId = args.instance_id as number;

    if (!instanceId || typeof instanceId !== 'number') {
      return {
        success: false,
        error: '缺少必需参数 instance_id',
        errorCode: 'MISSING_INSTANCE_ID',
      };
    }

    try {
      const decrypted = await instanceDatabaseService.getInstanceWithDecryptedPassword(instanceId);

      if (!decrypted) {
        return {
          success: false,
          error: `未找到实例 ID=${instanceId}`,
          errorCode: 'INSTANCE_NOT_FOUND',
        };
      }

      const connectionInfo = {
        id: decrypted.id,
        name: decrypted.name,
        db_type: decrypted.db_type,
        host: decrypted.host,
        port: decrypted.port,
        username: decrypted.username,
        database_name: decrypted.database_name,
        health_status: decrypted.health_status,
        environment: decrypted.environment,
      };

      return {
        success: true,
        data: connectionInfo,
        summary: `已获取实例 "${decrypted.name}" (${decrypted.db_type}) 的连接信息`,
        details: {
          instance: connectionInfo,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `获取实例连接信息失败：${errorMessage}`,
        errorCode: 'GET_CONNECTION_FAILED',
      };
    }
  },
};

// 注册工具到全局目录
toolCatalog.register(getInstanceConnectionTool);
