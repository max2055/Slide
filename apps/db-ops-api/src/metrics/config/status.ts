import type { CollectionAttempt, Resource } from '../../contracts/metrics/index.js';
import { MetricConfigurationStatusSchema, type MetricConfigurationStatus } from '../../contracts/metrics/configuration-status.js';
import type { PolicyService } from '../policy/service.js';
import type { Ref, Settings } from '../policy/model.js';
import { metricKey, PolicyError } from '../policy/model.js';
import type { PackageRegistry } from '../packages/model.js';
import { checkApplicability } from '../packages/applicability.js';
import { coreProfiles } from '../consumers/service.js';
import { capacityDefinition } from '../database/catalog.js';
import type { ActorContext } from '../../auth/actor-context.js';
import { canManageResource } from '../../resources/resource-service.js';

type Effective = Awaited<ReturnType<PolicyService['effective']>>;
export interface ConfigurationEvidence {
  asset_enabled: boolean; global_enabled: boolean; in_flight: boolean;
  formal: { state: 'pending' | 'validating' | 'available' | 'failed'; last_observed_at: string | null; generation: number | null };
}
/**
 * The authoritative facts of a `templates-v1` binding. They are read through the
 * shared persistence codec, never cast into the legacy single-package `Published`
 * shape, so a template binding is reported as bound even though it has no
 * package pin.
 */
export interface TemplateBindingFacts {
  revision: number;
  published_at: string;
  application: { status: 'pending' | 'applied' | 'failed'; applied_revision: number | null };
  settings: Settings;
  /** True only when this resource's own override set `enabled`. */
  enabled_overridden: boolean;
  metrics: Array<{
    metric: { id: string; semantic_version: string };
    enabled: boolean;
    decision: 'collect' | 'derive' | 'disabled' | 'unsupported' | 'capability_unknown';
    capability: 'supported' | 'unsupported' | 'unknown';
  }>;
}
export interface ConfigurationReader {
  migration?(ref: Ref): Promise<NonNullable<MetricConfigurationStatus['legacy_configuration']>>;
  inventory(ref: Ref): Promise<Resource>;
  evidence(ref: Ref, revision: number | null): Promise<ConfigurationEvidence>;
  /** Only a `templates-v1` row answers; a legacy row keeps its own reader. */
  template?(ref: Ref): Promise<TemplateBindingFacts | null>;
}

