import { createHash } from 'node:crypto';
import { CollectionPlanSchema, type MetricBinding } from '../../contracts/metrics-v2/index.js';
import { type PackageRegistry, stable } from '../packages/model.js';
import { type Resolved, metricKey, rule } from '../policy/model.js';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface CollectorPlan {
  revision: number;
  resource: { type: Resolved['plan']['binding']['resource_type']; id: number };
  intervalMs: number;
  timeoutMs: number;
  jitterMs: number;
  collectorIds: string[];
  metricKeys: string[];
  queries: Array<{ implementation: string; collectors: string[]; cost: string; logicalReads: number }>;
  requestsPerHour: number;
}
/** A resource policy has one cadence. Never coalesce across resources, pins or cadences. */
export function compilePlan(registry: PackageRegistry, resolved: Resolved): CollectorPlan {
  const plan = CollectionPlanSchema.parse(resolved.plan), binding = plan.binding;
  const release = registry.get(binding.package);
  rule(binding.config_revision > 0 && binding.resource_type === release.package.resource_type, 'PLAN_IDENTITY');
  rule(Number.isSafeInteger(Number(binding.resource_id)) && Number(binding.resource_id) > 0, 'PLAN_RESOURCE');
  rule(plan.policy.interval_ms === resolved.settings.interval_ms && plan.policy.timeout_ms === resolved.settings.timeout_ms
    && plan.policy.enabled === resolved.settings.enabled && binding.enabled === resolved.settings.enabled, 'PLAN_SETTINGS');
  registry.select({ package: binding.package, credential_ref: 'credential:compile', overrides: {
    enabled: resolved.settings.enabled, interval_ms: resolved.settings.interval_ms, timeout_ms: resolved.settings.timeout_ms,
    stale_after_ms: resolved.settings.stale_after_ms, max_counter_gap_ms: resolved.settings.max_counter_gap_ms, max_rows: resolved.settings.max_rows,
  } });
  const known = new Map<string, MetricBinding['source']>(release.package.collectors.flatMap(c => c.mappings.map(m => [metricKey(m.metric),
    { kind: 'collector', collector_id: c.id, raw_field: m.raw_field }])));
  for (const d of release.derived) known.set(metricKey(d.output), { kind: 'derived', derived_id: d.id });
  rule(Number.isInteger(resolved.settings.max_concurrency) && resolved.settings.max_concurrency >= 1 && resolved.settings.max_concurrency <= 16
    && Number.isInteger(resolved.settings.max_series_per_resource) && resolved.settings.max_series_per_resource >= 1
    && resolved.settings.max_series_per_resource <= 10000, 'PLAN_BUDGET');
  const templates = new Map(resolved.metric_templates.map(t => [metricKey(t.metric), t]));
  rule(templates.size === resolved.metric_templates.length && templates.size === known.size, 'PLAN_SOURCE');
  for (const [key, t] of templates) rule(stable(known.get(key)) === stable(t.source), 'PLAN_SOURCE');
  const keys = new Set<string>();
  const visit = (key: string) => {
    if (keys.has(key)) return;
    const t = templates.get(key);
    rule(t && t.enabled && !['disabled', 'unsupported'].includes(t.decision), 'PLAN_DEPENDENCY');
    keys.add(key);
    const d = release.derived.find(d => metricKey(d.output) === key);
    d?.inputs.forEach(i => visit(metricKey(i)));
  };
  if (resolved.settings.enabled) for (const [key, t] of templates) {
    if (t.enabled && !['disabled', 'unsupported'].includes(t.decision)) visit(key);
  }
  const collectors = release.package.collectors.filter(c => c.mappings.some(m => keys.has(metricKey(m.metric))));
  const groups = new Map<string, CollectorPlan['queries'][number]>();
  for (const c of collectors) {
    const key = `${c.method}:${c.implementation_ref}`;
    const group = groups.get(key) ?? { implementation: c.implementation_ref, collectors: [], cost: c.estimated_cost, logicalReads: c.method === 'ssh' ? 2 : 1 };
    group.collectors.push(c.id); groups.set(key, group);
  }
  const intervalMs = resolved.settings.interval_ms;
  const jitterMs = parseInt(hash(`${binding.resource_type}:${binding.resource_id}:${binding.package.id}`).slice(0, 8), 16) % Math.min(intervalMs, 10000);
  return { revision: binding.config_revision, resource: { type: binding.resource_type, id: Number(binding.resource_id) },
    intervalMs, timeoutMs: resolved.settings.timeout_ms, jitterMs, collectorIds: collectors.map(c => c.id), metricKeys: [...keys],
    queries: [...groups.values()], requestsPerHour: [...groups.values()].reduce((n, g) => n + g.logicalReads, 0) * 3600000 / intervalMs };
}
