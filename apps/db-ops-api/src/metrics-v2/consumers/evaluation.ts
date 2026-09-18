import { AlertPolicySchema, type AlertPolicy } from '../../contracts/metrics-v2/index.js';
import { z } from 'zod';
import type { ConsumerMetric } from './service.js';
import { compare, decode } from '../arithmetic.js';
export const ConsumerAlertPolicySchema = z.strictObject({
  metric_id: z.string(), unit: z.string(), operator: z.enum(['>', '>=', '<', '<=', '=', '!=']),
  threshold: z.number(), duration_seconds: z.number().nonnegative(), recovery_seconds: z.number().nonnegative(),
  recovery_threshold: z.number().optional(), missing: z.literal('unknown').default('unknown'),
  semantic_version: z.string().optional(), min_coverage: z.number().min(0).max(1).default(1),
  accepted_quality: z.array(z.enum(['good', 'partial'])).min(1).default(['good']),
  allow_estimated: z.boolean().default(false),
});
export type ConsumerAlertPolicy = z.input<typeof ConsumerAlertPolicySchema>;
export function scalarNumber(bucket: ConsumerMetric['series'][number]['buckets'][number]): number | null {
  if (!bucket.value || !('value' in bucket.value)) return null;
  const n = Number(bucket.value.value);
  return Number.isFinite(n) && (bucket.value.encoding === 'float64' || Number.isSafeInteger(n)) ? n : null;
}
export function evaluateMetric(metric: ConsumerMetric, input: ConsumerAlertPolicy) {
  const policy = ConsumerAlertPolicySchema.parse(input);
  const unknown = (reason: string) => ({ state: 'unknown' as const,
    recovery: false, reason, value: null as number | null, dimensions: null as Record<string, string> | null });
  if (metric.definition.id !== policy.metric_id) return unknown('metric_mismatch');
  if (policy.semantic_version && metric.definition.semantic_version !== policy.semantic_version) return unknown('semantic_version_mismatch');
  if (metric.state !== 'available') return unknown(metric.state);
  if (!metric.series.length) return unknown('missing_input');
  const matches = (value: NonNullable<ConsumerMetric['series'][number]['buckets'][number]['value']>, threshold: number) => {
    if (!('value' in value)) return false;
    const c = compare(decode(value), decode({ encoding: 'float64', value: threshold }));
    return policy.operator === '>' ? c > 0 : policy.operator === '>=' ? c >= 0 : policy.operator === '<' ? c < 0
      : policy.operator === '<=' ? c <= 0 : policy.operator === '=' ? c === 0 : c !== 0;
  };
  const outcomes = metric.series.map(s => {
    const buckets = s.buckets;
    if (!buckets.length) return { state: 'unknown' as const, recovery: false, reason: 'missing_input', value: null, dimensions: s.dimensions };
    if (buckets.some(b => b.unit !== policy.unit)) return { state: 'unknown' as const, recovery: false, reason: 'unit_mismatch', value: null, dimensions: s.dimensions };
    if (buckets.at(-1)!.freshness !== 'fresh' || buckets.some(b => !b.value || b.coverage < policy.min_coverage
      || !policy.accepted_quality.includes(b.quality.status as 'good' | 'partial') || b.accuracy === 'unknown'
      || b.accuracy === 'estimated' && !policy.allow_estimated)) return { state: 'unknown' as const, recovery: false, reason: 'insufficient_evidence', value: null, dimensions: s.dimensions };
    if (buckets.some(b => scalarNumber(b) === null)) return { state: 'unknown' as const, recovery: false, reason: 'consumer_numeric_range', value: null, dimensions: s.dimensions };
    const span = (Date.parse(buckets.at(-1)!.window.to) - Date.parse(buckets[0].window.from)) / 1000;
    const contiguous = buckets.every((b, i) => !i || b.window.from === buckets[i - 1].window.to);
    if (!contiguous) return { state: 'unknown' as const, recovery: false, reason: 'gap', value: null, dimensions: s.dimensions };
    const firing = span >= policy.duration_seconds && buckets.every(b => matches(b.value!, policy.threshold));
    const recovery = span >= policy.recovery_seconds && buckets.every(b => !matches(b.value!, policy.recovery_threshold ?? policy.threshold));
    return { state: firing ? 'firing' as const : recovery ? 'healthy' as const : 'pending' as const,
      recovery, reason: 'evaluated', dimensions: s.dimensions, value: scalarNumber(buckets.at(-1)!) };
  });
  const firing = outcomes.find(o => o.state === 'firing');
  if (firing) return firing;
  if (outcomes.some(o => o.state === 'unknown')) return unknown(outcomes.find(o => o.state === 'unknown')!.reason);
  if (outcomes.every(o => o.recovery)) return { ...outcomes[0], recovery: true };
  return { state: 'pending' as const, recovery: false, reason: 'duration_not_met', value: outcomes[0].value, dimensions: outcomes[0].dimensions };
}
export function scoreMetrics(metrics: ConsumerMetric[], policies: ConsumerAlertPolicy[]) {
  const checks = policies.map(p => {
    const metric = metrics.find(m => m.definition.id === p.metric_id);
    return { metric_id: p.metric_id, ...(metric ? evaluateMetric(metric, p)
      : { state: 'unknown', recovery: false, reason: 'missing_input', value: null }) };
  });
  if (!checks.length || checks.some(c => c.state === 'unknown' || c.state === 'pending')) return { status: 'unknown', score: null, checks };
  const firing = checks.filter(c => c.state === 'firing').length;
  return { status: firing ? 'warning' : 'healthy', score: Math.round(100 * (checks.length - firing) / checks.length), checks };
}

/** Frozen MAX-64 AlertPolicy adapter; recovery remains an independent consumer policy. */
export function evaluateAlertPolicy(metric: ConsumerMetric, input: AlertPolicy, recovery: { for_ms: number; threshold?: number }) {
  const p = AlertPolicySchema.parse(input);
  if (!p.enabled) return { state: 'disabled', recovery: false, reason: 'policy_disabled', value: null };
  return evaluateMetric(metric, { metric_id: p.metric.id, semantic_version: p.metric.semantic_version, unit: p.unit,
    operator: ({ gt: '>', gte: '>=', lt: '<', lte: '<=' } as const)[p.operator], threshold: p.threshold,
    duration_seconds: p.for_ms / 1000, recovery_seconds: recovery.for_ms / 1000, recovery_threshold: recovery.threshold,
    missing: p.on_missing, min_coverage: p.min_coverage, accepted_quality: p.accepted_quality, allow_estimated: p.allow_estimated });
}