export function configurationStatus(ref: Ref, effective: Effective | null, attempts: CollectionAttempt[],
  evidence: ConfigurationEvidence, inventory: Resource, canManage: boolean, at: string): MetricConfigurationStatus {
  const resolved = effective?.resolved, policyEnabled = resolved?.settings.enabled ?? false;
  const enabled = evidence.global_enabled && evidence.asset_enabled && policyEnabled;
  const current = attempts.filter(a => a.config_revision === effective?.published_revision).sort((a,b) => b.started_at.localeCompare(a.started_at));
  const latest = current[0], success = current.find(a => a.status === 'succeeded');
  const blockers: MetricConfigurationStatus['blockers'] = [];
  if (!effective) blockers.push('UNBOUND');
  if (!evidence.global_enabled) blockers.push('GLOBAL_COLLECTION_DISABLED');
  if (!evidence.asset_enabled) blockers.push('ASSET_COLLECTION_DISABLED');
  if (effective && !policyEnabled) blockers.push('POLICY_COLLECTION_DISABLED');
  if (effective?.application.status === 'pending') blockers.push('APPLICATION_PENDING');
  if (effective?.application.status === 'failed') blockers.push('APPLICATION_FAILED');
  if (resolved?.applicability.some(c => c.status === 'unsupported')) blockers.push('PACKAGE_INCOMPATIBLE');
  if (resolved?.metric_templates.some(t => t.enabled && t.capability.status === 'unknown')) blockers.push('CAPABILITY_UNKNOWN');
  const failed = latest && ['failed', 'partial', 'cancelled'].includes(latest.status);
  if (failed) blockers.push('COLLECTION_FAILED');
  if (effective && evidence.formal.state === 'validating') blockers.push('SOURCE_VALIDATION_PENDING');
  if (effective && evidence.formal.state === 'failed') blockers.push('SOURCE_VALIDATION_FAILED');
  if (effective && !evidence.formal.last_observed_at) blockers.push('AWAITING_SAMPLE');
  const freshness = !evidence.formal.last_observed_at || !resolved ? 'unknown'
    : Date.parse(at) - Date.parse(evidence.formal.last_observed_at) >= resolved.settings.stale_after_ms ? 'stale' : 'fresh';
  if (freshness === 'stale') blockers.push('STALE_SAMPLE');
  const metrics = new Map<string, {id: string; semantic_version: string}>(coreProfiles[ref.type].map(c => [c.id, {id:c.id, semantic_version:'1.0.0'}] as const));
  const capacity = ref.type === 'instance' ? capacityDefinition(String(inventory.attributes['db.engine']?.value ?? '')) : undefined;
  if (capacity) metrics.set(capacity.id, { id: capacity.id, semantic_version: capacity.semantic_version });
  for (const t of resolved?.metric_templates ?? []) metrics.set(t.metric.id, t.metric);
  return MetricConfigurationStatusSchema.parse({ contract_version: '1.0.0', resource: ref, evaluated_at: at, can_manage: canManage,
    binding: { state: effective ? 'bound' : 'unbound', package: resolved?.plan.binding.package ?? null,
      published_revision: effective?.published_revision ?? null, applied_revision: effective?.application.applied_revision ?? null,
      application: effective?.application.status ?? 'unbound' },
    effective_enabled: { enabled, global_enabled: evidence.global_enabled, asset_enabled: evidence.asset_enabled, policy_enabled: policyEnabled,
      source: !evidence.global_enabled ? 'global' : !evidence.asset_enabled ? 'asset' : !effective ? 'unbound' : resolved!.sources.enabled.layer },
    collection: { state: !enabled ? 'disabled' : evidence.in_flight ? 'running' : failed ? 'failed' : success ? 'succeeded' : effective ? 'pending' : 'unknown',
      last_attempt_at: latest?.started_at ?? null, last_success_at: success?.ended_at ?? null, in_flight: evidence.in_flight },
    formal_visibility: { state: effective ? evidence.formal.state : 'unbound', source: evidence.formal.last_observed_at ? 'semantic' : 'none',
      last_observed_at: evidence.formal.last_observed_at, generation: evidence.formal.generation, freshness },
    coverage: [...metrics.values()].map(metric => {
      const t = resolved?.metric_templates.find(t => metricKey(t.metric) === metricKey(metric));
      const state = !t ? 'not_covered' : !t.enabled ? 'disabled' : t.capability.status === 'unsupported' ? 'unsupported'
        : t.capability.status === 'unknown' ? 'unknown' : 'covered';
      return { metric, state, reason: !t ? 'PACKAGE_NOT_COVERED' : state === 'unsupported' ? 'CAPABILITY_UNSUPPORTED' : state === 'unknown' ? 'CAPABILITY_UNKNOWN' : null };
    }), blockers });
}

/**
 * The same independent facts for a `templates-v1` binding. There is deliberately
 * no `resolved` snapshot here: a template plan is not a legacy `Resolved`, and
 * synthesizing one would let the status reader claim a plan it never resolved.
 * Pending application, applied revision, first sample and formal visibility stay
 * separate exactly as in the single-package shape.
 */
