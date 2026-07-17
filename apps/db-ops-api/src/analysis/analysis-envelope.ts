import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const ANALYSIS_ENVELOPE_VERSION = 1;

const ResourceRef = Type.Object({
  type: Type.Union([Type.Literal('instance'), Type.Literal('server')]),
  id: Type.Integer({ minimum: 1 }),
});

const Hypothesis = Type.Object({
  statement: Type.String({ minLength: 1, maxLength: 2_000 }),
  status: Type.Union([Type.Literal('supported'), Type.Literal('refuted'), Type.Literal('unknown')]),
});

const EvidenceRef = Type.Object({
  ref: Type.String({ minLength: 1, maxLength: 512 }),
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
});

const Recommendation = Type.Object({
  action: Type.String({ minLength: 1, maxLength: 2_000 }),
  priority: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('critical')]),
});

export const AnalysisEnvelopeSchema = Type.Object({
  schemaVersion: Type.Literal(ANALYSIS_ENVELOPE_VERSION),
  analysisType: Type.String({ minLength: 1, maxLength: 100 }),
  subject: ResourceRef,
  conclusions: Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 50 }),
  hypotheses: Type.Array(Hypothesis, { maxItems: 50 }),
  evidenceRefs: Type.Array(EvidenceRef, { maxItems: 100 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  recommendations: Type.Array(Recommendation, { maxItems: 50 }),
  displayMarkdown: Type.String({ maxLength: 100_000 }),
  provenance: Type.Object({
    modelVersion: Type.String({ minLength: 1, maxLength: 256 }),
    promptVersion: Type.String({ minLength: 1, maxLength: 256 }),
    toolVersions: Type.Record(Type.String({ maxLength: 128 }), Type.String({ maxLength: 128 }), { maxProperties: 100 }),
  }),
  createdAt: Type.String({ minLength: 20, maxLength: 64 }),
}, { additionalProperties: false });

export type AnalysisEnvelope = Static<typeof AnalysisEnvelopeSchema>;

export type AnalysisView =
  | { kind: 'envelope'; displayMarkdown: string; envelope: AnalysisEnvelope }
  | { kind: 'legacy'; displayMarkdown: string; envelope: null };

export function validateAnalysisEnvelope(value: unknown):
  | { ok: true; value: AnalysisEnvelope }
  | { ok: false; error: string } {
  if (!Value.Check(AnalysisEnvelopeSchema, value)
    || Number.isNaN(Date.parse((value as { createdAt?: unknown })?.createdAt as string))) {
    return { ok: false, error: 'ANALYSIS_ENVELOPE_INVALID' };
  }
  return { ok: true, value: value as AnalysisEnvelope };
}

export function asAnalysisView(envelope: unknown, legacyMarkdown: unknown): AnalysisView {
  const parsed = validateAnalysisEnvelope(envelope);
  if (parsed.ok) {
    return { kind: 'envelope', displayMarkdown: parsed.value.displayMarkdown, envelope: parsed.value };
  }
  return { kind: 'legacy', displayMarkdown: typeof legacyMarkdown === 'string' ? legacyMarkdown : '', envelope: null };
}
