import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { InvestigationProblemStatusSchema } from './contracts.js';
import { instant, invalidObservation } from './observation-db.js';
import type { InvestigationFeedbackRequest, FeedbackVerification } from './feedback-types.js';
export type { InvestigationFeedbackRequest, InvestigationFeedbackRecord, FeedbackVerification } from './feedback-types.js';

const strict = { additionalProperties: false } as const;
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: '\\S' });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const uuid = Type.String({ pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' });
const refs = (minItems = 1) => Type.Array(uuid, { minItems, maxItems: 100, uniqueItems: true });
const verification = Type.Object({ method: text(2000), from: text(32), to: text(32), evidenceIds: refs(0), actionReport: Type.Optional(Type.Object({ id: uuid, version, hash: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, strict)) }, strict);
const common = { resultId: uuid, resultVersion: version, expectedVersion: version, note: text(4000) };

/** Human feedback never modifies an immutable machine result or publishes knowledge.
 * Server facts supply actor, verification time and the resulting revision. */
export const InvestigationFeedbackRequestSchema = Type.Union([
  Type.Object({ ...common, kind: Type.Literal('rating'), rating: Type.Union([
    Type.Literal('helpful'), Type.Literal('unhelpful'), Type.Literal('incorrect')]) }, strict),
  Type.Object({ ...common, kind: Type.Literal('handling'), performedAt: text(32), evidenceIds: refs(0) }, strict),
  Type.Object({ ...common, kind: Type.Literal('root_cause'), verification }, strict),
  Type.Object({ ...common, kind: Type.Literal('recovery'), verification }, strict),
  Type.Object({ ...common, kind: Type.Literal('close'), lifecycle: Type.Union([Type.Literal('closed'), Type.Literal('archived')]),
    problemStatus: InvestigationProblemStatusSchema, verification: Type.Optional(verification) }, strict),
], { $id: 'InvestigationFeedbackRequest' });
export const InvestigationFeedbackRecordSchema = Type.Object({
  id: uuid, investigationId: uuid, actorId: version, createdAt: text(32), version,
  command: InvestigationFeedbackRequestSchema, staleResult: Type.Boolean(), staleVerification: Type.Optional(Type.Boolean()),
  references: Type.Array(Type.Object({ id: uuid, status: Type.Union([Type.Literal('available'), Type.Literal('expired')]),
    contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, strict), { maxItems: 100 }),
  verification: Type.Optional(Type.Object({ ...verification.properties,
    verifiedBy: version, verifiedAt: text(32), status: Type.Literal('human_confirmed') }, strict)),
}, { $id: 'InvestigationFeedbackRecord', ...strict });
export const InvestigationFeedbackPageSchema = Type.Object({ items: Type.Array(InvestigationFeedbackRecordSchema, { maxItems: 50 }),
  nextBefore: Type.Union([version, Type.Null()]) }, { $id: 'InvestigationFeedbackPage', ...strict });
export const InvestigationFeedbackSchemas = { InvestigationFeedbackRequest: InvestigationFeedbackRequestSchema,
  InvestigationFeedbackRecord: InvestigationFeedbackRecordSchema, InvestigationFeedbackPage: InvestigationFeedbackPageSchema };
type SchemaRequest = Static<typeof InvestigationFeedbackRequestSchema>;
const transportParity: SchemaRequest extends InvestigationFeedbackRequest
  ? InvestigationFeedbackRequest extends SchemaRequest ? true : never : never = true;
void transportParity;

export function validateFeedback(value: unknown, now = Date.now()): InvestigationFeedbackRequest {
  if (!Value.Check(InvestigationFeedbackRequestSchema, value)) throw invalidObservation();
  if (value.kind === 'handling' && (!instant(value.performedAt) || Date.parse(value.performedAt) > now)) throw invalidObservation();
  if ('verification' in value && value.verification) {
    const { from, to, evidenceIds, actionReport } = value.verification;
    if (!evidenceIds.length && !actionReport || actionReport && !['close', 'recovery'].includes(value.kind)) throw invalidObservation();
    if (!instant(from) || !instant(to) || Date.parse(from) >= Date.parse(to) || Date.parse(to) > now) throw invalidObservation();
  }
  if (value.kind === 'close' && (value.problemStatus === 'resolved') !== !!value.verification) throw invalidObservation();
  return value;
}
export function feedbackEvidenceIds(command: InvestigationFeedbackRequest): string[] {
  return command.kind === 'handling' ? command.evidenceIds : 'verification' in command ? command.verification?.evidenceIds ?? [] : [];
}

/** At least one observation must cover the entire claimed recovery window.
 * Null/missing observations are unknown, never proof of restored service. */
export function coversRecoveryWindow(verification: FeedbackVerification, metadata: readonly {
  observedFrom: string | null; observedTo: string | null; collectedAt: string;
}[]): boolean {
  return metadata.some(row => row.observedFrom !== null && row.observedTo !== null
    && instant(row.observedFrom) && instant(row.observedTo) && instant(row.collectedAt)
    && Date.parse(row.observedFrom) <= Date.parse(verification.from)
    && Date.parse(row.observedTo) >= Date.parse(verification.to)
    && Date.parse(row.collectedAt) >= Date.parse(verification.to));
}