export function templateConfigurationStatus(ref: Ref, facts: TemplateBindingFacts, attempts: CollectionAttempt[],
  evidence: ConfigurationEvidence, inventory: Resource, canManage: boolean, at: string): MetricConfigurationStatus {
  const policyEnabled = facts.settings.enabled === true;
  const enabled = evidence.global_enabled && evidence.asset_enabled && policyEnabled;
  const effectiveRevision = facts.application.applied_revision ?? facts.revision;
  const current = attempts.filter(a => a.config_revision === effectiveRevision).sort((a,b) => b.started_at.localeCompare(a.started_at));
  const latest = current[0], success = current.find(a => a.status === 'succeeded');
  const blockers: MetricConfigurationStatus['blockers'] = [];
  if (!evidence.global_enabled) blockers.push('GLOBAL_COLLECTION_DISABLED');
  if (!evidence.asset_enabled) blockers.push('ASSET_COLLECTION_DISABLED');
  if (!policyEnabled) blockers.push('POLICY_COLLECTION_DISABLED');
  if (facts.application.status === 'pending') blockers.push('APPLICATION_PENDING');
  if (facts.application.status === 'failed') blockers.push('APPLICATION_FAILED');
  if (facts.metrics.some(m => m.capability === 'unsupported')) blockers.push('PACKAGE_INCOMPATIBLE');
  if (facts.metrics.some(m => m.capability === 'unknown')) blockers.push('CAPABILITY_UNKNOWN');
  const failed = latest && ['failed', 'partial', 'cancelled'].includes(latest.status);
  if (failed) blockers.push('COLLECTION_FAILED');
  if (evidence.formal.state === 'validating') blockers.push('SOURCE_VALIDATION_PENDING');
  if (evidence.formal.state === 'failed') blockers.push('SOURCE_VALIDATION_FAILED');
  if (!evidence.formal.last_observed_at) blockers.push('AWAITING_SAMPLE');
  const freshness = !evidence.formal.last_observed_at ? 'unknown'
    : Date.parse(at) - Date.parse(evidence.formal.last_observed_at) >= facts.settings.stale_after_ms ? 'stale' : 'fresh';
  if (freshness === 'stale') blockers.push('STALE_SAMPLE');
  const metrics = new Map<string, { id: string; semantic_version: string }>(
    coreProfiles[ref.type].map(c => [c.id, { id: c.id, semantic_version: '1.0.0' }] as const));
  const capacity = ref.type === 'instance' ? capacityDefinition(String(inventory.attributes['db.engine']?.value ?? '')) : undefined;
  if (capacity) metrics.set(capacity.id, { id: capacity.id, semantic_version: capacity.semantic_version });
  const states = new Map(facts.metrics.map(entry => [metricKey(entry.metric), entry] as const));
  for (const entry of facts.metrics) metrics.set(entry.metric.id, entry.metric);
  return MetricConfigurationStatusSchema.parse({ contract_version: '1.0.0', resource: ref, evaluated_at: at, can_manage: canManage,
    binding: { state: 'bound', package: null, published_revision: facts.revision,
      applied_revision: facts.application.applied_revision, application: facts.application.status },
    effective_enabled: { enabled, global_enabled: evidence.global_enabled, asset_enabled: evidence.asset_enabled, policy_enabled: policyEnabled,
      source: !evidence.global_enabled ? 'global' : !evidence.asset_enabled ? 'asset'
        : !policyEnabled ? 'resource' : facts.enabled_overridden ? 'resource' : 'package' },
    collection: { state: !enabled ? 'disabled' : evidence.in_flight ? 'running' : failed ? 'failed' : success ? 'succeeded' : 'pending',
      last_attempt_at: latest?.started_at ?? null, last_success_at: success?.ended_at ?? null, in_flight: evidence.in_flight },
    formal_visibility: { state: evidence.formal.state, source: evidence.formal.last_observed_at ? 'semantic' : 'none',
      last_observed_at: evidence.formal.last_observed_at, generation: evidence.formal.generation, freshness },
    coverage: [...metrics.values()].map(metric => {
      const entry = states.get(metricKey(metric));
      const state = !entry ? 'not_covered' : entry.capability === 'unsupported' ? 'unsupported'
        : entry.capability === 'unknown' ? 'unknown' : entry.enabled ? 'covered' : 'disabled';
      return { metric, state, reason: !entry ? 'TEMPLATE_NOT_COVERED' : state === 'unsupported' ? 'CAPABILITY_UNSUPPORTED'
        : state === 'unknown' ? 'CAPABILITY_UNKNOWN' : state === 'disabled' ? 'METRIC_DISABLED' : null };
    }), blockers });
}

