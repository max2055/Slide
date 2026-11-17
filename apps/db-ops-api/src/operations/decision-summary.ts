import { readInvestigationResult } from '../investigations/contracts.js';
import type { ActionPlanVersion } from './contracts.js';

/** Call only after authorizing the result and every referenced evidence binding. */
export function decisionSummary(input: {
  result: unknown; resultId: string | null; resultVersion: number | null;
  evidenceIds: readonly string[]; asOf: string | null;
  plan?: ActionPlanVersion; displayName?: string | null;
}) {
  const view = readInvestigationResult(input.result, '', new Set(input.evidenceIds));
  return {
    conclusion: view.kind === 'v2' ? view.value.summary : view.kind === 'v1' ? view.value.conclusions.join('\n') : null,
    recommendation: view.kind === 'v2' ? view.value.recommendations[0]?.action ?? null : null,
    asOf: input.asOf,
    sourceRef: input.resultId && input.resultVersion ? { type: 'investigation_result' as const, id: input.resultId, version: input.resultVersion } : null,
    targetRef: input.plan?.content.target ?? null,
    displayName: input.displayName ?? null,
    impact: input.plan?.content.impact ?? null,
    stage: input.plan?.state ?? null,
  };
}
