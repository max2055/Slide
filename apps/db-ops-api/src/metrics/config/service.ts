import { checkApplicability } from '../packages/applicability.js';
import { instanceAccessLifecycle } from '../../resources/instance-access-lifecycle.js';
import { randomUUID } from 'node:crypto';
import type { ActorContext } from '../../auth/actor-context.js';
import type { CollectionAttempt } from '../../contracts/metrics/index.js';
import { canManageResource } from '../../resources/resource-service.js';
import { canonicalDefinitions } from '../packages/builtins.js';
import { type PackageRegistry, stable } from '../packages/model.js';
import { AdapterError } from '../packages/adapters.js';
import { runPackage } from '../packages/runner.js';
import type { PolicyService } from '../policy/service.js';
import { candidateFingerprint } from '../policy/service.js';
import { type Ref, rule, refKey } from '../policy/model.js';
import { compilePlan } from '../scheduler/compiler.js';
import type { CollectorAccess } from '../scheduler/service.js';
import { MetricConfigurationReader, type ConfigurationReader } from './status.js';

export interface TrialStore {
  reserve(ref: Ref): Promise<{ release(): Promise<void>; connection: { ping(): Promise<unknown> } } | null>;
  attempts(ref: Ref): Promise<CollectionAttempt[]>;
}
export interface ActivationGuard {
  candidate?: string;
  signal?: AbortSignal;
  /** Re-read live grants and cancellation at each boundary, including before publication. */
  check?(): Promise<ActorContext>;
  published?(revision: number): void;
}
export class MetricConfigurationService {
  constructor(private policy: PolicyService, private registry: PackageRegistry, private store: TrialStore,
    private access: CollectorAccess, private reader?: ConfigurationReader,
    private reloadActor?: (seed: ActorContext) => Promise<ActorContext>) {}
  private currentActor(actor: ActorContext, guard: ActivationGuard): Promise<ActorContext> {
    return guard.check ? guard.check() : this.reloadActor ? this.reloadActor(actor) : Promise.resolve(actor);
  }
  private statusReader() {
    rule(this.reader, 'CONFIGURATION_STATUS_UNAVAILABLE', 503);
    return new MetricConfigurationReader(this.policy, this.registry, this.reader, ref => this.store.attempts(ref));
  }
  async migration(actor: ActorContext, ref: Ref) {
    await this.policy.assertAccess(actor, ref, true);
    rule(this.reader?.migration, 'MIGRATION_STATUS_UNAVAILABLE', 503);
    return {resource:ref,items:await this.reader.migration(ref)};
  }
  status(actor: ActorContext, ref: Ref) { return this.statusReader().status(actor, ref); }
  recommendations(actor: ActorContext, ref: Ref) { return this.statusReader().recommendations(actor, ref); }
  async activate(actor: ActorContext, ref: Ref, input: unknown, guard: ActivationGuard = {}) {
    guard.signal?.throwIfAborted();
    actor = await this.currentActor(actor, guard);
    // A keyed intent is reserved for the whole activate, not just its publication:
    // a duplicate gets the committed result or learns the intent is pending, and
    // neither starts a second trial. Unkeyed callers keep the previous behavior.
    const keyed = (input as { operation_key?: unknown } | null | undefined)?.operation_key !== undefined;
    const live = () => this.currentActor(actor, guard);
    // Which step failed decides what a retry may assume. Only a step that
    // provably did not reach the target is safe to release; a trial that may
    // have read the target, or a publication whose commit is unclear, is not.
    let phase: 'preview' | 'trial' | 'trial-done' | 'publish' = 'preview';
    if (keyed) {
      const begun = await this.policy.beginOperation(actor, ref, input, live);
      if ('replayed' in begun) return { ...begun.replayed, status: await this.status(actor, ref) };
    }
    try {
      const preview = await this.policy.changeBinding(actor, ref, input, false, guard.candidate, false, live);
      rule(!preview.resources[0].resolved.applicability.some(c => c.status === 'unsupported'), 'PACKAGE_INCOMPATIBLE', 422);
      const candidate = candidateFingerprint(preview.resources[0]);
      phase = 'trial';
      const trial = await this.trial(actor, ref, input, candidate, guard);
      phase = 'trial-done';
      const disabled = !preview.resources[0].resolved.settings.enabled;
      rule(disabled || trial.samples.some(s => s.value !== null && s.quality.status === 'good')
        && trial.attempts.some(a => ['succeeded', 'partial'].includes(a.status)), 'CONFIGURATION_TRIAL_FAILED', 422);
      // Revalidates live permission, inventory and policy/group CAS after remote IO.
      guard.signal?.throwIfAborted();
      actor = await this.currentActor(actor, guard);
      phase = 'publish';
      const result = await this.policy.changeBinding(actor, ref, input, true, candidate, keyed, live);
      guard.published?.(result.resources[0].binding.revision);
      return { ...result, status: await this.status(actor, ref) };
    } catch (error) {
      if (keyed) {
        // The claim is cleared only when the failure itself proves nothing
        // happened; an unknown trial read or an unclear commit stays pending and
        // is resolved from the journal (a committed row is this intent's result).
        const recovered = await this.policy.failedOperation(actor, ref, input,
          phase === 'publish' ? 'publish' : phase === 'trial' ? 'trial' : 'before', live).catch(() => null);
        if (recovered) {
          guard.published?.(recovered.resources[0].binding.revision);
          return { ...recovered, status: await this.status(actor, ref) };
        }
      }
      throw error;
    }
  }
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
  /** Read-only intent lookup; absent is a safe retry, pending is not. */
  operation(actor: ActorContext, ref: Ref, operationKey: string) {
    return this.policy.operation(actor, ref, operationKey, () => this.currentActor(actor, {}));
  }
  async trialCurrent(actor: ActorContext, ref: Ref) {
    await this.policy.assertAccess(actor, ref, true);
    const current = await this.policy.effective(actor, ref);
    return this.trial(actor, ref, { expected_revision: current.published_revision });
  }
  async trial(actor: ActorContext, ref: Ref, input: unknown, expectedCandidate?: string, guard: ActivationGuard = {}) {
    actor = await this.currentActor(actor, guard);
    const live = () => this.currentActor(actor, guard);
    const preview = await this.policy.changeBinding(actor, ref, input, false, expectedCandidate, false, live);
    const next = preview.resources[0], plan = compilePlan(this.registry, next.resolved);
    const reservation = await this.store.reserve(ref);
    rule(reservation, 'TRIAL_BUSY', 409);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(guard.signal ? [guard.signal] : []),
      ...(ref.type === 'instance' ? [instanceAccessLifecycle.signal(ref.id)] : [])]);
    const timer = setTimeout(() => controller.abort(), Math.min(plan.timeoutMs, 30000));
    try {
      const check = async () => {
        signal.throwIfAborted();
        actor = await this.currentActor(actor, guard);
        await reservation.connection.ping();
        const current = await this.policy.changeBinding(actor, ref, input, false, candidateFingerprint(next), false, live);
        rule(stable(current.resources[0].resolved.settings) === stable(next.resolved.settings)
          && stable(current.resources[0].resolved.metric_sources) === stable(next.resolved.metric_sources)
          && current.resources[0].resolved.plan.binding.policy_revision === next.resolved.plan.binding.policy_revision, 'POLICY_REVISION_CONFLICT', 409);
        signal.throwIfAborted();
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
        observed_at: new Date().toISOString(), signal, before_request: async () => { await check(); await access.assertCurrent?.(); },
        collector_ids: plan.collectorIds, metric_keys: plan.metricKeys,
        previous_capabilities: next.resolved.metric_templates.map(t => t.capability),
      });
      await check();
      await access.assertCurrent?.();
      rule(result.observations.length <= s.max_series_per_resource, 'TRIAL_SERIES_LIMIT');
      const release = this.registry.get(next.binding.package);
      // Unit pairs already declared by the mapping that produced each sample; never synthesized.
      const unitChecks = new Map<string, { input_unit: string; output_unit: string }>();
      for (const collector of release.package.collectors) for (const mapping of collector.mappings)
        unitChecks.set(`${collector.id}|${mapping.metric.id}@${mapping.metric.semantic_version}`,
          { input_unit: mapping.input_unit, output_unit: mapping.output_unit });
      const attemptsById = new Map(result.attempts.map(attempt => [attempt.id, attempt]));
      return { trial: true, persisted: false, decision: result.decision, attempts: result.attempts,
        capabilities: result.capabilities, applicability: checkApplicability(this.registry.get(next.binding.package).package, access.resource, new Date().toISOString()), lifecycle_evidence: access.evidence.counter || access.evidence.host_counter_epochs || access.evidence.snmp ? 'available' : 'unavailable',
        samples: result.observations.map(({ observation: o }) => {
          // Read: the attempt this observation's own source points at; no collector-wide status is copied.
          const attempt = attemptsById.get(o.source.attempt_id)
            ?? result.attempts.find(candidate => candidate.observation_ids.includes(o.id));
          const units = unitChecks.get(`${o.source.collector_id}|${o.metric.id}@${o.metric.semantic_version}`);
          return { metric: o.metric, value: o.value, quality: o.quality, unit: o.unit,
            ...(attempt ? { read: { attempt_id: attempt.id, status: attempt.status } } : {}),
            ...(o.versions.transform_version ? { transform: { version: o.versions.transform_version } } : {}),
            ...(units ? { unit_check: units } : {}) };
        }) };
    } catch (error) {
      if (controller.signal.aborted) return { trial: true, persisted: false, decision: 'failed', error: 'timeout', attempts: [], capabilities: [], samples: [] };
      if (error instanceof AdapterError) return { trial: true, persisted: false, decision: 'failed', error: error.code, attempts: [], capabilities: [], samples: [] };
      throw error;
    } finally {
      clearTimeout(timer);
      // Do not race the runner: reservation survives timeout until all in-flight IO settles.
      await reservation.release();
    }
  }
}
