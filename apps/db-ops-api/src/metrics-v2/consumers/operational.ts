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
    recovery: false, value: null as number | null, dimensions: null as Record<string, string> | null, migration: null as ReturnType<typeof migrateReference> | null };
  if (ref.type === 'network_device' && rule.metric_name === 'device_reachability') return { ...unavailable, handled: false };
  if (!dbConnection.isConnected()) return unavailable;
  const actor = actorFor(ref);
  try {
    const source = await operationalSource(ref);
    if (source === 'legacy') return { ...unavailable, handled: rule.metric_name.includes('.') };
    if (source !== 'v2') return unavailable;
    let effective;
    try { effective = await policyService.effective(actor, ref); }
    catch (e) { if (e instanceof PolicyError && e.code === 'POLICY_NOT_FOUND') return unavailable; throw e; }
    const engine = effective.resolved.plan.binding.package.id.split('-')[0];
    const migration = migrateReference(ref, engine, rule.metric_name);
    if (!migration.metric_id || rule.threshold_type === 'dynamic') return { ...unavailable, migration };
    const interval = effective.resolved.settings.interval_ms;
    const to = new Date().toISOString(), from = new Date(Date.parse(to) - Math.max(seconds * 1000, interval)).toISOString();
    const result = await metricConsumerService.query(actor, { resource: ref, metric_ids: [migration.metric_id], from, to });
    const metric = result.metrics[0];
    if (rule.dimensions) metric.series = metric.series.filter(s => Object.entries(rule.dimensions!).every(([k, v]) => s.dimensions[k] === v));
    const compiled = compileAlertRule(rule, ref.type, macros);
    let recovery = true, value: number | null = null, state = 'healthy';
    for (const level of ['critical', 'error', 'warning'] as const) {
      const threshold = compiled.thresholds[level]; if (threshold === undefined) continue;
      const evaluation = evaluateMetric(metric, { metric_id: migration.metric_id,
        unit: metric.series[0]?.buckets[0]?.unit ?? metric.definition.unit, threshold, operator: compiled.operator,
        duration_seconds: seconds, recovery_seconds: seconds, recovery_threshold: rule.recovery_threshold, missing: rule.missing_policy ?? 'unknown' });
      recovery &&= evaluation.recovery; value = evaluation.value;
      if (evaluation.state === 'firing') return { handled: true, ...evaluation, level, migration };
      if (evaluation.state !== 'healthy') state = evaluation.state;
    }
    return { handled: true, state, level: null, recovery, value, migration, dimensions: null };
  } catch { return unavailable; }
}

/** Existing score names are not numeric contracts. Unproven ratios/engine-specific checks require review. */
export async function migrateOperationalChecks(id: number, checks: Array<{ name: string; status: string; score: number; message?: string }>) {
  const unavailable = () => checks.map(c => c.name === '连接状态' ? c : { ...c, status: 'unknown', score: 0, message: '正式指标来源未就绪，不能判为健康' });
  if (!dbConnection.isConnected()) return unavailable();
  const ref: Ref = { type: 'instance', id }, actor = actorFor(ref);
  try {
    const source = await operationalSource(ref);
    if (source === 'legacy') return checks;
    if (source !== 'v2') return unavailable();
    await policyService.effective(actor, ref);
  } catch { return unavailable(); }
  // These legacy score references have no frozen equivalent in the bound V2 catalog.
  // In particular PostgreSQL backend count / max_connections and Oracle sessions / processes are not valid utilization ratios.
  return checks.map(c => c.name === '连接状态' ? c : { ...c, status: 'unknown', score: 0,
    message: `评分引用迁移 v1：${c.name} 无已冻结等价指标；保留原策略，等待口径复核，不将缺失补零或计数改为比例` });
}
