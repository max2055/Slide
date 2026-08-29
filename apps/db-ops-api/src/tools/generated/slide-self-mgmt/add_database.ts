/**
 * 添加数据库工具
 *
 * 纳管新的数据库实例到 Slide 平台
 */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { credentialReferenceService } from '../../../security/credential-reference-service.js';

/**
 * 添加数据库参数
 */
interface AddDatabaseArgs {
  /** 数据库类型 */
  db_type: 'mysql' | 'postgresql' | 'mongodb' | 'redis' | 'elasticsearch' | 'dameng' | 'oracle';
  /** 实例名称 */
  name?: string;
  /** 主机地址 */
  host: string;
  /** 端口 */
  port: number;
  /** 用户名 */
  username: string;
  /** 服务端短期凭据引用 */
  credential_ref?: string;
  /** 数据库名称（可选） */
  database_name?: string;
  /** 环境 */
  environment?: 'development' | 'staging' | 'production';
  /** 描述 */
  description?: string;
}

export const addDatabaseTool: AnyAgentTool = {
  name: 'slide_add_database',
  description: '纳管新的数据库实例到 Slide 平台，支持 MySQL、PostgreSQL、MongoDB、Redis、Elasticsearch、达梦、Oracle',
  parameters: {
    type: 'object',
    properties: {
      db_type: {
        type: 'string',
        description: '数据库类型：mysql, postgresql, mongodb, redis, elasticsearch, dameng, oracle',
        enum: ['mysql', 'postgresql', 'mongodb', 'redis', 'elasticsearch', 'dameng', 'oracle'],
      },
      name: {
        type: 'string',
        description: '实例名称（可选，默认自动生成）',
      },
      host: {
        type: 'string',
        description: '数据库主机地址',
      },
      port: {
        type: 'number',
        description: '数据库端口',
      },
      username: {
        type: 'string',
        description: '数据库用户名',
      },
      credential_ref: {
        type: 'string',
        description: '可选：通过凭据 API 创建的短期单次引用；未提供时先创建实例，密码可后续补充',
      },
      database_name: {
        type: 'string',
        description: '数据库名称（可选）',
      },
      environment: {
        type: 'string',
        description: '环境：development, staging, production',
        enum: ['development', 'staging', 'production'],
      },
      description: {
        type: 'string',
        description: '实例描述',
      },
    },
    required: ['db_type', 'host', 'port', 'username'],
  },
  group: 'db_ops',
  requiresApproval: false,
  handler: async (args, context) => {
    const typedArgs = args as unknown as AddDatabaseArgs;
    if (Object.prototype.hasOwnProperty.call(args, 'password')) {
      return { success: false, status: 'error', error: '禁止向 Agent Tool 传递明文凭据', errorCode: 'PLAINTEXT_CREDENTIAL_DENIED', next_actions: ['使用服务端签发的 credential_ref 重试'] };
    }

    // 参数验证
    const validationError = validateAddDatabaseArgs(typedArgs);
    if (validationError) {
      return {
        success: false,
        status: 'error',
        error: validationError,
        errorCode: 'INVALID_ARGUMENTS',
      };
    }

    try {
      // 1. 生成实例名称（如果未提供）
      const instanceName = typedArgs.name || generateInstanceName(typedArgs);

      // 2. 检查实例是否已存在
      const existing = await checkInstanceExists(instanceName);
      if (existing) {
        return {
          success: false,
          status: 'warning',
          error: `实例 "${instanceName}" 已存在`,
          errorCode: 'INSTANCE_EXISTS',
          data: {
            instanceId: existing.id,
            name: existing.name,
            connectionStatus: 'already_managed',
          },
          details: {
            instanceId: existing.id,
            terminal: true,
            retryable: false,
          },
          next_actions: [`复用已有实例 ID ${existing.id}，不要重复纳管同一实例`],
        };
      }

      if (!context?.actor) {
        return { success: false, status: 'error', error: '缺少认证执行上下文', errorCode: 'MISSING_ACTOR' };
      }
      let password = '';
      if (typedArgs.credential_ref) {
        password = await credentialReferenceService.consume(
          typedArgs.credential_ref,
          context.actor.userId,
          addDatabaseTool.name,
        ) ?? '';
        if (!password) {
          return {
            success: false,
            status: 'error',
            error: '凭据引用无效、已过期或已消费；请创建新的凭据引用后重试，不要重复使用当前参数',
            errorCode: 'INVALID_CREDENTIAL_REF',
            details: { terminal: true, retryable: false },
          };
        }
      }

      // 3. 测试连接
      const connectionTest = password
        ? await testDatabaseConnection(typedArgs, password)
        : { success: false, error: '密码尚未提供' };
      if (password && !connectionTest.success) {
        return {
          success: false,
          status: 'error',
          error: `连接测试失败：${connectionTest.error}`,
          errorCode: 'CONNECTION_FAILED',
          details: { terminal: true, retryable: false },
          next_actions: ['该条目已终止且凭据已消费；修复连接后申请新的 credential_ref 再重试'],
        };
      }

      // 4. 保存到数据库
      const createResult = await instanceDatabaseService.createInstance({
        name: instanceName,
        environment: typedArgs.environment || 'development',
        db_type: typedArgs.db_type,
        host: typedArgs.host,
        port: typedArgs.port,
        username: typedArgs.username,
        password,
        database_name: typedArgs.database_name,
        description: typedArgs.description,
        created_by: context.actor.userId,
      });

      if (!createResult.success) {
        if (createResult.instanceId) {
          return {
            success: false,
            status: 'warning',
            error: `该地址已被实例纳管，请复用已有实例 ID ${createResult.instanceId}`,
            errorCode: 'INSTANCE_EXISTS',
            data: {
              instanceId: createResult.instanceId,
              name: instanceName,
              connectionStatus: 'already_managed',
            },
            details: { instanceId: createResult.instanceId, terminal: true, retryable: false },
            next_actions: [`复用已有实例 ID ${createResult.instanceId}，不要重复纳管同一实例`],
          };
        }
        return {
          success: false,
          status: 'error',
          error: `创建实例失败：${createResult.error}`,
          errorCode: 'CREATE_INSTANCE_FAILED',
          details: { terminal: false, retryable: true },
        };
      }

      const realInstanceId = createResult.instanceId!;

      // 5. 构建响应
      const content = buildAddDatabaseResponse({
        instanceName,
        instanceId: realInstanceId,
        connectionTest: password ? connectionTest.success : null,
        args: typedArgs,
      });

      return {
        success: true,
        status: 'success',
        data: {
          instanceId: realInstanceId,
          name: instanceName,
          connectionStatus: password ? 'connected' : 'pending_credentials',
        },
        summary: password
          ? `✅ 成功纳管 ${typedArgs.db_type.toUpperCase()} 实例 "${instanceName}"`
          : `✅ 已创建 ${typedArgs.db_type.toUpperCase()} 实例 "${instanceName}"，等待补充凭据`,
        details: {
          instanceName,
          instanceId: realInstanceId,
          dbType: typedArgs.db_type,
          host: typedArgs.host,
          port: typedArgs.port,
          environment: typedArgs.environment || 'development',
          message: content,
          terminal: false,
          retryable: false,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        status: 'error',
        error: `纳管失败：${errorMessage}`,
        errorCode: 'ADD_DATABASE_FAILED',
        next_actions: ['检查实例数据库状态和后端日志；仅在原因已改变后重试'],
      };
    }
  },
};

// ============== 辅助函数 ==============

/**
 * 验证参数
 */
function validateAddDatabaseArgs(args: AddDatabaseArgs): string | null {
  const supportedTypes = new Set(['mysql', 'postgresql', 'mongodb', 'redis', 'elasticsearch', 'dameng', 'oracle']);
  if (typeof args.db_type !== 'string' || !supportedTypes.has(args.db_type)) {
    return 'db_type 必须是受支持的数据库类型';
  }

  if (typeof args.host !== 'string' || !args.host.trim()) {
    return '缺少必要参数：host';
  }

  if (!Number.isSafeInteger(args.port) || args.port <= 0 || args.port > 65535) {
    return '端口必须在 1-65535 范围内';
  }

  if (typeof args.username !== 'string' || !args.username.trim()) {
    return '缺少必要参数：username';
  }
  if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim())) return 'name 不能为空';
  if (args.credential_ref !== undefined && (typeof args.credential_ref !== 'string' || !args.credential_ref.trim())) return 'credential_ref 不能为空';
  if (args.environment !== undefined && !['development', 'staging', 'production'].includes(args.environment)) return 'environment 无效';

  // 端口范围验证
  const defaultPorts: Record<string, number[]> = {
    mysql: [3306],
    postgresql: [5432],
    mongodb: [27017, 27018, 27019],
    redis: [6379],
    elasticsearch: [9200, 9300],
    dameng: [5236],
    oracle: [1521],
  };

  const expectedPorts = defaultPorts[args.db_type];
  if (expectedPorts && !expectedPorts.includes(args.port)) {
    console.warn(
      `[addDatabase] 警告：${args.db_type} 的常用端口是 ${expectedPorts.join('/')}, 当前端口为 ${args.port}`,
    );
  }

  return null;
}

