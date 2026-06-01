/**
 * 测试数据库连接工具
 *
 * 测试已纳管数据库实例的连接状态
 */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { databaseService } from '../../../database-service.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';

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
  /** 密码 */
  password?: string;
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
      password: {
        type: 'string',
        description: '数据库密码（用于直接连接测试）',
      },
      database: {
        type: 'string',
        description: '数据库名称（用于直接连接测试）',
      },
    },
  },
  group: 'db_ops',
  handler: async (args) => {
    const typedArgs = args as unknown as TestConnectionArgs;

    // 参数验证
    if (!typedArgs.instance_id && !typedArgs.instance_name && !typedArgs.host) {
      return {
        success: false,
        error: '请提供实例 ID、实例名称或连接信息（host）',
        errorCode: 'MISSING_ARGUMENTS',
      };
    }

    try {
      let connectionParams: TestConnectionArgs;

      // 1. 如果提供了 instance_id 或 instance_name，从数据库获取连接信息
      if (typedArgs.instance_id || typedArgs.instance_name) {
        const instanceInfo = await getInstanceConnectionInfo(typedArgs);
        if (!instanceInfo) {
          return {
            success: false,
            error: `未找到实例：${typedArgs.instance_id ? `ID=${typedArgs.instance_id}` : `"${typedArgs.instance_name}"`}`,
            errorCode: 'INSTANCE_NOT_FOUND',
          };
        }
        connectionParams = instanceInfo;
      } else {
        connectionParams = typedArgs;
      }

      // 2. 执行连接测试
      const startTime = Date.now();
      const testResult = await executeConnectionTest(connectionParams);
      const responseTimeMs = Date.now() - startTime;

      // 3. 构建响应
      if (testResult.success) {
        return {
          success: true,
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
          error: `连接失败：${testResult.error}`,
          errorCode: 'CONNECTION_FAILED',
          details: {
            success: false,
            connectionInfo: sanitizeConnectionInfo(connectionParams),
          },
        };
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `连接测试失败：${errorMessage}`,
        errorCode: 'TEST_CONNECTION_FAILED',
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
    port: params.port || 3306,
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
    // 不暴露密码
    password: params.password ? '***' : undefined,
  };
}

// 注册工具到全局目录
toolCatalog.register(testConnectionTool);
