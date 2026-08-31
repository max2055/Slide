/**
 * 批量纳管数据库工具。
 *
 * 每个条目复用 slide_add_database 的完整业务流程，批量层只负责
 * 顺序调度和逐项结果聚合，避免单项失败中断其余实例。
 */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { addDatabaseTool } from './add_database.js';
import { agentToolIdempotencyService } from '../../../security/agent-tool-idempotency-service.js';

const MAX_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

type BatchDatabaseArgs = Record<string, unknown>;

type BatchItemResult = {
  index: number;
  status: 'created' | 'pending_credentials' | 'already_managed' | 'failed';
  instanceId?: number;
  name?: string;
  host?: string;
  port?: number;
  dbType?: string;
  errorCode?: string;
  reason?: string;
  retryable: boolean;
};

export const addDatabaseBatchTool: AnyAgentTool = {
  name: 'slide_add_database_batch',
  description: '批量纳管数据库实例，逐项返回创建、已存在或失败结果；单项失败不会中断其他实例',
  parameters: {
    type: 'object',
    properties: {
      databases: {
        type: 'array',
        description: `待纳管实例列表，最多 ${MAX_BATCH_SIZE} 项；每项参数与 slide_add_database 相同`,
        items: {
          type: 'object',
          properties: {
            db_type: { type: 'string', description: '数据库类型' },
            name: { type: 'string', description: '实例名称（可选）' },
            host: { type: 'string', description: '数据库主机地址' },
            port: { type: 'number', description: '数据库端口' },
            username: { type: 'string', description: '数据库用户名' },
            credential_ref: { type: 'string', description: '短期单次凭据引用（可选）' },
            database_name: { type: 'string', description: '数据库名称（可选）' },
            environment: { type: 'string', description: '环境（可选）' },
            description: { type: 'string', description: '实例描述（可选）' },
          },
          required: ['db_type', 'host', 'port', 'username'],
        },
      },
      concurrency: {
        type: 'number',
        description: `并发执行数，范围 1-${MAX_CONCURRENCY}，默认 ${DEFAULT_CONCURRENCY}`,
        default: DEFAULT_CONCURRENCY,
      },
    },
    required: ['databases'],
  },
  group: 'db_ops',
  requiresApproval: false,
  handler: async (args, context): Promise<ToolResult<{ total: number; succeeded: number; failed: number; results: BatchItemResult[] }>> => {
    if (!context?.actor) {
      return { success: false, status: 'error', error: '缺少已认证的操作员上下文', errorCode: 'MISSING_ACTOR', next_actions: ['通过已认证的 Agent 会话调用此工具'] };
    }
    const databases = args?.databases;
    if (!Array.isArray(databases) || databases.length === 0 || databases.length > MAX_BATCH_SIZE) {
      return {
        success: false,
        status: 'error',
        error: `databases 必须是 1-${MAX_BATCH_SIZE} 项的数组`,
        errorCode: 'INVALID_ARGUMENTS',
        details: { terminal: true, retryable: false },
      };
    }

    const requestedConcurrency = args.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(args.concurrency);
    if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > MAX_CONCURRENCY) {
      return {
        success: false,
        status: 'error',
        error: `concurrency 必须是 1-${MAX_CONCURRENCY} 的整数`,
        errorCode: 'INVALID_ARGUMENTS',
        details: { terminal: true, retryable: false },
      };
    }

    let idempotencyHash: string | undefined;
    const idempotencyKey = context.idempotencyKey;
    if (idempotencyKey && context.sessionId) {
      try {
        const claim = await agentToolIdempotencyService.claim(context.actor.userId, context.sessionId, 'slide_add_database_batch', idempotencyKey, args);
        if (claim.kind === 'completed') return claim.result as ToolResult<{ total: number; succeeded: number; failed: number; results: BatchItemResult[] }>;
        if (claim.kind === 'conflict') {
          return { success: false, status: 'error', errorCode: 'IDEMPOTENCY_KEY_CONFLICT', error: '幂等键已用于不同的批量参数', next_actions: ['使用新的幂等键提交不同批量'] };
        }
        if (claim.kind === 'in_progress') {
          return { success: false, status: 'warning', errorCode: 'IDEMPOTENCY_IN_PROGRESS', error: '相同批量请求正在执行', next_actions: ['等待原请求完成后查询结果，不要重复提交'] };
        }
        idempotencyHash = claim.argumentsHash;
      } catch (error) {
        return { success: false, status: 'error', errorCode: 'IDEMPOTENCY_STORAGE_UNAVAILABLE', error: error instanceof Error ? error.message : String(error), next_actions: ['恢复幂等记录存储后重试'] };
      }
    }

    const results: Array<BatchItemResult | undefined> = new Array(databases.length);
    let nextIndex = 0;
    let completed = 0;
    const emitProgress = async (index: number, item: BatchItemResult): Promise<void> => {
      completed += 1;
      try {
        await context.progressCallback?.({
          type: 'tool_progress',
          toolName: 'slide_add_database_batch',
          completed,
          total: databases.length,
          index,
          item,
        });
      } catch {
        // Observability must never change the outcome of a database operation.
      }
    };
    const processOne = async (index: number): Promise<void> => {
      const item = databases[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        const itemResult: BatchItemResult = {
          index,
          status: 'failed',
          reason: '批量条目必须是 JSON 对象',
          errorCode: 'INVALID_ARGUMENTS',
          retryable: false,
        };
        results[index] = itemResult;
        await emitProgress(index, itemResult);
        return;
      }

      const itemArgs = item as BatchDatabaseArgs;
      try {
        const result = await addDatabaseTool.handler(itemArgs, context);
        results[index] = toBatchItemResult(index, itemArgs, result);
      } catch (error: unknown) {
        results[index] = {
          index,
          status: 'failed',
          ...(typeof itemArgs.host === 'string' ? { host: itemArgs.host } : {}),
          ...(typeof itemArgs.port === 'number' ? { port: itemArgs.port } : {}),
          ...(typeof itemArgs.db_type === 'string' ? { dbType: itemArgs.db_type } : {}),
          errorCode: 'BATCH_ITEM_FAILED',
          reason: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
      }
      await emitProgress(index, results[index]!);
    };

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= databases.length) return;
        if (context.signal?.aborted) {
          const cancelled: BatchItemResult = {
            index,
            status: 'failed',
            errorCode: 'BATCH_CANCELLED',
            reason: '批量操作已取消，条目尚未开始执行',
            retryable: true,
          };
          results[index] = cancelled;
          await emitProgress(index, cancelled);
          continue;
        }
        await processOne(index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(requestedConcurrency, databases.length) }, () => worker()));

    const finalizedResults = results as BatchItemResult[];
    const failed = finalizedResults.filter((result) => result.status === 'failed');
    const succeeded = finalizedResults.length - failed.length;
    const retryable = failed.some((result) => result.retryable);
    const finalResult: ToolResult<{ total: number; succeeded: number; failed: number; results: BatchItemResult[] }> = {
      // A batch is a completed operation even when some items failed. Keep
      // partial results non-fatal so the Agent does not replay successful items.
      success: true,
      status: failed.length === 0 ? 'success' : 'warning',
      data: {
        total: results.length,
        succeeded,
        failed: failed.length,
        results: finalizedResults,
      },
      summary: `批量纳管完成：${succeeded} 项成功，${failed.length} 项失败`,
      details: {
        terminal: !retryable,
        retryable,
        total: results.length,
        succeeded,
        failed: failed.length,
      },
      next_actions: failed.length > 0
        ? ['逐项处理 results 中 status=failed 的条目；仅对 retryable=true 且已修正原因的条目重试']
        : [],
    };
    if (idempotencyKey && context.sessionId && idempotencyHash) {
      await agentToolIdempotencyService.finish(context.actor.userId, context.sessionId, 'slide_add_database_batch', idempotencyKey, idempotencyHash, 'completed', finalResult);
    }
    return finalResult;
  },
};

