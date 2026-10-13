import { Type } from '@sinclair/typebox';
const strict = { additionalProperties: false };
const uuid = Type.String({ pattern: '^[a-f0-9-]{36}$' });
const ordinal = Type.Integer({ minimum: 1 });
export const LegacyAnalysisLinkSchema = Type.Object({ id: uuid, investigationId: uuid, analysisId: ordinal,
  legacy: Type.Literal(true), readOnly: Type.Literal(true) }, { ...strict, $id: 'LegacyAnalysisLink' });
export const AlertInvestigationResponseSchema = Type.Object({ success: Type.Boolean(),
  id: Type.Optional(Type.Union([uuid, ordinal])), investigationId: Type.Optional(uuid), requestId: Type.Optional(uuid),
  analysisId: Type.Optional(ordinal), sessionKey: Type.Optional(Type.String()), session_key: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()), disposition: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
}, { ...strict, $id: 'AlertInvestigationResponse' });
export const InvestigationBridgeSchemas = { LegacyAnalysisLink: LegacyAnalysisLinkSchema, AlertInvestigationResponse: AlertInvestigationResponseSchema };
