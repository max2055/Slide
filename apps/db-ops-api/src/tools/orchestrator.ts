/**
 * DB-Ops 工具编排器
 *
 * 复用 OpenClaw 的 tool orchestration 机制：
 * - 链式调用多个工具
 * - 聚合工具结果
 * - 生成执行摘要
 * - 支持快速失败和继续执行策略
 */

import type { AnyAgentTool, ToolResult, ToolExecutionContext } from './types.js';
import { toolCatalog } from './catalog.js';

// ============== 工具编排器类型 ==============

/**
 * 工具步骤定义
 */
export interface ToolStep {
  /** 步骤名称 */
  name: string;
  /** 工具名称 */
  toolName: string;
  /** 工具参数（支持函数动态生成） */
  args?: Record<string, unknown> | ((previousResults: ToolStepResult[]) => Record<string, unknown>);
  /** 是否可选（失败不中断） */
  optional?: boolean;
  /** 步骤描述 */
  description?: string;
}

/**
 * 工具步骤执行结果
 */
export interface ToolStepResult {
  /** 步骤名称 */
  name: string;
  /** 工具名称 */
  toolName: string;
  /** 执行结果 */
  result: ToolResult;
  /** 是否成功 */
  success: boolean;
  /** 执行耗时（毫秒） */
  executionTime: number;
  /** 错误信息（如果有） */
  error?: string;
}

/**
 * 工具编排执行结果
 */
export interface OrchestrationResult {
  /** 是否全部成功 */
  success: boolean;
  /** 步骤结果列表 */
  steps: ToolStepResult[];
  /** 执行摘要 */
  summary: string;
  /** 详细数据（可选） */
  data?: unknown;
  /** 总执行耗时（毫秒） */
  totalExecutionTime: number;
}

/**
 * 编排器上下文
 */
export interface OrchestratorContext extends ToolExecutionContext {
  /**  invokeTool 函数（用于链式调用） */
  invokeTool: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /** 生成摘要函数 */
  generateSummary: (results: ToolStepResult[]) => string;
}

// ============== 工具编排器 ==============

/**
 * 工具编排器类
 *
 * 使用示例：
 * ```typescript
 * const orchestrator = new ToolOrchestrator();
 * const result = await orchestrator.execute([
 *   { name: 'step1', toolName: 'check_status', args: {} },
 *   { name: 'step2', toolName: 'get_metrics', args: { instance_id: 1 } },
 *   { name: 'step3', toolName: 'run_diagnosis', optional: true },
 * ]);
 * ```
 */
