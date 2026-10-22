import { z } from 'zod';
import type { InvestigationResult } from './contracts.js';

const text = z.string().trim().min(1).max(2000);
const refs = z.array(z.string().min(1).max(128)).max(20);
const assertion = z.strictObject({ statement: text, supportingToolCallIds: refs, contradictingToolCallIds: refs });
const schema = z.strictObject({ analysisVersion: z.literal(1), summary: text,
  claims: z.array(assertion).max(30), hypotheses: z.array(assertion).max(20),
  unresolvedQuestions: z.array(text).max(30),
  recommendations: z.array(z.strictObject({ action: text, priority: z.enum(['low', 'medium', 'high', 'critical']) })).max(30),
});

export const MODEL_ANALYSIS_POLICY = `
Batch default observations; query_metrics realtime defaults core, discover=extensions, inventory=attributes. Use returned metric IDs; do not repeat gaps. Finish within budget.
Final: one JSON object, no Markdown or extra keys at any level. Put ALL evidence gaps/uncertainty in unresolvedQuestions (string array), never evidenceGaps. Summary in Chinese: time, values, units, quality and gaps. Each claim MUST have a nonempty supportingToolCallIds. Cite returned call IDs from THIS execution only. Claims are inferences; hypotheses remain unverified. Never infer health from unknown.
Exact final output contract (the same strict schema used to publish results; unknown fields reject the entire analysis): ${JSON.stringify(z.toJSONSchema(schema, { reused: 'ref' }))}`;

/** The model supplies text, never authority or database identities. References
 * resolve exclusively through available evidence from the terminal execution. */
export function modelAnalysis(content: string, evidence: readonly any[]): Pick<InvestigationResult,
  'summary' | 'claims' | 'hypotheses' | 'unresolvedQuestions' | 'recommendations'> | null {
  let input: unknown;
  if (Buffer.byteLength(content) > 128_000) return null;
  try { input = JSON.parse(content); } catch { return null; }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return null;
  const bindings = new Map<string, string>();
  for (const row of evidence) {
    const metadata = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json;
    if (typeof metadata?.source === 'string' && metadata.source.startsWith('tool:')) bindings.set(metadata.source.slice(5), row.id);
  }
  const value = parsed.data;
  if ([...value.claims, ...value.hypotheses].some(a => [...a.supportingToolCallIds, ...a.contradictingToolCallIds].some(id => !bindings.has(id)))) return null;
  // A claim needs an observed basis even though it remains an inference.
  if (value.claims.some(a => !a.supportingToolCallIds.length)) return null;
  const references = (a: z.infer<typeof assertion>) => ({ statement: a.statement,
    supportingEvidenceIds: [...new Set(a.supportingToolCallIds.map(id => bindings.get(id)!))],
    contradictingEvidenceIds: [...new Set(a.contradictingToolCallIds.map(id => bindings.get(id)!))] });
  return { summary: value.summary, claims: value.claims.map(a => ({ ...references(a), kind: 'inference' })),
    hypotheses: value.hypotheses.map(a => ({ ...references(a), status: 'unknown' })),
    unresolvedQuestions: value.unresolvedQuestions, recommendations: value.recommendations };
}
