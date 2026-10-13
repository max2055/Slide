import { Type } from '@sinclair/typebox';
import { InvestigationResultSchema, InvestigationStreamEventSchema } from './contracts.js';
const strict = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 128 });
const ordinal = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const utc = Type.String({ format: 'date-time' });
const resource = Type.Object({ type: Type.Union([Type.Literal('instance'), Type.Literal('server'), Type.Literal('network_device')]), id: Type.Integer({ minimum: 1 }) }, strict);
export const InvestigationEvidenceSchema = Type.Object({
  id, investigationId: id, requestId: id, runId: id, source: Type.String({ maxLength: 128 }), summary: Type.String({ maxLength: 2000 }),
  resources: Type.Array(resource, { maxItems: 20 }), observedFrom: Type.Union([utc, Type.Null()]), observedTo: Type.Union([utc, Type.Null()]), collectedAt: utc,
  contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }), expiresAt: utc, status: Type.Union([Type.Literal('available'), Type.Literal('expired')]),
  expiryReason: Type.Optional(Type.Literal('RETENTION_EXPIRED')), raw: Type.Optional(Type.Unknown()),
}, { $id: 'InvestigationEvidence', ...strict });
export const InvestigationReplaySchema = Type.Object({ events: Type.Array(InvestigationStreamEventSchema, { maxItems: 200 }), nextCursor: ordinal,
  hasMore: Type.Boolean(), replayRequired: Type.Boolean(), watermark: ordinal, code: Type.Optional(Type.Literal('replay_required')) }, { $id: 'InvestigationReplay', ...strict });
export const VersionedInvestigationResultSchema = Type.Object({ id, investigationId: id, requestId: id, runId: id,
  version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), result: InvestigationResultSchema }, { $id: 'VersionedInvestigationResult', ...strict });
export const InvestigationResultPageSchema = Type.Object({ items: Type.Array(VersionedInvestigationResultSchema, { maxItems: 50 }),
  nextBefore: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]) }, { $id: 'InvestigationResultPage', ...strict });
export const InvestigationWatchSchema = Type.Object({ type: Type.Literal('investigation.watch'), id, afterSequence: Type.Optional(ordinal) }, { $id: 'InvestigationWatch', ...strict });
export const InvestigationUnwatchSchema = Type.Object({ type: Type.Literal('investigation.unwatch'), id: Type.Optional(id) }, { $id: 'InvestigationUnwatch', ...strict });
export const InvestigationObservationSchemas = { InvestigationEvidence: InvestigationEvidenceSchema, InvestigationReplay: InvestigationReplaySchema,
  VersionedInvestigationResult: VersionedInvestigationResultSchema, InvestigationResultPage: InvestigationResultPageSchema,
  InvestigationWatch: InvestigationWatchSchema, InvestigationUnwatch: InvestigationUnwatchSchema };
