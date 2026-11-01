import { checkApplicability, type ApplicabilityCheck } from '../packages/applicability.js';
import { CollectionPlanSchema, ResourceSchema, CapabilitySchema, TimestampSchema, resolveDecision, validateBindings,
  type Resource, type Capability, type MetricBinding, type MetricDefinition } from '../../contracts/metrics/index.js';
import { type PackageRegistry, type PackageRelease, stable } from '../packages/model.js';
import { type Binding, type Group, type Origin, type Resolved, type Settings, OverridesSchema, metricKey, refKey, rule } from './model.js';

export const PLATFORM_LIMITS = Object.freeze({ min_interval_ms: 1000, max_interval_ms: 86400000, min_timeout_ms: 250,
  max_timeout_ms: 30000, max_rows: 100, max_concurrency: 16, max_series_per_resource: 10000 });

export type SettingsKey = keyof Settings;
/** Every resolved setting, in the order the existing overrides loop always used. */
export const SETTINGS_KEYS: readonly SettingsKey[] = ['enabled', 'interval_ms', 'timeout_ms', 'stale_after_ms',
  'max_counter_gap_ms', 'max_rows', 'max_concurrency', 'max_series_per_resource'];

const PLATFORM_ORIGIN: Origin = { layer: 'platform', id: 'metrics-limits-v1' };
/** The existing package layer identity: `id@version` (the digest stays in the binding pin). */
export const packageOriginOf = (release: PackageRelease): Origin => ({
  layer: 'package', id: `${release.package.id}@${release.package.version}`,
});

/**
 * The settings a release recommends, extended with the platform-derived concurrency
 * and series budget. Extracted verbatim from `resolvePolicy` so the single-package
 * and multi-template paths share one default rule.
 */
export function defaultSettings(release: PackageRelease, definitions: MetricDefinition[]): Settings {
  const requiredDimensions = (metric: MetricBinding['metric']) => definitions.find(d => metricKey(d) === metricKey(metric))!.dimensions.keys.filter(k => k.required).map(k => k.name);
  const packageMetrics = [...release.package.collectors.flatMap(c => c.mappings.map(m => m.metric)), ...release.derived.map(d => d.output)];
  const defaultSeries = packageMetrics.reduce((sum, m) => sum + (requiredDimensions(m).length ? release.recommendations.max_rows : 1), 0);
  return { ...release.recommendations, max_concurrency: 1,
    max_series_per_resource: Math.min(PLATFORM_LIMITS.max_series_per_resource, Math.max(100, defaultSeries)) };
}

/** Provenance of {@link defaultSettings}: recommendations from the package, limits from the platform. */
export function defaultSettingSources(release: PackageRelease): Record<SettingsKey, Origin> {
  const packageOrigin = packageOriginOf(release);
  return Object.fromEntries(SETTINGS_KEYS.map(key => [key,
    ['max_concurrency', 'max_series_per_resource'].includes(key) ? PLATFORM_ORIGIN : packageOrigin])) as Record<SettingsKey, Origin>;
}

export interface PolicyLayerState {
  settings: Settings;
  sources: Record<SettingsKey, Origin>;
  toggles: Map<string, boolean>;
  metricSources: Record<string, Origin>;
}
export interface PolicyLayerResult extends PolicyLayerState {
  /** Settings fields this layer set explicitly (an `inherit`/absent field is not explicit). */
  explicit: SettingsKey[];
}

/**
 * Apply one existing `OverridesSchema` layer (group or resource) over a state.
 * The rules, unknown-metric rejection and `inherit` semantics are exactly those
 * `resolvePolicy` always used; the state is copied so a caller keeps its input.
 */
