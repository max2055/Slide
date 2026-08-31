/**
 * 更新数据库配置工具
 *
 * 更新已纳管数据库实例的配置信息
 */

import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { credentialReferenceService } from '../../../security/credential-reference-service.js';

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
  /** 新密码的服务端短期凭据引用 */
  credential_ref?: string;
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
      credential_ref: {
        type: 'string',
        description: '新密码的短期单次凭据引用',
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
  handler: async (args, context) => {
    const typedArgs = args as unknown as UpdateDbConfigArgs;
    if (Object.prototype.hasOwnProperty.call(args, 'password')) {
      return { success: false, status: 'error', error: '禁止向 Agent Tool 传递明文凭据', errorCode: 'PLAINTEXT_CREDENTIAL_DENIED', next_actions: ['使用服务端签发的 credential_ref 重试'] };
    }

    // 参数验证
    if (typedArgs.instance_id === undefined && typedArgs.instance_name === undefined) {
      return {
        success: false,
        status: 'error',
        error: '请提供实例 ID 或实例名称',
        errorCode: 'MISSING_ARGUMENTS',
      };
    }
    if (typedArgs.instance_id !== undefined && (!Number.isSafeInteger(typedArgs.instance_id) || typedArgs.instance_id <= 0)) {
      return { success: false, status: 'error', error: 'instance_id 必须为正整数', errorCode: 'INVALID_ARGUMENTS' };
    }
    if (typedArgs.instance_name !== undefined && (typeof typedArgs.instance_name !== 'string' || typedArgs.instance_name.trim().length === 0)) {
      return { success: false, status: 'error', error: 'instance_name 不能为空', errorCode: 'INVALID_ARGUMENTS' };
    }
    if (typedArgs.instance_id !== undefined && typedArgs.instance_name !== undefined) {
      return { success: false, status: 'error', error: 'instance_id 与 instance_name 只能二选一', errorCode: 'MUTUALLY_EXCLUSIVE_ARGUMENTS' };
    }
    if (typedArgs.port !== undefined && (!Number.isSafeInteger(typedArgs.port) || typedArgs.port < 1 || typedArgs.port > 65535)) {
      return { success: false, status: 'error', error: 'port 必须为 1-65535 的整数', errorCode: 'INVALID_ARGUMENTS' };
    }
    for (const field of ['name', 'host', 'username'] as const) {
      if (typedArgs[field] !== undefined && (typeof typedArgs[field] !== 'string' || typedArgs[field].trim().length === 0)) {
        return { success: false, status: 'error', error: `${field} 不能为空`, errorCode: 'INVALID_ARGUMENTS' };
      }
    }
    if (typedArgs.credential_ref !== undefined && (typeof typedArgs.credential_ref !== 'string' || typedArgs.credential_ref.trim().length === 0)) {
      return { success: false, status: 'error', error: 'credential_ref 不能为空', errorCode: 'INVALID_ARGUMENTS' };
    }

    // 检查是否有实际要更新的字段
    const updatableFields = ['name', 'host', 'port', 'username', 'credential_ref', 'environment', 'description'];
    const hasUpdateField = updatableFields.some(field => typedArgs[field as keyof UpdateDbConfigArgs] !== undefined);

    if (!hasUpdateField) {
      return {
        success: false,
        status: 'error',
        error: '请提供至少一个要更新的字段',
        errorCode: 'NO_UPDATE_FIELDS',
      };
    }

    try {
      // 1. 查找实例
      const instanceId = typedArgs.instance_id ?? await findInstanceIdByName(typedArgs.instance_name!);

      if (!instanceId) {
        return {
          success: false,
          status: 'error',
          error: `未找到实例：${typedArgs.instance_name ? `"${typedArgs.instance_name}"` : `ID=${typedArgs.instance_id}`}`,
          errorCode: 'INSTANCE_NOT_FOUND',
          next_actions: ['先调用 list_database_instances 确认实例 ID 或名称'],
        };
      }

      let password: string | undefined;
      if (typedArgs.credential_ref) {
        if (!context?.actor) {
          return { success: false, status: 'error', error: '缺少认证执行上下文', errorCode: 'MISSING_ACTOR' };
        }
        password = await credentialReferenceService.consume(
          typedArgs.credential_ref,
          context.actor.userId,
          updateDbConfigTool.name,
        ) ?? undefined;
        if (!password) {
          return { success: false, status: 'error', error: '凭据引用无效、已过期或已消费', errorCode: 'INVALID_CREDENTIAL_REF', next_actions: ['重新申请一次性 credential_ref；不要重复使用该引用'] };
        }
      }

      // 2. 构建更新数据
      const updateData: Record<string, unknown> = {};
      if (typedArgs.name !== undefined) updateData.name = typedArgs.name;
      if (typedArgs.host !== undefined) updateData.host = typedArgs.host;
      if (typedArgs.port !== undefined) updateData.port = typedArgs.port;
      if (typedArgs.username !== undefined) updateData.username = typedArgs.username;
      if (password !== undefined) updateData.password = password;
      if (typedArgs.environment !== undefined) updateData.environment = typedArgs.environment;
      if (typedArgs.description !== undefined) updateData.description = typedArgs.description;

      // 3. 执行更新
      const result = await instanceDatabaseService.updateInstance(instanceId, updateData);

      if (!result.success) {
        return {
          success: false,
          status: 'error',
          error: `更新失败：${result.error}`,
          errorCode: 'UPDATE_FAILED',
          details: { credentialConsumed: Boolean(password), retryable: !password },
          next_actions: [password ? '凭据引用已消费，请重新申请后重试' : '确认实例状态和参数后重试'],
        };
      }

      // 4. 如果需要，测试新连接的连通性
      let connectionTested = false;
      let connectionSuccess = false;

      if (typedArgs.host !== undefined || typedArgs.port !== undefined || typedArgs.username !== undefined || password !== undefined) {
        connectionTested = true;
        // 获取更新后的实例信息进行连接测试
        const decrypted = await instanceDatabaseService.getInstanceWithDecryptedPassword(instanceId);
        if (decrypted) {
          const testResult = await instanceDatabaseService.testConnection({
            db_type: decrypted.db_type,
            host: typedArgs.host ?? decrypted.host,
            port: typedArgs.port ?? decrypted.port,
            username: typedArgs.username ?? decrypted.username,
            password: password ?? decrypted.password,
            database: decrypted.database_name || undefined,
          });
          connectionSuccess = testResult.success;
        }
      }

      // 5. 构建响应
      const updatedFields = Object.keys(updateData);

      return {
        success: true,
        status: connectionTested && !connectionSuccess ? 'warning' : 'success',
        data: {
          instanceId,
          updatedFields,
          connectionTested,
          connectionSuccess,
          ...(connectionTested && !connectionSuccess ? { warning: '配置已保存，但新连接测试失败' } : {}),
        },
        next_actions: connectionTested && !connectionSuccess
          ? ['检查网络、端口和凭据；配置已保存，修复后调用 slide_test_connection 验证']
          : [],
        summary: `✅ 成功更新实例配置：${updatedFields.join(', ')}`,
        details: {
          instanceId,
          updatedFields,
          connectionTested,
          connectionSuccess,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        status: 'error',
        error: `更新失败：${errorMessage}`,
        errorCode: 'UPDATE_CONFIG_FAILED',
        next_actions: ['确认实例状态和参数后重试；若使用 credential_ref，请重新申请引用'],
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
