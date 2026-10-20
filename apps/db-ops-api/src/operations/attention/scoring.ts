import { OperationsError } from '../contracts.js';

export const SCORE_RULE = 'severity-fixed-50-20-15-15/1.0.0';
export const severityOrder = { critical: 3, error: 2, warning: 1, info: 0 } as const;
export type AttentionSeverity = keyof typeof severityOrder;
export interface ScoreInputs { severity: AttentionSeverity; impact: number | null; persistence: number | null; baseline: number | null }
export interface AttentionScore { lower: number; upper: number; coverage: number;
  components: { severity: number; impact: number | null; persistence: number | null; baseline: number | null } }
const round = (n: number) => Math.round(n * 10_000) / 10_000;
/** Inputs are normalized facts, never inferred business value. Missing weights
 * remain intervals, including when every non-severity fact is unknown. */
export function scoreAttention(input: ScoreInputs): AttentionScore {
  if (!Object.hasOwn(severityOrder, input.severity)) throw new OperationsError('OPERATIONS_INPUT_INVALID');
  const components: AttentionScore['components'] = { severity: 50 * severityOrder[input.severity] / 3,
    impact: null, persistence: null, baseline: null };
  let lower = components.severity, missing = 0;
  for (const [key, weight] of [['impact', 20], ['persistence', 15], ['baseline', 15]] as const) {
    const value = input[key];
    if (value === null) { missing += weight; continue; }
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    components[key] = round(value * weight); lower += components[key]!;
  }
  return { lower: round(lower), upper: round(lower + missing), coverage: (100 - missing) / 100, components };
}
export function compareAttention(a: { severity: AttentionSeverity; score: AttentionScore; firstObservedAt: string; id: string },
  b: { severity: AttentionSeverity; score: AttentionScore; firstObservedAt: string; id: string }): number {
  return severityOrder[b.severity] - severityOrder[a.severity] || b.score.lower - a.score.lower
    || Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt) || compareId(a.id, b.id);
}
export const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
