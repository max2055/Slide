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
export const SystemHttpSchemas = { SystemEventSummary: SystemEventSummarySchema, SystemEventDetail: SystemEventDetailSchema, SystemEventsPage: SystemEventsPageSchema };
