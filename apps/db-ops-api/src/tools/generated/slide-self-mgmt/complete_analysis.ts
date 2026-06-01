/**
 * slide_complete_analysis — Agent 分析完成后保存结果（Markdown 格式）
 */
import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { aiAnalysisDatabaseService } from '../../../ai-analysis-database-service.js';

export const completeAnalysisTool: AnyAgentTool = {
  name: 'slide_complete_analysis',
  description: '完成 AI 分析并将结果保存到数据库。分析结束后必须调用，否则分析不会保存。',
  parameters: {
    type: 'object',
    properties: {
      analysisId: { type: 'number', description: '分析记录 ID' },
      markdown: { type: 'string', description: '分析结果 Markdown 内容' },
    },
    required: ['analysisId', 'markdown'],
  },
  group: 'db_ops',
  handler: async (args) => {
    const typedArgs = args as unknown as {
      analysisId: number;
      markdown: string;
    };

    try {
      await aiAnalysisDatabaseService.completeAnalysis(typedArgs.analysisId, {
        result: typedArgs.markdown,
      });
      return {
        success: true,
        data: { saved: true, analysisId: typedArgs.analysisId },
        summary: '分析结果已保存',
      };
    } catch (error: any) {
      return {
        success: false,
        error: `保存分析结果失败: ${error.message}`,
      };
    }
  },
};

toolCatalog.register(completeAnalysisTool);
