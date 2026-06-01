/**
 * slide_complete_cron — Agent 完成定时任务后保存结果
 */
import type { AnyAgentTool } from '../tools/types.js';
import { toolCatalog } from '../tools/catalog.js';

export const completeCronTool: AnyAgentTool = {
  name: 'slide_complete_cron',
  description: '完成定时任务并将结果保存到日志。任务执行完毕后必须调用，否则结果不会保存。',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['success', 'failure', 'partial'],
        description: '任务执行状态',
      },
      summary: {
        type: 'string',
        description: '任务执行摘要',
      },
      details: {
        type: 'object',
        description: '详细分析数据',
      },
      result: {
        type: 'object',
        description: '结构化执行结果，必须符合 output_schema 定义的格式。包含 instances (total/succeeded/failed/failures[])、coverage_rate、以及其他任务特定字段。',
      },
    },
    required: ['status', 'summary'],
  },
  group: 'db_ops',
  handler: async (args) => {
    const typedArgs = args as unknown as {
      status: string;
      summary: string;
      details?: Record<string, unknown>;
      result?: Record<string, unknown>;
    };

    // Validate required fields
    if (!['success', 'failure', 'partial'].includes(typedArgs.status)) {
      return { success: false, error: '状态值无效，必须为 success/failure/partial' };
    }

    if (!typedArgs.summary || typedArgs.summary.trim().length === 0) {
      return { success: false, error: '摘要不能为空' };
    }

    return {
      success: true,
      data: { saved: true, status: typedArgs.status, result: typedArgs.result },
      summary: '定时任务结果已记录',
    };
  },
};

toolCatalog.register(completeCronTool);
