/**
 * 添加数据库工具
 *
 * 纳管新的数据库实例到 Slide 平台
 */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';

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
  /** 密码 */
  password: string;
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
      password: {
        type: 'string',
        description: '数据库密码',
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
    required: ['db_type', 'host', 'port', 'username', 'password'],
  },
  group: 'db_ops',
  requiresApproval: false,
  handler: async (args) => {
    const typedArgs = args as unknown as AddDatabaseArgs;

    // 参数验证
    const validationError = validateAddDatabaseArgs(typedArgs);
    if (validationError) {
      return {
        success: false,
        error: validationError,
        errorCode: 'INVALID_ARGUMENTS',
      };
    }

    try {
      // 1. 生成实例名称（如果未提供）
      const instanceName = typedArgs.name || generateInstanceName(typedArgs);

      // 2. 检查实例是否已存在
      const exists = await checkInstanceExists(instanceName);
      if (exists) {
        return {
          success: false,
          error: `实例 "${instanceName}" 已存在`,
          errorCode: 'INSTANCE_EXISTS',
        };
      }

      // 3. 测试连接
      const connectionTest = await testDatabaseConnection(typedArgs);
      if (!connectionTest.success) {
        return {
          success: false,
          error: `连接测试失败：${connectionTest.error}`,
          errorCode: 'CONNECTION_FAILED',
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
        password: typedArgs.password,
        database_name: typedArgs.database_name,
        description: typedArgs.description,
      });

      if (!createResult.success) {
        return {
          success: false,
          error: `创建实例失败：${createResult.error}`,
          errorCode: 'CREATE_INSTANCE_FAILED',
        };
      }

      const realInstanceId = createResult.instanceId!;

      // 5. 构建响应
      const content = buildAddDatabaseResponse({
        instanceName,
        instanceId: realInstanceId,
        connectionTest: connectionTest.success,
        args: typedArgs,
      });

      return {
        success: true,
        data: {
          instanceId: realInstanceId,
          name: instanceName,
          connectionStatus: 'connected',
        },
        summary: `✅ 成功纳管 ${typedArgs.db_type.toUpperCase()} 实例 "${instanceName}"`,
        details: {
          instanceName,
          instanceId: realInstanceId,
          dbType: typedArgs.db_type,
          host: typedArgs.host,
          port: typedArgs.port,
          environment: typedArgs.environment || 'development',
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `纳管失败：${errorMessage}`,
        errorCode: 'ADD_DATABASE_FAILED',
      };
    }
  },
};

// ============== 辅助函数 ==============

/**
 * 验证参数
 */
function validateAddDatabaseArgs(args: AddDatabaseArgs): string | null {
  if (!args.db_type) {
    return '缺少必要参数：db_type';
  }

  if (!args.host) {
    return '缺少必要参数：host';
  }

  if (!args.port || args.port <= 0 || args.port > 65535) {
    return '端口必须在 1-65535 范围内';
  }

  if (!args.username) {
    return '缺少必要参数：username';
  }

  if (!args.password) {
    return '缺少必要参数：password';
  }

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
async function checkInstanceExists(name: string): Promise<boolean> {
  const instances = await instanceDatabaseService.getAllInstances();
  return instances.some(inst => inst.name === name);
}

/**
 * 测试数据库连接
 */
async function testDatabaseConnection(
  args: AddDatabaseArgs,
): Promise<{ success: boolean; error?: string }> {
  const result = await instanceDatabaseService.testConnection({
    db_type: args.db_type,
    host: args.host,
    port: args.port,
    username: args.username,
    password: args.password,
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
  connectionTest: boolean;
  args: AddDatabaseArgs;
}): string {
  const lines: string[] = [];

  lines.push(`✅ 成功纳管数据库实例`);
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
  lines.push(`连接测试：${params.connectionTest ? '✅ 成功' : '❌ 失败'}`);

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
