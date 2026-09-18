import { randomUUID } from 'node:crypto';
import type { ActorContext } from '../../auth/actor-context.js';
import type { CollectionAttempt } from '../../contracts/metrics-v2/index.js';
import { canManageResource } from '../../resources/resource-service.js';
import { canonicalDefinitions } from '../packages/builtins.js';
import { type PackageRegistry, stable } from '../packages/model.js';
import { runPackage } from '../packages/runner.js';
import type { PolicyService } from '../policy/service.js';
import { type Ref, rule, refKey } from '../policy/model.js';
import { compilePlan } from '../scheduler/compiler.js';
import type { CollectorAccess } from '../scheduler/service.js';

export interface TrialStore {
  reserve(ref: Ref): Promise<{ release(): Promise<void>; connection: { ping(): Promise<unknown> } } | null>;
  attempts(ref: Ref): Promise<CollectionAttempt[]>;
}
export class MetricConfigurationService {
  constructor(private policy: PolicyService, private registry: PackageRegistry, private store: TrialStore,
    private access: CollectorAccess) {}
  catalog(actor: ActorContext) {
    rule(actor.permissions.some(p => ['*', 'metric:view', 'metric:*', 'instance:view', 'instance:manage', 'servers:view', 'servers:manage', 'network_devices:view', 'network_devices:manage'].includes(p)), 'POLICY_FORBIDDEN', 403);
    const packages = this.registry.list();
    const metrics = [...new Map([...canonicalDefinitions, ...packages.flatMap(p => p.extensions)].map(m => [`${m.id}@${m.semantic_version}`, m])).values()];
    return { packages, metrics };
  }
  async resource(actor: ActorContext, ref: Ref) {
    await this.policy.assertAccess(actor, ref, false);
    return { can_manage: canManageResource(actor, ref) };
  }
  async attempts(actor: ActorContext, ref: Ref) {
    await this.policy.assertAccess(actor, ref, false);
    return this.store.attempts(ref);
  }
  async trial(actor: ActorContext, ref: Ref, input: unknown) {
    const preview = await this.policy.changeBinding(actor, ref, input, false);
    const next = preview.resources[0], plan = compilePlan(this.registry, next.resolved);
    const reservation = await this.store.reserve(ref);
    rule(reservation, 'TRIAL_BUSY', 409);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(plan.timeoutMs, 30000));
    try {
      const check = async () => {
        controller.signal.throwIfAborted();
        await reservation.connection.ping();
        const current = await this.policy.changeBinding(actor, ref, input, false);
        rule(stable(current.resources[0].resolved.settings) === stable(next.resolved.settings)
          && stable(current.resources[0].resolved.metric_sources) === stable(next.resolved.metric_sources)
          && current.resources[0].resolved.plan.binding.policy_revision === next.resolved.plan.binding.policy_revision, 'POLICY_REVISION_CONFLICT', 409);
        controller.signal.throwIfAborted();
      };
      await check();
      const access = await this.access.resolve(ref);
      rule(access.resource.type === ref.type && access.resource.id === String(ref.id), 'TRIAL_IDENTITY');
      await check();
      const s = next.resolved.settings;
      const result = await runPackage(this.registry, { package: next.binding.package, credential_ref: access.credential_ref,
        overrides: { enabled: s.enabled, interval_ms: s.interval_ms, timeout_ms: s.timeout_ms, stale_after_ms: s.stale_after_ms,
          max_counter_gap_ms: s.max_counter_gap_ms, max_rows: s.max_rows } }, {
        ...access, binding_id: refKey(ref), attempt_id: `trial:${randomUUID()}`, config_revision: next.binding.revision,
        observed_at: new Date().toISOString(), signal: controller.signal, before_request: check,
        collector_ids: plan.collectorIds, metric_keys: plan.metricKeys,
        previous_capabilities: next.resolved.metric_templates.map(t => t.capability),
      });
      await check();
      rule(result.observations.length <= s.max_series_per_resource, 'TRIAL_SERIES_LIMIT');
      return { trial: true, persisted: false, decision: result.decision, attempts: result.attempts,
        capabilities: result.capabilities, lifecycle_evidence: access.evidence.counter || access.evidence.host_counter_epochs || access.evidence.snmp ? 'available' : 'unavailable',
        samples: result.observations.map(o => ({ metric: o.observation.metric,
          value: o.observation.value, quality: o.observation.quality, unit: o.observation.unit })) };
    } catch (error) {
      if (controller.signal.aborted) return { trial: true, persisted: false, decision: 'failed', error: 'timeout', attempts: [], capabilities: [], samples: [] };
      throw error;
    } finally {
      clearTimeout(timer);
      // Do not race the runner: reservation survives timeout until all in-flight IO settles.
      await reservation.release();
    }
  }
}
