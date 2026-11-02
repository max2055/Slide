import { Type } from '@sinclair/typebox';
const fields = {
  eventId: Type.String(), component: Type.String(), occurredAt: Type.String(), summary: Type.String(), stableErrorCode: Type.String(),
  disposition: Type.Union([Type.Literal('accepted'), Type.Literal('linked'), Type.Literal('suppressed')]),
  suppressionReason: Type.Union([Type.String(), Type.Null()]), investigationId: Type.Union([Type.String(), Type.Null()]),
};
export const SystemEventSummarySchema = Type.Object(fields, { $id: 'SystemEventSummary', additionalProperties: false });
export const SystemEventDetailSchema = Type.Object({ ...fields, fact: Type.Unknown() }, { $id: 'SystemEventDetail', additionalProperties: false });
export const SystemEventsPageSchema = Type.Object({ items: Type.Array(SystemEventSummarySchema, { maxItems: 100 }), truncated: Type.Boolean() },
  { $id: 'SystemEventsPage', additionalProperties: false });
export const SystemDraftSchema = Type.Object({ id: Type.String(), eventId: Type.String(), modelInvoked: Type.Literal(false) }, { $id: 'SystemDraft', additionalProperties: false });
export const SystemVerificationRequestSchema = Type.Object({ investigationId: Type.String({ pattern: '^[a-f0-9-]{36}$' }), expectedVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, { $id: 'SystemVerificationRequest', additionalProperties: false });
export const SystemVerificationSchema = Type.Object({ id: Type.String(), eventId: Type.String(), investigationId: Type.String(), actorId: Type.Integer(), version: Type.Integer(),
  originalHash: Type.String(), releaseId: Type.Union([Type.String(), Type.Null()]), commitSha: Type.Union([Type.String(), Type.Null()]),
  from: Type.String(), to: Type.String(), verifiedAt: Type.String(),
  conclusion: Type.Union([Type.Literal('recovered'), Type.Literal('not_improved'), Type.Literal('insufficient_evidence')]),
  gaps: Type.Array(Type.String()), observation: Type.Unknown(), persistence: Type.Literal('process-local'), modelInvoked: Type.Literal(false),
}, { $id: 'SystemVerification', additionalProperties: false });
export const SystemInvestigationFactsSchema = Type.Object({ events: Type.Array(Type.Object({ eventId: Type.String(), fact: Type.Unknown(), returnTo: Type.String(), verifications: Type.Array(SystemVerificationSchema) }), { maxItems: 100 }), truncated: Type.Boolean(), modelInvoked: Type.Literal(false) }, { $id: 'SystemInvestigationFacts', additionalProperties: false });
export const SystemHttpSchemas = { SystemDraft: SystemDraftSchema, SystemVerificationRequest: SystemVerificationRequestSchema, SystemVerification: SystemVerificationSchema, SystemInvestigationFacts: SystemInvestigationFactsSchema, SystemEventSummary: SystemEventSummarySchema, SystemEventDetail: SystemEventDetailSchema, SystemEventsPage: SystemEventsPageSchema };
