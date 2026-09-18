import { CollectionPlanSchema, ResourceSchema, CapabilitySchema, TimestampSchema, resolveDecision, validateBindings,
  type Resource, type Capability, type MetricBinding } from '../../contracts/metrics-v2/index.js';
import { type PackageRegistry, stable } from '../packages/model.js';
import { type Binding, type Group, type Origin, type Resolved, type Settings, OverridesSchema, metricKey, refKey, rule } from './model.js';

export const PLATFORM_LIMITS = Object.freeze({ min_interval_ms: 1000, max_interval_ms: 86400000, min_timeout_ms: 250,
  max_timeout_ms: 30000, max_rows: 100, max_concurrency: 16, max_series_per_resource: 10000 });

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
  const packageOrigin: Origin = { layer: 'package', id: `${p.id}@${p.version}` };
  const platformOrigin: Origin = { layer: 'platform', id: 'metrics-v2-limits-v1' };
  const settings: Settings = { ...release.recommendations, max_concurrency: 1, max_series_per_resource: 100 };
  const sources = Object.fromEntries(Object.keys(settings).map(key => [key,
    ['max_concurrency', 'max_series_per_resource'].includes(key) ? platformOrigin : packageOrigin])) as Resolved['sources'];
  const metricToggles = new Map<string, boolean>();
  const metricSources: Record<string, Origin> = {};
  const mappings: MetricBinding[] = p.collectors.flatMap(c => c.mappings.map(m => ({
    id: `${refKey(binding.resource)}:${m.metric.id}`, collection_binding_id: refKey(binding.resource), resource_id: resource.id,
    metric: m.metric, dimensions: {}, enabled: true, source: { kind: 'collector' as const, collector_id: c.id, raw_field: m.raw_field },
  })));
  for (const d of release.derived) mappings.push({ id: `${refKey(binding.resource)}:${d.output.id}`, collection_binding_id: refKey(binding.resource),
    resource_id: resource.id, metric: d.output, dimensions: {}, enabled: true, source: { kind: 'derived', derived_id: d.id } });
  for (const m of mappings) { metricToggles.set(metricKey(m.metric), true); metricSources[metricKey(m.metric)] = packageOrigin; }
  for (const layer of [
    ...(group ? [{ overrides: group.overrides, origin: { layer: 'group', id: group.id, revision: group.policy_revision ?? group.revision } as Origin }] : []),
    { overrides: binding.overrides, origin: { layer: 'resource', id: refKey(binding.resource), revision: binding.revision } as Origin },
  ]) {
    const overrides = OverridesSchema.parse(layer.overrides);
    for (const key of Object.keys(settings) as Array<keyof Settings>) {
      if (key === 'enabled') {
        if (overrides.enabled && overrides.enabled !== 'inherit') { settings.enabled = overrides.enabled === 'enable'; sources.enabled = layer.origin; }
      } else {
        const override = overrides[key];
        if (override?.mode === 'set') { settings[key] = override.value; sources[key] = layer.origin; }
      }
    }
    for (const [key, mode] of Object.entries(overrides.metrics ?? {})) {
      rule(metricToggles.has(key), 'POLICY_UNKNOWN_METRIC');
      if (mode !== 'inherit') { metricToggles.set(key, mode === 'enable'); metricSources[key] = layer.origin; }
    }
  }
  rule(settings.interval_ms >= PLATFORM_LIMITS.min_interval_ms && settings.interval_ms <= PLATFORM_LIMITS.max_interval_ms, 'POLICY_INTERVAL');
  rule(settings.timeout_ms >= PLATFORM_LIMITS.min_timeout_ms && settings.timeout_ms <= PLATFORM_LIMITS.max_timeout_ms
    && settings.timeout_ms <= settings.interval_ms, 'POLICY_TIMEOUT');
  rule(settings.stale_after_ms >= settings.interval_ms && settings.max_counter_gap_ms >= settings.interval_ms, 'POLICY_TIMING');
  rule(settings.max_rows <= PLATFORM_LIMITS.max_rows && settings.max_concurrency <= PLATFORM_LIMITS.max_concurrency
    && settings.max_series_per_resource <= PLATFORM_LIMITS.max_series_per_resource, 'POLICY_CAPACITY');
  const dependencies = release.derived.map(d => ({ metric: metricKey(d.output), requires: d.inputs.map(metricKey) }));
  for (const d of dependencies) rule(!metricToggles.get(d.metric) || d.requires.every(k => metricToggles.get(k)), 'POLICY_DEPENDENCY_DISABLED');

  const collection = { id: refKey(binding.resource), resource_id: resource.id, resource_type: resource.type,
    package: binding.package, policy_id: group?.id ?? `resource:${refKey(binding.resource)}`, policy_revision: group ? group.policy_revision ?? group.revision : binding.revision,
    config_revision: binding.revision, enabled: settings.enabled };
  const { max_rows: _rows, ...policySettings } = settings;
  const policy = { id: collection.policy_id, revision: collection.policy_revision, ...policySettings };
  const applicable = p.applicability.map(c => {
    const attribute = resource.attributes[c.attribute];
    const valid = attribute && Date.parse(attribute.observed_at) <= Date.parse(at);
    const value = valid ? attribute.value : undefined;
    const normalized = c.attribute === 'db.version' && typeof value === 'string' ? value.split('.').slice(0, 2).join('.') : String(value);
    return { condition: c, status: value === undefined ? 'unknown' : c.values.includes(normalized) ? 'supported' : 'unsupported', attribute };
  });
  const entries = mappings.map(m => {
    const method = m.source.kind === 'derived' ? 'derived' as const : p.collectors.find(c => c.id === (m.source as { collector_id: string }).collector_id)!.method;
    const supplied = capabilities.filter(c => c.resource_id === resource.id && metricKey(c.metric) === metricKey(m.metric) && c.method === method)
      .map(c => CapabilitySchema.parse(c)).sort((a, b) => Date.parse(b.evaluated_at) - Date.parse(a.evaluated_at) || stable(a).localeCompare(stable(b)));
    let capability: Capability = supplied.find(c => Date.parse(c.evaluated_at) <= Date.parse(at) && Date.parse(c.valid_until) > Date.parse(at)) ?? {
      resource_id: resource.id, metric: m.metric, method, status: 'unknown',
      basis: [{ kind: 'method', evidence: supplied.length ? 'capability_expired_or_future' : 'capability_not_probed' }],
      evaluated_at: at, valid_until: new Date(Date.parse(at) + settings.stale_after_ms).toISOString(),
    };
    if (applicable.some(a => a.status !== 'supported')) capability = {
      ...capability, status: applicable.some(a => a.status === 'unsupported') ? 'unsupported' : 'unknown',
      basis: applicable.map(a => ({ kind: a.condition.attribute.includes('version') ? 'version' as const : 'resource' as const,
        evidence: `${a.condition.attribute}:${a.status};observed_at:${a.attribute?.observed_at ?? 'unknown'}` })),
      evaluated_at: at, valid_until: new Date(Date.parse(at) + settings.stale_after_ms).toISOString(),
    };
    m.enabled = metricToggles.get(metricKey(m.metric))!;
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
  const collectorTimeouts = p.collectors.map(c => ({ collector_id: c.id, timeout_ms: Math.min(c.timeout_ms, settings.timeout_ms),
    source: c.timeout_ms < settings.timeout_ms ? packageOrigin : sources.timeout_ms }));
  // Dimensioned outputs are discovery templates, never fabricate an empty-dimensional MetricBinding.
  const concreteEntries = entries.filter(e => requiredDimensions(e.binding.metric).length === 0);
  validateBindings({ collections: [collection], policies: [policy], packages: [p], derived: release.derived,
    metrics: concreteEntries.map(e => e.binding) }, definitions);
  const estimatedSeries = entries.filter(e => e.decision !== 'disabled' && e.decision !== 'unsupported')
    .reduce((n, e) => n + (requiredDimensions(e.binding.metric).length ? settings.max_rows : 1), 0);
  rule(estimatedSeries <= settings.max_series_per_resource, 'POLICY_SERIES_BUDGET');
  return { plan: CollectionPlanSchema.parse({ binding: collection, policy, resolved_at: at, entries: concreteEntries }), settings, sources, platform_limits: { ...PLATFORM_LIMITS },
    metric_templates: entries.map(e => ({ metric: e.binding.metric, source: e.binding.source, enabled: e.binding.enabled,
      required_dimensions: requiredDimensions(e.binding.metric), capability: e.capability, decision: e.decision })),
    metric_sources: metricSources, dependencies, collector_timeouts: collectorTimeouts,
    impact: { estimate: true, request_unit: 'logical_reads', estimated_series_upper_bound: estimatedSeries, active_collectors: active.map(c => c.id),
      // Linux performs two fixed reads; SNMP is one table walk. Wire pagination/retries are not known at publication.
      requests_per_hour_estimate: active.reduce((n, c) => n + (c.method === 'ssh' ? 2 : 1), 0) * 3600000 / settings.interval_ms,
      disabled_metrics: entries.filter(e => e.decision === 'disabled').map(e => metricKey(e.binding.metric)),
      unavailable_metrics: entries.filter(e => ['unsupported', 'capability_unknown'].includes(e.decision)).map(e => metricKey(e.binding.metric)) } };
}