export function applyPolicyLayer(state: PolicyLayerState, overrides: unknown, origin: Origin): PolicyLayerResult {
  const settings = { ...state.settings }, sources = { ...state.sources }, metricSources = { ...state.metricSources };
  const toggles = new Map(state.toggles);
  const explicit: SettingsKey[] = [];
  const parsed = OverridesSchema.parse(overrides);
  for (const key of SETTINGS_KEYS) {
    if (key === 'enabled') {
      if (parsed.enabled && parsed.enabled !== 'inherit') {
        settings.enabled = parsed.enabled === 'enable'; sources.enabled = origin; explicit.push('enabled');
      }
    } else {
      const override = parsed[key];
      if (override?.mode === 'set') { settings[key] = override.value; sources[key] = origin; explicit.push(key); }
    }
  }
  for (const [key, mode] of Object.entries(parsed.metrics ?? {})) {
    rule(toggles.has(key), 'POLICY_UNKNOWN_METRIC');
    if (mode !== 'inherit') { toggles.set(key, mode === 'enable'); metricSources[key] = origin; }
  }
  return { settings, sources, toggles, metricSources, explicit };
}

/** The platform limits `resolvePolicy` has always enforced, applied to a resolved settings set. */
export function validatePlatformSettings(settings: Settings): void {
  rule(settings.interval_ms >= PLATFORM_LIMITS.min_interval_ms && settings.interval_ms <= PLATFORM_LIMITS.max_interval_ms, 'POLICY_INTERVAL');
  rule(settings.timeout_ms >= PLATFORM_LIMITS.min_timeout_ms && settings.timeout_ms <= PLATFORM_LIMITS.max_timeout_ms
    && settings.timeout_ms <= settings.interval_ms, 'POLICY_TIMEOUT');
  rule(settings.stale_after_ms >= settings.interval_ms && settings.max_counter_gap_ms >= settings.interval_ms, 'POLICY_TIMING');
  rule(settings.max_rows <= PLATFORM_LIMITS.max_rows && settings.max_concurrency <= PLATFORM_LIMITS.max_concurrency
    && settings.max_series_per_resource <= PLATFORM_LIMITS.max_series_per_resource, 'POLICY_CAPACITY');
}

/** Physical collector timeout: the existing package cap/min rule with its origin. */
export function collectorTimeouts(release: PackageRelease, settings: Settings,
  sources: Record<SettingsKey, Origin>): Resolved['collector_timeouts'] {
  const packageOrigin = packageOriginOf(release);
  return release.package.collectors.map(c => ({ collector_id: c.id, timeout_ms: Math.min(c.timeout_ms, settings.timeout_ms),
    source: c.timeout_ms < settings.timeout_ms ? packageOrigin : sources.timeout_ms }));
}

export interface ItemCapabilityInput {
  resource: Resource;
  metric: MetricBinding['metric'];
  method: Capability['method'];
  capabilities: Capability[];
  applicability: ApplicabilityCheck[];
  at: string;
  stale_after_ms: number;
}

/**
 * The existing capability rule: latest supplied capability for this resource,
 * metric and method inside its validity window, otherwise `unknown` with a
 * non-probing basis; a non-supported applicability check overrides it with
 * explicit evidence. Extracted from `resolvePolicy` unchanged.
 */
export function resolveItemCapability(input: ItemCapabilityInput): Capability {
  const { resource, metric, method, capabilities, applicability, at, stale_after_ms } = input;
  const supplied = capabilities.filter(c => c.resource_id === resource.id && metricKey(c.metric) === metricKey(metric) && c.method === method)
    .map(c => CapabilitySchema.parse(c)).sort((a, b) => Date.parse(b.evaluated_at) - Date.parse(a.evaluated_at) || stable(a).localeCompare(stable(b)));
  let capability: Capability = supplied.find(c => Date.parse(c.evaluated_at) <= Date.parse(at) && Date.parse(c.valid_until) > Date.parse(at)) ?? {
    resource_id: resource.id, metric, method, status: 'unknown',
    basis: [{ kind: 'method', evidence: supplied.length ? 'capability_expired_or_future' : 'capability_not_probed' }],
    evaluated_at: at, valid_until: new Date(Date.parse(at) + stale_after_ms).toISOString(),
  };
  if (applicability.some(a => a.status !== 'supported')) capability = {
    ...capability, status: applicability.some(a => a.status === 'unsupported') ? 'unsupported' : 'unknown',
    basis: applicability.map(a => ({ kind: a.attribute.includes('version') ? 'version' as const : 'resource' as const,
      evidence: `${a.attribute}:${a.status};observed_at:${resource.attributes[a.attribute]?.observed_at ?? 'unknown'}` })),
    evaluated_at: at, valid_until: new Date(Date.parse(at) + stale_after_ms).toISOString(),
  };
  return capability;
}

