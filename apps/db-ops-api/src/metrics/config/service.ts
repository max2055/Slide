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
    // An intent that already published replays its recorded outcome before any
    // trial IO; live permission and the configuration digest are revalidated.
    const replayed = await this.policy.replay(actor, ref, input);
    if (replayed) return { ...replayed, status: await this.status(actor, ref) };
    const preview = await this.policy.changeBinding(actor, ref, input, false, guard.candidate);
    rule(!preview.resources[0].resolved.applicability.some(c => c.status === 'unsupported'), 'PACKAGE_INCOMPATIBLE', 422);
    const candidate = candidateFingerprint(preview.resources[0]);
    const trial = await this.trial(actor, ref, input, candidate, guard);
    const disabled = !preview.resources[0].resolved.settings.enabled;
    rule(disabled || trial.samples.some(s => s.value !== null && s.quality.status === 'good')
      && trial.attempts.some(a => ['succeeded', 'partial'].includes(a.status)), 'CONFIGURATION_TRIAL_FAILED', 422);
    // Revalidates live permission, inventory and policy/group CAS after remote IO.
    guard.signal?.throwIfAborted();
    actor = await this.currentActor(actor, guard);
    const result = await this.policy.changeBinding(actor, ref, input, true, candidate);
    guard.published?.(result.resources[0].binding.revision);
    return { ...result, status: await this.status(actor, ref) };
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
  /** Read-only intent lookup; an absent key is authoritative for a safe retry. */
  operation(actor: ActorContext, ref: Ref, operationKey: string) {
    return this.policy.operation(actor, ref, operationKey);
  }
  async trialCurrent(actor: ActorContext, ref: Ref) {
    await this.policy.assertAccess(actor, ref, true);
    const current = await this.policy.effective(actor, ref);
    return this.trial(actor, ref, { expected_revision: current.published_revision });
  }
  async trial(actor: ActorContext, ref: Ref, input: unknown, expectedCandidate?: string, guard: ActivationGuard = {}) {
    actor = await this.currentActor(actor, guard);
    const preview = await this.policy.changeBinding(actor, ref, input, false, expectedCandidate);
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
        const current = await this.policy.changeBinding(actor, ref, input, false, candidateFingerprint(next));
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
