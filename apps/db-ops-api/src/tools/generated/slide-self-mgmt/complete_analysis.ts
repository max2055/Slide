/**
 * slide_complete_analysis — Agent analysis completion with a validated envelope.
 */
import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { aiAnalysisDatabaseService } from '../../../ai-analysis-database-service.js';

export const completeAnalysisTool: AnyAgentTool = {
  name: 'slide_complete_analysis',
  description: '完成 AI 分析并将结构化 AnalysisEnvelope 保存到数据库。必须在分析完成后调用。',
  parameters: {
    type: 'object',
    properties: {
      analysisId: { type: 'number', description: '分析记录 ID' },
      envelope: { type: 'object', description: 'Versioned structured AnalysisEnvelope' },
    },
    required: ['analysisId', 'envelope'],
  },
  group: 'db_ops',
  handler: async (args) => {
    const typedArgs = args as unknown as {
      analysisId: number;
      envelope: unknown;
    };

    try {
      const saved = await aiAnalysisDatabaseService.completeAnalysisEnvelope(typedArgs.analysisId, typedArgs.envelope);
      if (!saved.success) return { success: false, error: `保存分析结果失败: ${saved.error || 'unknown error'}` };
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