export class MetricConfigurationReader {
  constructor(private policy: PolicyService, private registry: PackageRegistry, private reader: ConfigurationReader,
    private attempts: (ref: Ref) => Promise<CollectionAttempt[]>, private clock = () => new Date().toISOString()) {}
  async status(actor: ActorContext, ref: Ref) {
    await this.policy.assertAccess(actor, ref, false);
    let effective: Effective | null = null, template: TemplateBindingFacts | null = null;
    try { effective = await this.policy.effective(actor, ref); }
    catch(e) {
      if (e instanceof PolicyError && e.code === 'POLICY_NOT_FOUND') { /* unbound */ }
      // The legacy reader refuses a templates-v1 row on purpose. Its own facts
      // are read through the shared codec instead; a read failure stays an error.
      // A reader without that codec can only repeat the fence — never "unbound".
      else if (e instanceof PolicyError && e.code === 'TEMPLATE_BINDING_UNSUPPORTED') {
        if (!this.reader.template) throw e;
        template = await this.reader.template(ref);
        // The row was just refused as a template binding; an empty re-read is a
        // read failure, never an unbound resource.
        if (!template) throw new PolicyError('POLICY_BINDING_INVALID', 409);
      } else throw e;
    }
    const evidence = await this.reader.evidence(ref, template
      ? template.application.applied_revision ?? template.revision
      : effective?.published_revision ?? null);
    const attempts = await this.attempts(ref);
    const result = template
      ? templateConfigurationStatus(ref, template, attempts, evidence, await this.reader.inventory(ref), canManageResource(actor, ref), this.clock())
      : configurationStatus(ref, effective, attempts, evidence, await this.reader.inventory(ref), canManageResource(actor, ref), this.clock());
    // Pending custom configurations must remain visible; never imply that preserving a row executes it.
    if(canManageResource(actor,ref)&&this.reader.migration){
      result.legacy_configuration=(await this.reader.migration(ref)).map(item=>{
        const pin=result.binding.package, reviewed=item.package;
        // Migration review is definition-level; activation belongs to this
        // exact resource/revision/pin. An applied binding does not prove fresh
        // values, complete coverage, or migration of alerts/template macros.
        const applied=item.kind==='custom_sql' && item.state==='reviewed'
          && item.code==='CUSTOM_SQL_ACTIVATION_REQUIRED' && reviewed && pin
          && reviewed.id===pin.id && reviewed.version===pin.version && reviewed.digest===pin.digest
          && result.binding.application==='applied' && result.binding.published_revision!==null
          && result.binding.applied_revision===result.binding.published_revision;
        return applied ? {...item,code:'CUSTOM_SQL_BINDING_APPLIED',actions:[
          'Exact reviewed package binding is applied to this resource revision',
          'Verify per-metric fresh formal values and quality; binding alone is not coverage acceptance',
          'Review legacy alerts and template macros separately; no automatic migration',
        ]} : item;
      });
      if(result.legacy_configuration.some(c=>c.state==='blocked'))result.blockers.push('LEGACY_CONFIGURATION_REVIEW_REQUIRED');
    }
    return MetricConfigurationStatusSchema.parse(result);
  }
  async recommendations(actor: ActorContext, ref: Ref) {
    await this.policy.assertAccess(actor, ref, false);
    const resource = await this.reader.inventory(ref), at = this.clock();
    const packages = this.registry.list().filter(r => r.package.resource_type === ref.type).map(release => {
      const checks = checkApplicability(release.package, resource, at);
      const compatibility = checks.some(c => c.status === 'unsupported') ? 'incompatible' : checks.some(c => c.status === 'unknown') ? 'unknown' : 'compatible';
      const coverage = [...release.package.collectors.flatMap(c => c.mappings.map(m => m.metric)), ...release.derived.map(d => d.output)];
      return { release, compatibility, recommended: false, checks, coverage,
        missing_core_metrics: coreProfiles[ref.type].filter(m => !coverage.some(c => c.id === m.id)).map(m => m.id) };
    });
    // Prefer the least-cost compatible package that covers the product core. Never replace an existing binding here.
    const preferred = packages.filter(p => p.compatibility === 'compatible').sort((a,b) => a.missing_core_metrics.length - b.missing_core_metrics.length
      || a.release.package.collectors.length - b.release.package.collectors.length || b.release.package.version.localeCompare(a.release.package.version, undefined, { numeric: true }))[0];
    if (preferred) preferred.recommended = true;
    return { resource: ref, evaluated_at: at, packages };
  }
}
