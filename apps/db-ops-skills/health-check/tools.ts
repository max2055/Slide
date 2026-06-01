/**
 * 健康检查技能工具
 *
 * 组合多个工具执行健康检查工作流
 */

import type { AnyAgentTool } from '../../tools/types.js';

/**
 * 健康检查工作流工具
 */
export const healthCheckWorkflowTool: AnyAgentTool = {
  name: 'health_check_workflow',
  description: '执行完整的健康检查工作流，包括实例信息、指标和健康评分',
  parameters: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'number',
        description: '实例 ID，不传则检查所有实例',
      },
      db_type: {
        type: 'string',
        description: '数据库类型',
      },
      include_details: {
        type: 'boolean',
        description: '是否包含详细信息',
        default: false,
      },
    },
  },
  group: 'health_check',
  handler: async (args, context) => {
    const results: Array<{ name: string; result: unknown; success: boolean; error?: string }> = [];

    try {
      // Step 1: 获取实例信息
      const instanceResult = await context?.invokeTool?.('db_get_instance', args) || {
        success: false,
        error: 'invokeTool not available',
      };
      results.push({ name: 'db_get_instance', result: instanceResult, success: instanceResult.success });

      // Step 2: 获取性能指标
      const metricsResult = await context?.invokeTool?.('db_get_metrics', args) || {
        success: false,
        error: 'invokeTool not available',
      };
      results.push({ name: 'db_get_metrics', result: metricsResult, success: metricsResult.success });

      // Step 3: 执行健康检查
      const healthResult = await context?.invokeTool?.('db_health_check', args) || {
        success: false,
        error: 'invokeTool not available',
      };
      results.push({ name: 'db_health_check', result: healthResult, success: healthResult.success });

      // 生成摘要
      const successCount = results.filter(r => r.success).length;
      const summary = context?.generateSummary?.(results) || `执行 ${results.length} 个步骤，成功 ${successCount} 个`;

      return {
        success: results.every(r => r.success),
        summary,
        details: { results },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `健康检查工作流失败：${errorMessage}`,
      };
    }
  },
};

/**
 * 快速健康检查工具（简化版）
 */
export const quickHealthCheckTool: AnyAgentTool = {
  name: 'quick_health_check',
  description: '快速检查数据库健康状态',
  parameters: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'number',
        description: '实例 ID',
      },
    },
    required: ['instance_id'],
  },
  group: 'health_check',
  handler: async (args, context) => {
    try {
      // 直接调用健康检查工具
      const result = await context?.invokeTool?.('db_health_check', args) || {
        success: false,
        error: 'invokeTool not available',
      };

      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `快速健康检查失败：${errorMessage}`,
      };
    }
  },
};

// 导出工具数组
export const generatedTools: AnyAgentTool[] = [
  healthCheckWorkflowTool,
  quickHealthCheckTool,
];
