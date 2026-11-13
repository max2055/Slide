/**
 * 更新数据库配置工具
 *
 * 更新已纳管数据库实例的配置信息
 */

import type { ActorContext } from '../../../auth/actor-context.js';
import { encryptData } from '../../../db-connection.js';
import { authorizeDatabaseTarget } from '../../../security/database-target-policy.js';
import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { actorCanWriteInstance } from '../../resource-resolver.js';
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

    let updateSubmitted = false;
    let configCommitted = false;
    let credentialCommitted = false;
    let instanceId = 0;
    let updatedFields: string[] = [];
    let verificationStage: 'decrypt' | 'connect' | undefined;
    try {
      // 1. 显式 ID 只更新该行。名称必须在 trim 后唯一确定一个可用实例。
      // environment 是要写入的新环境，不能用来挑选现有行。
      const resolved = typedArgs.instance_id !== undefined
        ? { id: typedArgs.instance_id }
        : await resolveInstanceIdByName(typedArgs.instance_name!, context?.actor);
      if ('error' in resolved) return resolved.error;
      instanceId = resolved.id;
      if (context?.instanceId !== undefined && context.instanceId !== instanceId) {
        return {
          success: false,
          status: 'error',
          error: '名称已不能唯一对应原实例，未更新任何实例',
          errorCode: 'INSTANCE_NOT_FOUND',
          next_actions: ['使用 instance_id 指定要更新的实例'],
        };
      }

      // 2. 构建更新数据
      const updateData: Record<string, unknown> = {};
      if (typedArgs.name !== undefined) updateData.name = typedArgs.name.trim();
      if (typedArgs.host !== undefined) updateData.host = typedArgs.host;
      if (typedArgs.port !== undefined) updateData.port = typedArgs.port;
      if (typedArgs.username !== undefined) updateData.username = typedArgs.username;
      if (typedArgs.environment !== undefined) updateData.environment = typedArgs.environment;
      if (typedArgs.description !== undefined) updateData.description = typedArgs.description;

      // 3. 引用消费与配置写入必须原子提交，不能通过恢复已消费引用补偿。
      if (typedArgs.credential_ref) {
        if (!context?.actor) {
          return { success: false, status: 'error', error: '缺少认证执行上下文', errorCode: 'MISSING_ACTOR' };
        }
        const outcome = await credentialReferenceService.consumeInTransaction(
          typedArgs.credential_ref, context.actor.userId, updateDbConfigTool.name,
          async (executor, password) => {
            if (!password.trim()) throw new Error('EMPTY_PASSWORD');
            const [rows] = await executor.execute(
              "SELECT host, port, db_type FROM database_instances WHERE id = ? AND lifecycle_state = 'available' FOR UPDATE",
              [instanceId],
            );
            if (!rows[0]) throw new Error('INSTANCE_NOT_AVAILABLE');
            await authorizeDatabaseTarget({
              host: typedArgs.host ?? rows[0].host,
              port: typedArgs.port ?? Number(rows[0].port),
              dbType: rows[0].db_type,
            });
            // Keys come only from the explicit field list above, never from caller SQL.
            const fields = Object.keys(updateData);
            const [result] = await executor.execute(
              `UPDATE database_instances SET ${fields.map(field => `${field} = ?`).concat('password_encrypted = ?').join(', ')} WHERE id = ? AND lifecycle_state = 'available'`,
              [...Object.values(updateData), encryptData(password), instanceId],
            );
            if (Number(result.affectedRows) !== 1) throw new Error('UPDATE_NOT_APPLIED');
          },
        );
        if (outcome.status !== 'committed') {
          const retryable = outcome.status === 'rolled_back';
          return {
            success: false, status: 'error',
            error: outcome.status === 'unknown' ? '更新提交结果未知，必须先对账，不要重放写请求' : retryable ? '更新未提交，事务已回滚，凭据引用未消费' : '凭据引用无效、已过期或已消费',
            errorCode: outcome.status === 'invalid' ? 'INVALID_CREDENTIAL_REF' : outcome.status === 'unknown' ? 'UPDATE_OUTCOME_UNKNOWN' : 'UPDATE_FAILED',
            details: { instanceId, retryable, credentialConsumed: retryable ? false : 'unknown' },
            next_actions: [outcome.status === 'unknown' ? '先对账核对实例配置及凭据引用状态；未确认结果前不要重试或申请新引用重放更新' : retryable ? '修复失败原因后可使用原 credential_ref 重试；引用仍受有效期和单次使用约束' : '不要复用该引用；先核对实例状态'],
          };
        }
        updateData.password = true; // Response field name only; never retain the secret here.
      } else {
        updateSubmitted = true;
        const result = await instanceDatabaseService.updateInstance(instanceId, updateData);
        if (!result.success) {
          return { success: false, status: 'error', error: '更新结果未确认，请先核对实例配置', errorCode: 'UPDATE_FAILED', details: { instanceId, retryable: false }, next_actions: ['先对账确认更新结果，再决定后续操作；不要盲目重试'] };
        }
      }
      updatedFields = Object.keys(updateData);
      credentialCommitted = typedArgs.credential_ref !== undefined;
      configCommitted = true;

      // 4. 只有连接字段变更才验证。取回 null 时测试没有执行，不能记成测试失败。
      let connectionTested = false;
      let connectionSuccess = false;
      let connectionTestOutcome: 'not_required' | 'unavailable' | 'failed' | 'passed' = 'not_required';

      if (typedArgs.host !== undefined || typedArgs.port !== undefined || typedArgs.username !== undefined || typedArgs.credential_ref !== undefined) {
        verificationStage = 'decrypt';
        const decrypted = await instanceDatabaseService.getInstanceWithDecryptedPassword(instanceId);
        if (!decrypted) {
          connectionTestOutcome = 'unavailable';
        } else {
          verificationStage = 'connect';
          connectionTested = true;
          const testResult = await instanceDatabaseService.testConnection({
            db_type: decrypted.db_type,
            host: typedArgs.host ?? decrypted.host,
            port: typedArgs.port ?? decrypted.port,
            username: typedArgs.username ?? decrypted.username,
            password: decrypted.password,
            database: decrypted.database_name || undefined,
          });
          connectionSuccess = testResult.success === true;
          connectionTestOutcome = connectionSuccess ? 'passed' : 'failed';
        }
      }

      const warning = connectionTestOutcome === 'failed'
        ? '配置已保存，但新连接测试失败'
        : connectionTestOutcome === 'unavailable'
          ? '配置已保存，但未能执行连接测试'
          : undefined;

      return {
        success: true,
        status: warning ? 'warning' : 'success',
        data: {
          instanceId,
          updatedFields,
          configSaved: true,
          connectionTested,
          connectionSuccess,
          connectionTestOutcome,
          ...(warning ? { warning } : {}),
        },
        next_actions: connectionTestOutcome === 'failed'
          ? ['配置已保存，不要再次提交本次更新；调用 slide_test_connection 单独验证连接']
          : connectionTestOutcome === 'unavailable'
            ? ['配置已保存，不要再次提交本次更新；连接测试未执行，调用 slide_test_connection 单独验证连接']
            : [],
        summary: warning ?? `✅ 成功更新实例配置：${updatedFields.join(', ')}`,
        details: {
          instanceId,
          updatedFields,
          connectionTested,
          connectionSuccess,
          connectionTestOutcome,
        },
      };
    } catch {
      // 异常原文可能含已保存的凭据，不能进入结果、审计或下一步建议。
      if (configCommitted) {
        return savedConfigVerificationWarning(instanceId, updatedFields, verificationStage ?? 'decrypt', credentialCommitted);
      }
      return {
        success: false,
        status: 'error',
        error: updateSubmitted ? '更新结果未知，必须先对账' : '更新失败，尚未提交配置',
        errorCode: updateSubmitted ? 'UPDATE_OUTCOME_UNKNOWN' : 'UPDATE_CONFIG_FAILED',
        details: { configCommitted: false, retryable: false },
        next_actions: ['先核对实例配置及引用状态，确认结果前不要重放写请求'],
      };
    }
  },
};

