/**
 * 测试数据库连接工具
 *
 * 测试已纳管数据库实例的连接状态
 */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { databaseService } from '../../../database-service.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { credentialReferenceService } from '../../../security/credential-reference-service.js';

/**
 * 测试连接参数
 */
interface TestConnectionArgs {
  /** 实例 ID */
  instance_id?: number;
  /** 实例名称 */
  instance_name?: string;
  /** 数据库类型（用于直接连接测试） */
  db_type?: string;
  /** 主机地址 */
  host?: string;
  /** 端口 */
  port?: number;
  /** 用户名 */
  username?: string;
  /** 内部解析后的密码，不属于模型参数 */
  password?: string;
  /** 服务端短期凭据引用 */
  credential_ref?: string;
  /** 数据库名称 */
  database?: string;
}

export const testConnectionTool: AnyAgentTool = {
  name: 'slide_test_connection',
  description: '测试数据库实例连接，支持通过实例 ID、实例名称或直接连接参数测试',
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
      db_type: {
        type: 'string',
        description: '数据库类型（用于直接连接测试，支持 mysql、postgresql、mongodb、redis、elasticsearch、dameng、oracle）',
        enum: ['mysql', 'postgresql', 'mongodb', 'redis', 'elasticsearch', 'dameng', 'oracle'],
      },
      host: {
        type: 'string',
        description: '数据库主机地址（用于直接连接测试）',
      },
      port: {
        type: 'number',
        description: '数据库端口（用于直接连接测试）',
      },
      username: {
        type: 'string',
        description: '数据库用户名（用于直接连接测试）',
      },
      credential_ref: {
        type: 'string',
        description: '直接连接测试使用的短期单次凭据引用',
      },
      database: {
        type: 'string',
        description: '数据库名称（用于直接连接测试）',
      },
    },
  },
  group: 'db_ops',
  handler: async (args, context) => {
    const typedArgs = args as unknown as TestConnectionArgs;
    if (Object.prototype.hasOwnProperty.call(args, 'password')) {
      return { success: false, status: 'error', error: '禁止向 Agent Tool 传递明文凭据', errorCode: 'PLAINTEXT_CREDENTIAL_DENIED', next_actions: ['使用服务端签发的 credential_ref 重试'] };
    }

    const hasInstanceId = typedArgs.instance_id !== undefined;
    const hasInstanceName = typeof typedArgs.instance_name === 'string' && typedArgs.instance_name.trim().length > 0;
    const directFields = ['db_type', 'host', 'port', 'username', 'credential_ref', 'database'] as const;
    const hasDirectFields = directFields.some((field) => typedArgs[field] !== undefined);
    if (hasInstanceId && (!Number.isSafeInteger(typedArgs.instance_id) || typedArgs.instance_id! <= 0)) {
      return { success: false, status: 'error', error: 'instance_id 必须为正整数', errorCode: 'INVALID_ARGUMENTS' };
    }
    if (typedArgs.instance_name !== undefined && !hasInstanceName) {
      return { success: false, status: 'error', error: 'instance_name 不能为空', errorCode: 'INVALID_ARGUMENTS' };
    }
    if (hasInstanceId && hasInstanceName) {
      return { success: false, status: 'error', error: 'instance_id 与 instance_name 只能二选一', errorCode: 'MUTUALLY_EXCLUSIVE_ARGUMENTS' };
    }
    if ((hasInstanceId || hasInstanceName) && hasDirectFields) {
      return { success: false, status: 'error', error: '实例查询参数不能与直接连接参数混用', errorCode: 'MUTUALLY_EXCLUSIVE_ARGUMENTS' };
    }
    if (!hasInstanceId && !hasInstanceName && !hasDirectFields) {
      return {
        success: false,
        status: 'error',
        error: '请提供实例 ID、实例名称或连接信息（host）',
        errorCode: 'MISSING_ARGUMENTS',
      };
    }

    if (!hasInstanceId && !hasInstanceName) {
      const validTypes = ['mysql', 'postgresql', 'mongodb', 'redis', 'elasticsearch', 'dameng', 'oracle'];
      if (typeof typedArgs.db_type !== 'string' || !validTypes.includes(typedArgs.db_type)) {
        return { success: false, status: 'error', error: '直接连接测试必须提供有效的 db_type', errorCode: 'INVALID_ARGUMENTS' };
      }
      if (typeof typedArgs.host !== 'string' || typedArgs.host.trim().length === 0) {
        return { success: false, status: 'error', error: '直接连接测试必须提供 host', errorCode: 'INVALID_ARGUMENTS' };
      }
      if (!Number.isSafeInteger(typedArgs.port) || typedArgs.port! < 1 || typedArgs.port! > 65535) {
        return { success: false, status: 'error', error: 'port 必须为 1-65535 的整数', errorCode: 'INVALID_ARGUMENTS' };
      }
      if (typeof typedArgs.username !== 'string' || typedArgs.username.trim().length === 0) {
        return { success: false, status: 'error', error: '直接连接测试必须提供 username', errorCode: 'INVALID_ARGUMENTS' };
      }
      if (typeof typedArgs.credential_ref !== 'string' || typedArgs.credential_ref.trim().length === 0) {
        return { success: false, status: 'error', error: '直接连接测试需要凭据引用', errorCode: 'CREDENTIAL_REF_REQUIRED' };
      }
    }

    try {
      let connectionParams: TestConnectionArgs;

      // 1. 如果提供了 instance_id 或 instance_name，从数据库获取连接信息
      if (typedArgs.instance_id || typedArgs.instance_name) {
        const instanceInfo = await getInstanceConnectionInfo(typedArgs);
        if (!instanceInfo) {
          return {
            success: false,
            status: 'error',
            error: `未找到实例：${typedArgs.instance_id ? `ID=${typedArgs.instance_id}` : `"${typedArgs.instance_name}"`}`,
            errorCode: 'INSTANCE_NOT_FOUND',
            next_actions: ['先调用 list_database_instances 确认实例 ID 或名称']
          };
        }
        connectionParams = instanceInfo;
      } else {
        if (!context?.actor || !typedArgs.credential_ref) {
          return { success: false, status: 'error', error: '直接连接测试需要凭据引用', errorCode: 'CREDENTIAL_REF_REQUIRED' };
        }
        const password = await credentialReferenceService.consume(
          typedArgs.credential_ref,
          context.actor.userId,
          testConnectionTool.name,
        );
        if (!password) {
          return { success: false, status: 'error', error: '凭据引用无效、已过期或已消费', errorCode: 'INVALID_CREDENTIAL_REF', next_actions: ['重新申请一次性 credential_ref；不要重复使用该引用'] };
        }
        connectionParams = { ...typedArgs, password };
      }

      // 2. 执行连接测试
      const startTime = Date.now();
      const testResult = await executeConnectionTest(connectionParams);
      const responseTimeMs = Date.now() - startTime;

      // 3. 构建响应
      if (testResult.success) {
        return {
          success: true,
          status: 'success',
          data: {
            connected: true,
            responseTimeMs,
            serverVersion: testResult.serverVersion,
          },
          summary: `✅ 连接成功，响应时间 ${responseTimeMs}ms`,
          details: {
            success: true,
            responseTimeMs,
            serverVersion: testResult.serverVersion,
            connectionInfo: sanitizeConnectionInfo(connectionParams),
          },
        };
      } else {
        return {
          success: false,
          status: 'error',
          error: `连接失败：${testResult.error}`,
          errorCode: 'CONNECTION_FAILED',
          details: {
            success: false,
            connectionInfo: sanitizeConnectionInfo(connectionParams),
          },
          next_actions: ['检查主机、端口、账号和网络策略后再使用新的凭据引用重试'],
        };
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        status: 'error',
        error: `连接测试失败：${errorMessage}`,
        errorCode: 'TEST_CONNECTION_FAILED',
        next_actions: ['检查数据库实例状态和后端日志；确认故障消除后再重试'],
      };
    }
  },
};

