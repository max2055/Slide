/** Internal scheduler/health-check adapter. Never exposed as a caller-supplied actor. */
import { dbConnection } from '../../db-connection.js';
import type { ActorContext } from '../../auth/actor-context.js';
import { compileAlertRule } from '../../alerts/compiled-rule.js';
import { policyService } from '../policy/service.js';
import { PolicyError, type Ref } from '../policy/model.js';
import { metricConsumerService, operationalSource } from './runtime.js';
import { migrateReference } from './migration.js';
import { evaluateMetric } from './evaluation.js';
const actorFor = (ref: Ref): ActorContext => ({ userId: 0, username: 'metric-policy-evaluator', roles: [],
  permissions: [ref.type === 'instance' ? 'instance:view' : ref.type === 'server' ? 'servers:view' : 'network_devices:view'],
  instanceScopes: ref.type === 'instance' ? { [ref.id]: 'read-only' } : {}, sessionVersion: 0, requestId: `metric-evaluation:${ref.type}:${ref.id}` });
type Rule = Parameters<typeof compileAlertRule>[0] & { missing_policy?: 'unknown'; threshold_type?: string; recovery_threshold?: number; dimensions?: Record<string, string> };
export async function evaluateOperationalRule(ref: Ref, rule: Rule, seconds: number, macros: Record<string, number> = {}) {
  const unavailable = { handled: true, state: 'unknown', level: null as 'warning' | 'error' | 'critical' | null,
    observation: null as {from:string;to:string;observedAt:string|null;quality:'good'|'partial'} | null,
    recovery: false, value: null as number | null, dimensions: null as Record<string, string> | null, migration: null as ReturnType<typeof migrateReference> | null };
  if (!dbConnection.isConnected()) return unavailable;
  const actor = actorFor(ref);
  try {
    const source = await operationalSource(ref);
    if (source !== 'semantic') return unavailable;
    let effective;
    try { effective = await policyService.effective(actor, ref); }
    catch (e) { if (e instanceof PolicyError && e.code === 'POLICY_NOT_FOUND') return unavailable; throw e; }
    const engine = effective.resolved.plan.binding.package.id.split('-')[0];
    const migration = migrateReference(ref, engine, rule.metric_name);
    if (!migration.metric_id || rule.threshold_type === 'dynamic') return { ...unavailable, migration };
    const interval = effective.resolved.settings.interval_ms;
    // One extra bucket absorbs the gap between the query edge and the latest
    // collection. Without it the trailing partial bucket has no samples and
    // every rule would be unknown; a real outage still becomes stale, and a
    // missing bucket in the middle remains a gap.
    const to = new Date().toISOString(), from = new Date(Date.parse(to) - (Math.max(seconds * 1000, interval) + interval)).toISOString();
    const result = await metricConsumerService.query(actor, { resource: ref, metric_ids: [migration.metric_id], from, to });
    const metric = result.metrics[0];
    for (const series of metric.series) {
      while (series.buckets.length > 1) {
        const last = series.buckets.at(-1)!;
        if (last.sample_count > 0 || last.value !== null) break;
        series.buckets.pop();
      }
    }
    // Consumer queries expose counter rates with their own unit. An old count threshold cannot silently become a rate threshold.
    if (metric.definition.kind === 'counter') return { ...unavailable, migration };
    if (rule.dimensions) metric.series = metric.series.filter(s => Object.entries(rule.dimensions!).every(([k, v]) => s.dimensions[k] === v));
    const compiled = compileAlertRule(rule, ref.type, macros);
    let recovery = true, value: number | null = null, state = 'healthy';
    for (const level of ['critical', 'error', 'warning'] as const) {
      const threshold = compiled.thresholds[level]; if (threshold === undefined) continue;
      // Derived rates and estimated allocators are valid evidence even when the
      // float encoding is not exact (precision_loss) or the source is explicitly
      // estimated. Unknown/invalid quality and null values remain unknown, so a
      // counter reset is never evaluated as a real zero.
      const evaluation = evaluateMetric(metric, { metric_id: migration.metric_id,
        unit: metric.series[0]?.buckets[0]?.unit ?? metric.definition.unit, threshold, operator: compiled.operator,
        duration_seconds: seconds, recovery_seconds: seconds, recovery_threshold: rule.recovery_threshold,
        missing: rule.missing_policy ?? 'unknown', accepted_quality: ['good', 'partial'], allow_estimated: true });
      recovery &&= evaluation.recovery; value = evaluation.value;
      if (evaluation.state === 'firing') {
        const series = metric.series.find(s => Object.keys(s.dimensions).length === Object.keys(evaluation.dimensions ?? {}).length
          && Object.entries(s.dimensions).every(([key,value]) => evaluation.dimensions?.[key] === value));
        const buckets = series?.buckets ?? [];
        const observation = buckets.length ? {from:buckets[0].window.from,to:buckets.at(-1)!.window.to,
          observedAt:metric.observed_at ?? null,quality:buckets.some(b => b.quality.status === 'partial') ? 'partial' as const : 'good' as const} : null;
        return { handled: true, ...evaluation, level, migration, observation };
      }
      if (evaluation.state !== 'healthy') state = evaluation.state;
    }
    return { handled: true, state, level: null, recovery, value, migration, dimensions: null, observation: null };
  } catch { return unavailable; }
}

/** Existing score names are not numeric contracts. Unproven ratios/engine-specific checks require review. */
export async function migrateOperationalChecks(id: number, checks: Array<{ name: string; status: string; score: number; message?: string }>) {
  const unavailable = () => checks.map(c => c.name === '连接状态' ? c : { ...c, status: 'unknown', score: 0, message: '正式指标来源未就绪，不能判为健康' });
  if (!dbConnection.isConnected()) return unavailable();
  const ref: Ref = { type: 'instance', id }, actor = actorFor(ref);
  try {
    const source = await operationalSource(ref);
    if (source !== 'semantic') return unavailable();
    await policyService.effective(actor, ref);
  } catch { return unavailable(); }
  // These legacy score references have no frozen equivalent in the bound semantic catalog.
  // In particular PostgreSQL backend count / max_connections and Oracle sessions / processes are not valid utilization ratios.
  return checks.map(c => c.name === '连接状态' ? c : { ...c, status: 'unknown', score: 0,
    message: `评分引用迁移 v1：${c.name} 无已冻结等价指标；保留原策略，等待口径复核，不将缺失补零或计数改为比例` });
}
