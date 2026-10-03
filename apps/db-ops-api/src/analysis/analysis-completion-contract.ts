import type { ToolParameterSchema } from '../tools/types.js';
import { AnalysisEnvelopeSchema } from './analysis-envelope.js';
/** Source definition consumed by the generated tool and DirectAdapter alike. */
export const completeAnalysisParameters: ToolParameterSchema = {
  type: 'object', 
  properties: {
    analysisId: { type: 'number', description: '服务端分配的分析记录 ID' },
    envelope: { ...AnalysisEnvelopeSchema, description: 'Versioned envelope. Provenance and verification are replaced by trusted server execution context.' },
  },
  required: ['analysisId', 'envelope'],
};
