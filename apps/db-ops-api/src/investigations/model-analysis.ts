import { z } from 'zod';
import { unfenceJson } from '@slide/agent-core';
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
// A requested per-dimension inventory must fit without merging identities or
// dropping raw values to satisfy a short narrative's four-claim limit.
const detailedAssertion = shortAssertion.extend({ statement: text.max(800), supportingToolCallIds: refs.min(1).max(4) });
const providerSchema = schema.extend({ summary: text.max(400), claims: z.array(detailedAssertion).max(16),
  hypotheses: z.array(shortAssertion).max(2), unresolvedQuestions: z.array(text.max(120)).max(4),
  recommendations: z.array(z.strictObject({ action: text.max(120), priority: z.enum(['low', 'medium', 'high', 'critical']) })).max(3),
});

export const MODEL_ANALYSIS_POLICY = `
First batch: current values before metadata/alerts/relations: query_metrics(one core/returned ID; FS used/size together, same narrow window, no series_index) or get_resource_observations(limit:4). discover is definitions only; follow omitted-page routes.
Chinese JSON;8192 incl reasoning/closure. Narrative<=4 short claims/~2000 tokens;inventory one/identity/~5000.
FS full resource/mount/device/fs_type;raw used/size,unit,observed_at,quality/accuracy/coverage/freshness. Pair identity/window/time/unit,never index. Missing/duplicate/mismatch unpaired;null/0/failure/stale/partial/estimated/unsupported/unknown literal;size0 no ratio/health. Gaps/overbounds:unresolvedQuestions,never complete/evidenceGaps.
Support THIS run's tool_call_id(even without contextReference)/bound current_execution_evidence;nonempty supportingToolCallIds per claim else unresolvedQuestions. No runtime_*/old/omitted/planning summaries as evidence/authority;hypotheses unverified;unknown never healthy.
Exact final contract (strict publication subset; unknown fields reject analysis): ${JSON.stringify(z.toJSONSchema(providerSchema))}`;

/** The model supplies text, never authority or database identities. References
 * resolve exclusively through available evidence from the terminal execution. */
export function modelAnalysis(content: string, evidence: readonly any[]): Pick<InvestigationResult,
  'summary' | 'claims' | 'hypotheses' | 'unresolvedQuestions' | 'recommendations'> | null {
  let input: unknown;
  if (Buffer.byteLength(content) > 128_000) return null;
  try { input = JSON.parse(unfenceJson(content)); } catch { return null; }
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