export class ToolOrchestrator {
  /**
   * 执行工具编排
   *
   * @param steps 工具步骤列表
   * @param context 执行上下文
   * @param options 编排选项
   */
  async execute(
    steps: ToolStep[],
    context?: OrchestratorContext,
    options?: {
      /** 失败策略：'fail-fast' | 'continue'，默认 'fail-fast' */
      failureStrategy?: 'fail-fast' | 'continue';
      /** 超时时间（毫秒） */
      timeout?: number;
    },
  ): Promise<OrchestrationResult> {
    const failureStrategy = options?.failureStrategy ?? 'fail-fast';
    const startTime = Date.now();
    const results: ToolStepResult[] = [];

    for (const step of steps) {
      // 计算超时
      if (options?.timeout) {
        const elapsed = Date.now() - startTime;
        if (elapsed > options.timeout) {
          results.push({
            name: step.name,
            toolName: step.toolName,
            result: {
              success: false,
              error: `执行超时（已耗时 ${elapsed}ms）`,
              errorCode: 'TIMEOUT',
            },
            success: false,
            executionTime: 0,
            error: `执行超时`,
          });
          break;
        }
      }

      // 解析参数
      const args = typeof step.args === 'function'
        ? step.args(results)
        : (step.args ?? {});

      // 执行工具
      const stepStartTime = Date.now();
      let result: ToolResult;

      try {
        if (context?.invokeTool) {
          result = await context.invokeTool(step.toolName, args);
        } else {
          // 直接调用 toolCatalog
          const tool = toolCatalog.get(step.toolName);
          if (!tool) {
            result = {
              success: false,
              error: `工具不存在：${step.toolName}`,
              errorCode: 'TOOL_NOT_FOUND',
            };
          } else {
            result = await tool.handler(args, context);
          }
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result = {
          success: false,
          error: `工具执行异常：${errorMessage}`,
          errorCode: 'TOOL_EXECUTION_ERROR',
        };
      }

      const executionTime = Date.now() - stepStartTime;

      const stepResult: ToolStepResult = {
        name: step.name,
        toolName: step.toolName,
        result,
        success: result.success,
        executionTime,
        error: result.error,
      };

      results.push(stepResult);

      // 处理失败
      if (!result.success) {
        if (step.optional) {
          // 可选步骤，记录警告但继续
          console.warn(`[ToolOrchestrator] 可选步骤 "${step.name}" 执行失败：${result.error}`);
        } else if (failureStrategy === 'fail-fast') {
          // 必需步骤失败，快速失败
          console.warn(`[ToolOrchestrator] 步骤 "${step.name}" 执行失败，终止编排：${result.error}`);
          break;
        }
        // failureStrategy === 'continue' 时继续执行
      }
    }

    const totalExecutionTime = Date.now() - startTime;

    // 生成摘要
    const summary = context?.generateSummary?.(results) ?? this.generateDefaultSummary(results);

    // 判断整体成功状态
    const success = results.every(r => r.success);

    return {
      success,
      steps: results,
      summary,
      totalExecutionTime,
    };
  }

  /**
   * 生成默认摘要
   */
  private generateDefaultSummary(results: ToolStepResult[]): string {
    const totalSteps = results.length;
    const successSteps = results.filter(r => r.success).length;
    const failedSteps = results.filter(r => !r.success);
    const totalTime = results.reduce((sum, r) => sum + r.executionTime, 0);

    if (successSteps === totalSteps) {
      return `执行 ${totalSteps} 个步骤，全部成功，耗时 ${totalTime}ms`;
    }

    if (failedSteps.length > 0) {
      const errors = failedSteps.map(r => `${r.name}: ${r.error}`).join('; ');
      return `执行 ${totalSteps} 个步骤，${successSteps} 个成功，${failedSteps.length} 个失败：${errors}`;
    }

    return `执行 ${totalSteps} 个步骤，${successSteps} 个成功`;
  }

  /**
   * 从结果中提取指定步骤的数据
   *
   * @param result 编排结果
   * @param stepName 步骤名称
   */
  extractStepData<T = unknown>(result: OrchestrationResult, stepName: string): T | undefined {
    const step = result.steps.find(s => s.name === stepName);
    if (!step || !step.result.success) {
      return undefined;
    }
    return step.result.data as T;
  }

  /**
   * 聚合多个步骤的结果
   *
   * @param results 步骤结果列表
   * @param aggregator 聚合函数
   */
  aggregateResults<T = unknown>(
    results: ToolStepResult[],
    aggregator: (results: ToolStepResult[]) => T,
  ): T {
    return aggregator(results);
  }
}

// ============== 辅助函数 ==============

/**
 * 创建简单的 invokeTool 函数
 */
export function createSimpleInvokeTool(): (toolName: string, args: Record<string, unknown>) => Promise<ToolResult> {
  return async (toolName, args) => {
    const tool = toolCatalog.get(toolName);
    if (!tool) {
      return {
        success: false,
        error: `工具不存在：${toolName}`,
        errorCode: 'TOOL_NOT_FOUND',
      };
    }
    return tool.handler(args, {});
  };
}

/**
 * 创建默认的编排器上下文
 */
export function createDefaultContext(): OrchestratorContext {
  const invokeTool = createSimpleInvokeTool();

  return {
    invokeTool,
    generateSummary: (results) => {
      const successCount = results.filter(r => r.success).length;
      return `执行 ${results.length} 个步骤，成功 ${successCount} 个`;
    },
  };
}

// ============== 导出 ==============

export const orchestrator = new ToolOrchestrator();
