import type { ResourceRef } from '../resources/types.js';
import type { EvidenceItem } from '../evidence/evidence-contract.js';
import { dimensionsKey } from '../evidence/invariant-engine.js';
export interface RecoveryPlan {
  resource: ResourceRef; metricId: string; min?: number; max?: number; dimensions?: Record<string, string>;
  startedAt: string; windowSeconds: number; maxSampleGapSeconds: number;
}
export function verifyRecoveryWindow(plan: RecoveryPlan, evidence: EvidenceItem[], now = Date.now()) {
  const start = Date.parse(plan.startedAt); const end = start + plan.windowSeconds * 1000;
  if (!Number.isFinite(start) || !Number.isSafeInteger(plan.windowSeconds) || plan.windowSeconds < 30 || plan.windowSeconds > 3600
    || !Number.isSafeInteger(plan.maxSampleGapSeconds) || plan.maxSampleGapSeconds < 1 || plan.maxSampleGapSeconds > plan.windowSeconds
    || (!Number.isFinite(plan.min) && !Number.isFinite(plan.max)) || (plan.min !== undefined && !Number.isFinite(plan.min)) || (plan.max !== undefined && !Number.isFinite(plan.max))
    || (plan.min !== undefined && plan.max !== undefined && plan.min > plan.max)) throw new Error('RECOVERY_PLAN_INVALID');
  const samples = [...new Map(evidence.filter(item => item.subject.resource.type === plan.resource.type && item.subject.resource.id === plan.resource.id
    && item.kind === 'observation' && item.status === 'fact' && item.payload.metricId === plan.metricId
    && dimensionsKey(item.dimensions) === dimensionsKey(plan.dimensions) && Date.parse(item.observedAt) >= start && Date.parse(item.observedAt) <= Math.min(now, end))
    .map(item => [item.observedAt, item])).values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const base = { verifiedBy: 'independent-observation-window-v1', evidenceRefs: samples.map(item => item.id), startedAt: plan.startedAt, windowSeconds: plan.windowSeconds };
  if (now < end || samples.length < 3) return { ...base, status: 'unknown' as const, reason: 'RECOVERY_WINDOW_INCOMPLETE' };
  let previous = start;
  for (const sample of samples) {
    const observed = Date.parse(sample.observedAt);
    if (observed - previous > plan.maxSampleGapSeconds * 1000 || sample.quality !== 'good' || typeof sample.payload.value !== 'number'
      || !Number.isFinite(sample.payload.value) || Date.parse(sample.validUntil) <= observed) return { ...base, status: 'unknown' as const, reason: 'RECOVERY_EVIDENCE_GAP' };
    if ((plan.min !== undefined && sample.payload.value < plan.min) || (plan.max !== undefined && sample.payload.value > plan.max)) return { ...base, status: 'not-recovered' as const, reason: 'RECOVERY_CONSTRAINT_VIOLATED' };
    previous = observed;
  }
  const last = samples.at(-1)!;
  if (end - previous > plan.maxSampleGapSeconds * 1000 || Date.parse(last.validUntil) < end) return { ...base, status: 'unknown' as const, reason: 'RECOVERY_EVIDENCE_GAP' };
  return { ...base, status: 'recovered' as const, reason: 'RECOVERY_WINDOW_SATISFIED' };
}
