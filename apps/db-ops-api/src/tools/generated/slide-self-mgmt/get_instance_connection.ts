/**
 * 获取数据库实例完整连接信息
 *
 * 返回单个实例的完整连接信息，包含解密后的密码。
 * Agent 可以使用此工具获取连接字符串，从而直接连接数据库进行分析。
 */

import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';

export const getInstanceConnectionTool: AnyAgentTool = {
  name: 'get_instance_connection',
  description: '获取指定数据库实例的完整连接信息，包含解密后的密码。用于获取连接字符串以直接连接数据库进行分析。注意：仅限管理员用户调用（dangerLevel=4），返回的密码为明文。',
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
        password: decrypted.password,
        database_name: decrypted.database_name,
        connection_string: decrypted.connection_string,
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