/**
 * 生成实例名称
 */
function generateInstanceName(args: AddDatabaseArgs): string {
  return `${args.db_type}_${args.host.replace(/\./g, '_')}_${args.port}`;
}

/**
 * 检查实例是否存在
 */
async function checkInstanceExists(name: string): Promise<{ id: number; name: string } | null> {
  const instances = await instanceDatabaseService.getAllInstances();
  const instance = instances.find(inst => inst.name === name);
  return instance ? { id: instance.id, name: instance.name } : null;
}

/**
 * 测试数据库连接
 */
async function testDatabaseConnection(
  args: AddDatabaseArgs,
  password: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await instanceDatabaseService.testConnection({
    db_type: args.db_type,
    host: args.host,
    port: args.port,
    username: args.username,
    password,
    database: args.database_name,
  });
  return { success: result.success, error: result.success ? undefined : result.message };
}

/**
 * 构建响应文本
 */
function buildAddDatabaseResponse(params: {
  instanceName: string;
  instanceId: number;
  connectionTest: boolean | null;
  args: AddDatabaseArgs;
}): string {
  const lines: string[] = [];

  lines.push(params.connectionTest === null ? `✅ 已创建数据库实例` : `✅ 成功纳管数据库实例`);
  lines.push('');
  lines.push(`实例名称：${params.instanceName}`);
  lines.push(`实例 ID: ${params.instanceId}`);
  lines.push(`类型：${params.args.db_type.toUpperCase()}`);
  lines.push(`地址：${params.args.host}:${params.args.port}`);
  lines.push(`环境：${params.args.environment || 'development'}`);

  if (params.args.database_name) {
    lines.push(`数据库：${params.args.database_name}`);
  }

  lines.push('');
  lines.push(`连接测试：${params.connectionTest === null ? '⏳ 未执行（等待补充凭据）' : params.connectionTest ? '✅ 成功' : '❌ 失败'}`);

  if (params.args.description) {
    lines.push('');
    lines.push(`描述：${params.args.description}`);
  }

  lines.push('');
  lines.push('💡 提示：可以使用 `slide_test_connection` 工具再次测试连接');

  return lines.join('\n');
}

// 注册工具到全局目录
toolCatalog.register(addDatabaseTool);
