/**
 * slide_complete_analysis — Agent analysis completion with a validated envelope.
 */
import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { completeAnalysisParameters } from '../../../analysis/analysis-completion-contract.js';

export const completeAnalysisTool: AnyAgentTool = {
  name: 'slide_complete_analysis',
  description: '完成 AI 分析并将结构化 AnalysisEnvelope 保存到数据库。必须在分析完成后调用。',
  parameters: completeAnalysisParameters,
  group: 'db_ops',
  handler: async () => ({ success: false, errorCode: 'ANALYSIS_EXECUTION_CONTEXT_REQUIRED', error: 'ANALYSIS_EXECUTION_CONTEXT_REQUIRED' }),
};

toolCatalog.register(completeAnalysisTool);
