import type { EvidenceItem } from './evidence-contract.js';
import { dimensionsKey, isFreshNumeric } from './invariant-engine.js';

export function evaluateExpectation(current: EvidenceItem, history: EvidenceItem[], now = Date.now()) {
  const identity = (item: EvidenceItem) => item.subject.resource.type === current.subject.resource.type && item.subject.resource.id === current.subject.resource.id
    && item.payload.metricId === current.payload.metricId && dimensionsKey(item.dimensions) === dimensionsKey(current.dimensions) && item.source === current.source;
  // Repeated diagnostic reads of one observation must not inflate sample size.
  const samples = [...new Map(history.filter(item => identity(item) && item.status === 'fact' && item.quality === 'good'
    && typeof item.payload.value === 'number' && Number.isFinite(item.payload.value) && Date.parse(item.observedAt) < Date.parse(current.observedAt)
    && Date.parse(item.observedAt) >= now - 86400_000).map(item => [item.observedAt, item])).values()];
  const base = { metricId: current.payload.metricId, modelVersion: 'window-mean-3sigma-v1', sampleCount: samples.length, evidenceRefs: [current.id, ...samples.map(item => item.id)], windowSeconds: 86400 };
  if (!isFreshNumeric(current, now) || samples.length < 20) return { ...base, status: 'unknown' as const, reason: 'INSUFFICIENT_BASELINE', mean: null, deviation: null };
  const mean = samples.reduce((sum, item) => sum + Number(item.payload.value), 0) / samples.length;
  const deviation = Math.sqrt(samples.reduce((sum, item) => sum + (Number(item.payload.value) - mean) ** 2, 0) / samples.length);
  const difference = Math.abs(Number(current.payload.value) - mean);
  return { ...base, status: difference > Math.max(3 * deviation, Math.abs(mean) * 0.1, 0.001) ? 'deviation' as const : 'within-range' as const,
    reason: 'STATISTICAL_COMPARISON_NOT_BUSINESS_CONSTRAINT', mean, deviation };
}