function toBatchItemResult(
  index: number,
  args: BatchDatabaseArgs,
  result: ToolResult,
): BatchItemResult {
  const data = isRecord(result.data) ? result.data : {};
  const details = isRecord(result.details) ? result.details : {};
  const connectionStatus = typeof data.connectionStatus === 'string' ? data.connectionStatus : '';
  const status = result.success
    ? connectionStatus === 'pending_credentials' ? 'pending_credentials' : 'created'
    : result.errorCode === 'INSTANCE_EXISTS' ? 'already_managed' : 'failed';
  const retryable = details.retryable === true || (result.errorCode === 'CREATE_INSTANCE_FAILED' && details.retryable !== false);

  return {
    index,
    status,
    ...(typeof data.instanceId === 'number' ? { instanceId: data.instanceId } : {}),
    ...(typeof data.name === 'string' ? { name: data.name } : typeof args.name === 'string' ? { name: args.name } : {}),
    ...(typeof args.host === 'string' ? { host: args.host } : {}),
    ...(typeof args.port === 'number' ? { port: args.port } : {}),
    ...(typeof args.db_type === 'string' ? { dbType: args.db_type } : {}),
    ...(!result.success && result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(!result.success && result.error ? { reason: result.error } : {}),
    retryable,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

toolCatalog.register(addDatabaseBatchTool);