/** Pure: caller supplies time and trusted inventory/capabilities; never resolves a credential or makes a remote request. */
export function resolvePolicy(registry: PackageRegistry, binding: Binding, group: Group | null,
  resourceInput: Resource, capabilities: Capability[], at: string): Resolved {
  TimestampSchema.parse(at);
  const resource = ResourceSchema.parse(resourceInput);
  rule(resource.type === binding.resource.type && resource.id === String(binding.resource.id), 'POLICY_RESOURCE');
  rule(binding.group_id === (group?.id ?? null), 'POLICY_GROUP');
  const release = registry.get(binding.package), p = release.package;
  const definitions = registry.catalog(binding.package);
  const requiredDimensions = (metric: MetricBinding['metric']) => definitions.find(d => metricKey(d) === metricKey(metric))!.dimensions.keys.filter(k => k.required).map(k => k.name);
  rule(resource.type === p.resource_type, 'POLICY_PACKAGE_RESOURCE');
  const packageOrigin = packageOriginOf(release);
  const metricToggles = new Map<string, boolean>();
  const metricSources: Record<string, Origin> = {};
  const mappings: MetricBinding[] = p.collectors.flatMap(c => c.mappings.map(m => ({
    id: `${refKey(binding.resource)}:${m.metric.id}`, collection_binding_id: refKey(binding.resource), resource_id: resource.id,
    metric: m.metric, dimensions: {}, enabled: true, source: { kind: 'collector' as const, collector_id: c.id, raw_field: m.raw_field },
  })));
  for (const d of release.derived) mappings.push({ id: `${refKey(binding.resource)}:${d.output.id}`, collection_binding_id: refKey(binding.resource),
    resource_id: resource.id, metric: d.output, dimensions: {}, enabled: true, source: { kind: 'derived', derived_id: d.id } });
  for (const m of mappings) { metricToggles.set(metricKey(m.metric), true); metricSources[metricKey(m.metric)] = packageOrigin; }
  let state: PolicyLayerState = { settings: defaultSettings(release, definitions), sources: defaultSettingSources(release),
    toggles: metricToggles, metricSources };
  for (const layer of [
    ...(group ? [{ overrides: group.overrides, origin: { layer: 'group', id: group.id, revision: group.policy_revision ?? group.revision } as Origin }] : []),
    { overrides: binding.overrides, origin: { layer: 'resource', id: refKey(binding.resource), revision: binding.revision } as Origin },
  ]) state = applyPolicyLayer(state, layer.overrides, layer.origin);
  const settings = state.settings, sources = state.sources;
  validatePlatformSettings(settings);

  const dependencies = release.derived.map(d => ({ metric: metricKey(d.output), requires: d.inputs.map(metricKey) }));
  for (const d of dependencies) rule(!state.toggles.get(d.metric) || d.requires.every(k => state.toggles.get(k)), 'POLICY_DEPENDENCY_DISABLED');

  const collection = { id: refKey(binding.resource), resource_id: resource.id, resource_type: resource.type,
    package: binding.package, policy_id: group?.id ?? `resource:${refKey(binding.resource)}`, policy_revision: group ? group.policy_revision ?? group.revision : binding.revision,
    config_revision: binding.revision, enabled: settings.enabled };
  const { max_rows: _rows, ...policySettings } = settings;
  const policy = { id: collection.policy_id, revision: collection.policy_revision, ...policySettings };
  const applicable = checkApplicability(p, resource, at);
  const entries = mappings.map(m => {
    const method = m.source.kind === 'derived' ? 'derived' as const : p.collectors.find(c => c.id === (m.source as { collector_id: string }).collector_id)!.method;
    const capability = resolveItemCapability({ resource, metric: m.metric, method, capabilities, applicability: applicable, at,
      stale_after_ms: settings.stale_after_ms });
    m.enabled = state.toggles.get(metricKey(m.metric))!;
    return { binding: m, capability, decision: resolveDecision(collection, policy, m, capability, at) };
  });
  // Propagate capability through a validated acyclic package DAG, independently of declaration order.
  const visited = new Set<string>();
  const propagate = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const dependency = dependencies.find(d => d.metric === key);
    if (!dependency) return;
    dependency.requires.forEach(propagate);
    const entry = entries.find(e => metricKey(e.binding.metric) === key)!;
    const inputs = dependency.requires.map(k => entries.find(e => metricKey(e.binding.metric) === k)!);
    if (entry.decision === 'disabled') return;
    if (inputs.some(e => e.decision === 'unsupported')) { entry.capability.status = 'unsupported'; entry.decision = 'unsupported'; }
    else if (inputs.some(e => e.decision === 'capability_unknown')) { entry.capability.status = 'unknown'; entry.decision = 'capability_unknown'; }
    else if (entry.capability.status === 'unknown' && !suppliedDerived(key)) { entry.capability.status = 'supported'; entry.decision = 'derive'; }
    entry.capability.basis = [...entry.capability.basis, ...inputs.flatMap(e => e.capability.basis)];
  };
  const suppliedDerived = (key: string) => capabilities.some(c => metricKey(c.metric) === key && c.resource_id === resource.id && c.method === 'derived'
    && Date.parse(c.evaluated_at) <= Date.parse(at) && Date.parse(c.valid_until) > Date.parse(at));
  dependencies.forEach(d => propagate(d.metric));
  const active = p.collectors.filter(c => entries.some(e => e.binding.source.kind === 'collector' && e.binding.source.collector_id === c.id
    && ['collect', 'capability_unknown'].includes(e.decision)));
  const timeouts = collectorTimeouts(release, settings, sources);
  // Dimensioned outputs are discovery templates, never fabricate an empty-dimensional MetricBinding.
  const concreteEntries = entries.filter(e => requiredDimensions(e.binding.metric).length === 0);
  validateBindings({ collections: [collection], policies: [policy], packages: [p], derived: release.derived,
    metrics: concreteEntries.map(e => e.binding) }, definitions);
  const estimatedSeries = entries.filter(e => e.decision !== 'disabled' && e.decision !== 'unsupported')
    .reduce((n, e) => n + (requiredDimensions(e.binding.metric).length ? settings.max_rows : 1), 0);
  rule(estimatedSeries <= settings.max_series_per_resource, 'POLICY_SERIES_BUDGET');
  return { applicability: applicable, plan: CollectionPlanSchema.parse({ binding: collection, policy, resolved_at: at, entries: concreteEntries }), settings, sources, platform_limits: { ...PLATFORM_LIMITS },
    metric_templates: entries.map(e => ({ metric: e.binding.metric, source: e.binding.source, enabled: e.binding.enabled,
      required_dimensions: requiredDimensions(e.binding.metric), capability: e.capability, decision: e.decision })),
    metric_sources: state.metricSources, dependencies, collector_timeouts: timeouts,
    impact: { estimate: true, request_unit: 'logical_reads', estimated_series_upper_bound: estimatedSeries, active_collectors: active.map(c => c.id),
      // Linux performs two fixed reads; SNMP is one table walk. Wire pagination/retries are not known at publication.
      requests_per_hour_estimate: active.reduce((n, c) => n + (c.method === 'ssh' ? 2 : 1), 0) * 3600000 / settings.interval_ms,
      disabled_metrics: entries.filter(e => e.decision === 'disabled').map(e => metricKey(e.binding.metric)),
      unavailable_metrics: entries.filter(e => ['unsupported', 'capability_unknown'].includes(e.decision)).map(e => metricKey(e.binding.metric)) } };
}
