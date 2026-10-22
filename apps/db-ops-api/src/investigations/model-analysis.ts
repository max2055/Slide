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

// Provider planning is a strict subset of the publication contract. Existing
// valid persisted analyses remain compatible with the original validator.
const concise = z.string().trim().min(1).max(160);
const shortAssertion = assertion.extend({ statement: concise, supportingToolCallIds: refs.max(4), contradictingToolCallIds: refs.max(4) });
const providerSchema = schema.extend({ summary: text.max(400), claims: z.array(shortAssertion).max(4),
  hypotheses: z.array(shortAssertion).max(2), unresolvedQuestions: z.array(text.max(120)).max(4),
  recommendations: z.array(z.strictObject({ action: text.max(120), priority: z.enum(['low', 'medium', 'high', 'critical']) })).max(3),
});

export const MODEL_ANALYSIS_POLICY = `
Batch default observations; query_metrics realtime defaults core, discover=extensions, inventory=attributes. Use returned metric IDs; do not repeat gaps. Finish within budget.
Final: one concise JSON object, no Markdown or extra keys at any level. The 8192 output ceiling includes reasoning: aim for <=2000 visible tokens, reserve room to close ALL fields. Do not reproduce evidence tables or repeat the same gap in summary/claims/questions. Prefer fewer supported claims; empty hypotheses are valid when nothing is supported. Keep summary<=400 characters, claims<=4, hypotheses<=2 (statements<=160 characters), unresolvedQuestions<=4 and recommendations<=3 (each<=120 characters). Put ALL evidence gaps/uncertainty in unresolvedQuestions (string array), never evidenceGaps. Summary in Chinese: time, values, units, quality and gaps. Each claim MUST have a nonempty supportingToolCallIds. Cite returned call IDs from THIS execution only. Claims are inferences; hypotheses remain unverified. Never infer health from unknown.
Exact final output contract (a bounded subset of the strict publication schema; unknown fields reject the entire analysis): ${JSON.stringify(z.toJSONSchema(providerSchema, { reused: 'ref' }))}`;

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
