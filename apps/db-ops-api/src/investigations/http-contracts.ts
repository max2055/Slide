import { Type, type Static } from '@sinclair/typebox';
import { InvestigationSubjectSchema, InvestigationLifecycleSchema } from './contracts.js';

const strict = { additionalProperties: false } as const;
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: '\\S' });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const resource = Type.Object({ type: Type.Union([Type.Literal('instance'), Type.Literal('server'), Type.Literal('network_device')]),
  id: Type.Integer({ minimum: 1, maximum: 4_294_967_295 }), role: Type.Union([Type.Literal('primary'), Type.Literal('related')]) }, strict);
export const InvestigationCreateRequestSchema = Type.Object({ title: text(200), goal: text(2_000),
  profileId: Type.Union([Type.Literal('ops'), Type.Literal('system')]), subject: InvestigationSubjectSchema,
  resourceRefs: Type.Array(resource, { maxItems: 20 }), sessionId: Type.Optional(text(100)),
  from: Type.Optional(text(32)), to: Type.Optional(text(32)),
}, { $id: 'InvestigationCreateRequest', ...strict });
export const InvestigationRequestSchema = Type.Object({ message: text(2_000), expectedVersion: version,
  continuationOf: Type.Optional(Type.Object({ requestId: text(36), runId: text(36), resultVersion: version, notAfter: Type.Optional(text(32)) }, strict)) },
  { $id: 'InvestigationRequest', ...strict });
export const InvestigationPatchRequestSchema = Type.Object({ expectedVersion: version,
  title: Type.Optional(text(200)), goal: Type.Optional(text(2_000)), lifecycle: Type.Optional(InvestigationLifecycleSchema),
}, { $id: 'InvestigationPatchRequest', ...strict });
export const InvestigationAcceptedSchema = Type.Object({ id: text(36), investigationId: text(36), sessionId: text(100),
  requestId: text(36), jobId: text(36), version }, { $id: 'InvestigationAccepted', ...strict });
export const InvestigationHttpSchemas = { InvestigationCreateRequest: InvestigationCreateRequestSchema,
  InvestigationRequest: InvestigationRequestSchema, InvestigationPatchRequest: InvestigationPatchRequestSchema,
  InvestigationAccepted: InvestigationAcceptedSchema };
export type InvestigationCreateRequest = Static<typeof InvestigationCreateRequestSchema>;
