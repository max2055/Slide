/**
 * 更新数据库配置工具
 *
 * 更新已纳管数据库实例的配置信息
 */

import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';

/**
 * 更新配置参数
 */
interface UpdateDbConfigArgs {
  /** 实例 ID */
  instance_id?: number;
  /** 实例名称 */
  instance_name?: string;
  /** 新名称 */
  name?: string;
  /** 新主机地址 */
  host?: string;
  /** 新端口 */
  port?: number;
  /** 新用户名 */
  username?: string;
  /** 新密码 */
  password?: string;
  /** 新环境 */
  environment?: 'development' | 'staging' | 'production';
  /** 新描述 */
  description?: string;
}

export const updateDbConfigTool: AnyAgentTool = {
  name: 'slide_update_db_config',
  description: '更新数据库实例配置，支持修改名称、主机、端口、用户名、密码、环境等',
  parameters: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'number',
        description: '实例 ID（与 instance_name 二选一）',
      },
      instance_name: {
        type: 'string',
        description: '实例名称（与 instance_id 二选一）',
      },
      name: {
        type: 'string',
        description: '新实例名称',
      },
      host: {
        type: 'string',
        description: '新主机地址',
      },
      port: {
        type: 'number',
        description: '新端口',
      },
      username: {
        type: 'string',
        description: '新用户名',
      },
      password: {
        type: 'string',
        description: '新密码',
      },
      environment: {
        type: 'string',
        description: '新环境',
        enum: ['development', 'staging', 'production'],
      },
      description: {
        type: 'string',
        description: '新描述',
      },
    },
    required: [],
  },
  group: 'db_ops',
  requiresApproval: true,
  dangerLevel: 3,
  handler: async (args) => {
    const typedArgs = args as unknown as UpdateDbConfigArgs;

    // 参数验证
    if (!typedArgs.instance_id && !typedArgs.instance_name) {
      return {
        success: false,
        error: '请提供实例 ID 或实例名称',
        errorCode: 'MISSING_ARGUMENTS',
      };
    }

    // 检查是否有实际要更新的字段
    const updatableFields = ['name', 'host', 'port', 'username', 'password', 'environment', 'description'];
    const hasUpdateField = updatableFields.some(field => typedArgs[field as keyof UpdateDbConfigArgs] !== undefined);

    if (!hasUpdateField) {
      return {
        success: false,
        error: '请提供至少一个要更新的字段',
        errorCode: 'NO_UPDATE_FIELDS',
      };
    }

    try {
      // 1. 查找实例
      const instanceId = typedArgs.instance_id || await findInstanceIdByName(typedArgs.instance_name!);

      if (!instanceId) {
        return {
          success: false,
          error: `未找到实例：${typedArgs.instance_name ? `"${typedArgs.instance_name}"` : `ID=${typedArgs.instance_id}`}`,
          errorCode: 'INSTANCE_NOT_FOUND',
        };
      }

      // 2. 构建更新数据
      const updateData: Record<string, unknown> = {};
      if (typedArgs.name) updateData.name = typedArgs.name;
      if (typedArgs.host) updateData.host = typedArgs.host;
      if (typedArgs.port) updateData.port = typedArgs.port;
      if (typedArgs.username) updateData.username = typedArgs.username;
      if (typedArgs.password) updateData.password = typedArgs.password;
      if (typedArgs.environment) updateData.environment = typedArgs.environment;
      if (typedArgs.description) updateData.description = typedArgs.description;

      // 3. 执行更新
      const result = await instanceDatabaseService.updateInstance(instanceId, updateData);

      if (!result.success) {
        return {
          success: false,
          error: `更新失败：${result.error}`,
          errorCode: 'UPDATE_FAILED',
        };
      }

      // 4. 如果需要，测试新连接的连通性
      let connectionTested = false;
      let connectionSuccess = false;

      if (typedArgs.host || typedArgs.port || typedArgs.username || typedArgs.password) {
        connectionTested = true;
        // 获取更新后的实例信息进行连接测试
        const decrypted = await instanceDatabaseService.getInstanceWithDecryptedPassword(instanceId);
        if (decrypted) {
          const testResult = await instanceDatabaseService.testConnection({
            db_type: decrypted.db_type,
            host: typedArgs.host || decrypted.host,
            port: typedArgs.port || decrypted.port,
            username: typedArgs.username || decrypted.username,
            password: typedArgs.password || decrypted.password,
            database: decrypted.database_name || undefined,
          });
          connectionSuccess = testResult.success;
        }
      }

      // 5. 构建响应
      const updatedFields = Object.keys(updateData);

      return {
        success: true,
        data: {
          instanceId,
          updatedFields,
          connectionTested,
          connectionSuccess,
        },
        summary: `✅ 成功更新实例配置：${updatedFields.join(', ')}`,
        details: {
          instanceId,
          updatedFields,
          updateData,
          connectionTested,
          connectionSuccess,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `更新失败：${errorMessage}`,
        errorCode: 'UPDATE_CONFIG_FAILED',
      };
    }
  },
};

// ============== 辅助函数 ==============

/**
 * 根据名称查找实例 ID
 */
async function findInstanceIdByName(name: string): Promise<number | null> {
  const instances = await instanceDatabaseService.getAllInstances();
  const instance = instances.find(inst => inst.name === name);
  return instance?.id || null;
}

// 注册工具到全局目录
toolCatalog.register(updateDbConfigTool);