// ============== 辅助函数 ==============

/** 持久化已经完成。验证异常单独标出，不把更新说成失败，也不建议重放。 */
function savedConfigVerificationWarning(
  instanceId: number,
  updatedFields: string[],
  stage: 'decrypt' | 'connect',
  credentialConsumed: boolean,
): ToolResult {
  const verificationText = stage === 'connect'
    ? '连接验证异常'
    : '读取已保存配置以验证连接时发生异常';
  const warning = `配置已保存。${verificationText}，与配置是否已保存无关。不要再次提交本次更新。`;
  return {
    success: true,
    status: 'warning',
    summary: warning,
    data: {
      instanceId,
      updatedFields,
      configSaved: true,
      connectionTested: stage === 'connect',
      connectionSuccess: false,
      verification: { status: 'error', stage },
      warning,
    },
    details: {
      instanceId,
      updatedFields,
      configCommitted: true,
      configSaved: true,
      retryable: false,
      credentialConsumed,
    },
    next_actions: [
      '配置已保存，不要再次提交本次更新，不要申请新凭据重放同一更新',
      '调用 slide_test_connection 单独验证连接',
    ],
  };
}

/**
 * 按 trim 后的名称选择唯一可用实例。多环境同名不取第一条。
 * 调用者看不到至少两个可写匹配时，返回与不存在相同的结果，避免暴露无权限实例。
 */
async function resolveInstanceIdByName(
  name: string,
  actor: ActorContext | undefined,
): Promise<{ id: number } | { error: ToolResult }> {
  const normalized = name.trim();
  const matches = await instanceDatabaseService.listAvailableInstancesByNormalizedName(normalized);
  const notFound: ToolResult = {
    success: false,
    status: 'error',
    error: `未找到实例："${normalized}"`,
    errorCode: 'INSTANCE_NOT_FOUND',
    next_actions: ['先调用 list_database_instances 确认实例 ID 或名称'],
  };
  if (matches.length === 1 && actor && actorCanWriteInstance(actor, matches[0].id)) return { id: matches[0].id };
  const visible = actor ? matches.filter((match) => actorCanWriteInstance(actor, match.id)) : [];
  if (matches.length > 1 && visible.length >= 2) {
    return {
      error: {
        success: false,
        status: 'error',
        error: '同名实例存在于多个环境，请改用实例 ID',
        errorCode: 'AMBIGUOUS_INSTANCE_NAME',
        next_actions: ['使用 instance_id 指定要更新的实例，不要用新的 environment 选择现有实例'],
      },
    };
  }
  return { error: notFound };
}

// 注册工具到全局目录
toolCatalog.register(updateDbConfigTool);