// ============== 辅助函数 ==============

/**
 * 获取实例连接信息
 */
async function getInstanceConnectionInfo(
  args: TestConnectionArgs,
): Promise<TestConnectionArgs | null> {
  // 通过实例 ID 或名称查找
  let instanceId = args.instance_id;

  if (!instanceId && args.instance_name) {
    const instances = await instanceDatabaseService.getAllInstances();
    const instance = instances.find(inst => inst.name === args.instance_name);
    if (!instance) return null;
    instanceId = instance.id;
  }

  if (!instanceId) return null;

  // 获取解密后的连接信息
  const decrypted = await instanceDatabaseService.getInstanceWithDecryptedPassword(instanceId);
  if (!decrypted) return null;

  return {
    instance_id: instanceId,
    db_type: decrypted.db_type,
    host: decrypted.host,
    port: decrypted.port,
    username: decrypted.username,
    password: decrypted.password,
    database: decrypted.database_name || undefined,
  };
}

/**
 * 执行连接测试
 */
async function executeConnectionTest(
  params: TestConnectionArgs,
): Promise<{ success: boolean; error?: string; serverVersion?: string }> {
  const dbType = params.db_type || 'mysql';

  // 如果实例已通过 databaseService 连接，使用现有连接池测试
  if (params.instance_id) {
    const conn = databaseService.getConnection(params.instance_id);
    if (conn && conn.connected) {
      try {
        if (conn.pool) {
          await conn.pool.query('SELECT 1');
          return { success: true };
        } else if (conn.pgClient) {
          await conn.pgClient.query('SELECT 1');
          return { success: true };
        } else if (conn.oracleConnection) {
          await conn.oracleConnection.execute('SELECT 1 FROM DUAL');
          return { success: true };
        } else if (conn.dmConnection) {
          await conn.dmConnection.execute('SELECT 1 FROM DUAL');
          return { success: true };
        }
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }
  }

  // 否则通过 instanceDatabaseService.testConnection 进行临时连接测试
  const result = await instanceDatabaseService.testConnection({
    db_type: dbType,
    host: params.host || 'localhost',
    port: params.port ?? 3306,
    username: params.username || 'root',
    password: params.password || '',
    database: params.database,
  });

  if (result.success) {
    return { success: true };
  }
  return { success: false, error: result.message };
}

/**
 * 清理连接信息（用于日志和调试，不暴露密码）
 */
function sanitizeConnectionInfo(params: TestConnectionArgs): Record<string, unknown> {
  return {
    db_type: params.db_type,
    host: params.host,
    port: params.port,
    username: params.username,
    database: params.database,
    hasCredential: Boolean(params.password),
  };
}

// 注册工具到全局目录
toolCatalog.register(testConnectionTool);
