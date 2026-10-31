/**
 * MAX-239 test support: a real B2C resolution and a real trigger catalog.
 *
 * The resolution is produced by the accepted `resolveTemplateBinding` over a
 * sealed package release installed in the real `PackageRegistry`, a schema-valid
 * binding and validated template versions — not by a hand-shaped stub. The rule
 * catalog is an explicit in-memory port implementing the same interface a
 * persistence-backed catalog must implement later.
 */
import { vi } from 'vitest';
import type {
  Capability, CollectorDefinition, MetricDefinition, Resource,
} from '../../contracts/metrics/index.js';
import type {
  PackageCompositionEntry, ResourceBindingCandidate, TemplateItemVersion, TemplateParameters,
  TemplatePin, TemplateVersion, VersionNumber,
} from '../../contracts/metrics/templates.js';
import type {
  TriggerRuleVersion, TriggerSample,
} from '../../contracts/metrics/triggers.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from '../packages/model.js';
import { packageReleaseRef, templateContentHash, type MetricRef } from '../templates/model.js';
import type { TemplateVersionReadPort } from '../bindings/preflight.js';
import { resolveTemplateBinding, templateResolutionIdentity, type ResolvedTemplateBinding } from '../bindings/resolve.js';
import { triggerRuleContentHash } from './model.js';
import type { TriggerRuleCatalogPort } from './resolve.js';

export const T0 = '2026-10-01T00:00:00Z';
export const T1 = '2026-10-02T00:00:00Z';
export const AT = '2026-09-18T00:00:00.000Z';
export const NOW = '2026-10-29T12:00:00Z';
export const FIVE_SECONDS_AGO = '2026-10-29T11:59:55.000Z';

type ExtensionDefinition = Extract<MetricDefinition, { category: 'extension' }>;
type CollectorStep = CollectorDefinition['mappings'][number]['steps'];

const dims = () => ({
  keys: [], max_series_per_resource: 100, max_value_length: 128, overflow: 'reject' as const,
});

export function extension(id: string, unit: MetricDefinition['unit'], valueType: MetricDefinition['value_type'] = 'float64'): ExtensionDefinition {
  return {
    category: 'extension', namespace: id.slice(0, id.indexOf('.')), id, semantic_version: '1.0.0',
    meaning: `${id} fixture metric`, resource_type: 'instance', unit, scope: 'resource', kind: 'gauge',
    roles: ['diagnostic'], temporality: 'instant', monotonic: false, value_type: valueType, dimensions: dims(),
    aggregation: {
      time: ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null', min_coverage: 1,
      quantiles: 'not_applicable',
    },
    lifecycle: 'active',
  };
}

export const alpha = extension('fixture.alpha', '1');
export const beta = extension('fixture.beta', 'count');
export const extensions: ExtensionDefinition[] = [alpha, beta];

const mainImpl: ImplementationSpec = {
  id: 'impl:fixture.main', method: 'sql', resource_type: 'instance',
  applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
  outputs: [
    { raw_field: 'alpha', definition: alpha, input_unit: '1' },
    { raw_field: 'beta', definition: beta, input_unit: 'count' },
  ],
  permissions: ['SHOW FIXTURE MAIN'],
  discovery: 'fixture main singleton status row',
};

const status = (): CollectorDefinition => ({
  id: 'status', method: 'sql', implementation_ref: mainImpl.id, timeout_ms: 5000, estimated_cost: 'low',
  mappings: [alpha, beta].map(definition => ({
    metric: { id: definition.id, semantic_version: definition.semantic_version },
    raw_field: definition.id.slice('fixture.'.length), input_unit: definition.unit,
    output_unit: definition.unit, transform_version: '1.0.0', steps: ['decode', 'normalize'] as CollectorStep,
  })),
});

export function fixtureRelease(packageId = 'fixture-triggers', version = '1.0.0'): PackageRelease {
  return sealRelease({
    package: {
      id: packageId, version, contract_version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`,
      resource_type: 'instance', applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
      collectors: [status()],
    },
    extensions, derived: [], transforms: [{ id: 'normalize', version: '1.0.0' }],
    recommendations: {
      interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000, max_counter_gap_ms: 300000,
      max_rows: 100, enabled: true,
    },
    documentation: [{ collector_id: 'status', permissions: mainImpl.permissions, discovery: mainImpl.discovery }],
  });
}

export function fixtureRegistry(): PackageRegistry {
  const registry = new PackageRegistry([], [mainImpl]);
  registry.install(fixtureRelease());
  return registry;
}

export const metricRef = (definition: ExtensionDefinition): MetricRef => ({
  id: definition.id, semantic_version: definition.semantic_version,
});

export function resource(): Resource {
  return {
    type: 'instance', id: '7',
    attributes: { 'db.engine': { value: 'fixture', observed_at: AT, source: 'fixture' } },
  };
}

export function capabilities(): Capability[] {
  return [alpha, beta].map(definition => ({
    resource_id: '7', metric: metricRef(definition), method: 'sql', status: 'supported',
    basis: [{ kind: 'permission', evidence: 'fixed_read_succeeded' }], evaluated_at: AT,
    valid_until: '2026-09-19T00:00:00.000Z',
  }));
}

export function parameterSpec(schema: TemplateParameters['schema'], defaults: TemplateParameters['defaults']): TemplateParameters {
  return { schema, defaults };
}

/** The 90/70 problem/recovery pair used by the acceptance story, as a rule body. */
export function thresholdRule(overrides: Partial<TriggerRuleVersion> = {}): TriggerRuleVersion {
  const body = {
    rule_id: 'alpha-threshold',
    version: 1,
    scope: 'item:alpha',
    metric: metricRef(alpha),
    unit: '1' as const,
    parameters: parameterSpec(
      { problem_threshold: { type: 'number' as const, min: 0, max: 1000 }, recovery_threshold: { type: 'number' as const, min: 0, max: 1000 } },
      { problem_threshold: 90, recovery_threshold: 70 },
    ),
    problem: {
      node: 'compare' as const, select: { aggregation: 'last' as const }, operator: '>' as const,
      threshold: { kind: 'parameter' as const, name: 'problem_threshold' },
    },
    recovery: {
      node: 'compare' as const, select: { aggregation: 'last' as const }, operator: '<' as const,
      threshold: { kind: 'parameter' as const, name: 'recovery_threshold' },
    },
    quality: { accepted_quality: ['good', 'partial'] as Array<'good' | 'partial'>, min_coverage: 1, allow_estimated: false },
    clock: { stale_after_ms: 120000, nodata: { enabled: true as const, after_ms: 300000 } },
    ...overrides,
  };
  const { content_hash: _ignored, ...hashable } = body as TriggerRuleVersion;
  return { ...hashable, content_hash: triggerRuleContentHash(hashable) } as TriggerRuleVersion;
}

/** A windowed rule for `avg` over one minute, over the same item. */
export function averageRule(overrides: Partial<TriggerRuleVersion> = {}): TriggerRuleVersion {
  const body = {
    ...thresholdRule(),
    rule_id: 'alpha-average', version: 1,
    problem: {
      node: 'compare' as const,
      select: { aggregation: 'avg' as const, window_ms: 60000 },
      operator: '>=' as const, threshold: { kind: 'constant' as const, value: 80 },
    },
    recovery: {
      node: 'compare' as const,
      select: { aggregation: 'avg' as const, window_ms: 60000 },
      operator: '<' as const, threshold: { kind: 'constant' as const, value: 50 },
    },
    ...overrides,
  };
  const { content_hash: _ignored, ...hashable } = body as TriggerRuleVersion;
  return { ...hashable, content_hash: triggerRuleContentHash(hashable) } as TriggerRuleVersion;
}

export function item(templateId: string, itemId: string, definition: ExtensionDefinition, release: PackageRelease): TemplateItemVersion {
  return {
    template_id: templateId, item_id: itemId, version: 1, display_name: itemId,
    canonical_metric: metricRef(definition), unit: definition.unit, dimensions: {},
    collector_ref: { package_release: packageReleaseRef(release.package), implementation_id: mainImpl.id },
    params_default: {},
    source_chain: {
      actor_id: 1, request_id: `req-item-${templateId}-${itemId}`, base: null, created_at: T0,
      published_at: T1, retired_at: null, migration_ref: null,
    },
  };
}

export interface TemplateSpec {
  template_id: string;
  items: TemplateItemVersion[];
  version?: VersionNumber;
  triggers?: TemplateVersion['aggregate']['triggers'];
}

export function templateVersion(spec: TemplateSpec): TemplateVersion {
  const byRelease = new Map<string, string[]>();
  for (const stored of spec.items) {
    const ids = byRelease.get(stored.collector_ref.package_release) ?? [];
    ids.push(stored.item_id);
    byRelease.set(stored.collector_ref.package_release, ids);
  }
  const composition: PackageCompositionEntry[] = [...byRelease.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([entryRelease, ids]) => ({ release: entryRelease, items: [...ids].sort() }));
  const aggregate = {
    template_id: spec.template_id, base: null,
    items: spec.items.map(stored => ({ item_id: stored.item_id, version: stored.version }))
      .sort((left, right) => left.item_id < right.item_id ? -1 : left.item_id > right.item_id ? 1 : 0),
    triggers: [...(spec.triggers ?? [])].sort((left, right) => {
      const byRule = left.rule_id < right.rule_id ? -1 : left.rule_id > right.rule_id ? 1 : 0;
      return byRule !== 0 ? byRule : left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0;
    }),
    parameters: parameterSpec({}, {}),
    capabilities: {
      discovery: { contract_version: '1.0.0', ref: null, executable: false as const },
      graphs: { contract_version: '1.0.0', ref: null, executable: false as const },
    },
    package_composition: composition,
  };
  return {
    template_id: spec.template_id, version: spec.version ?? 1, status: 'published',
    content_hash: templateContentHash(aggregate), aggregate, items: spec.items, package_composition: composition,
    source_chain: {
      actor_id: 1, request_id: `req-${spec.template_id}`, base: null, created_at: T0,
      published_at: T1, retired_at: null, migration_ref: null,
    },
    published_at: T1, retired_at: null,
  };
}

export const pinOf = (version: TemplateVersion): TemplatePin => ({
  template_id: version.template_id, version: version.version, content_hash: version.content_hash,
});

export function portOf(versions: TemplateVersion[]) {
  const getVersion = vi.fn(async (templateId: string, version: VersionNumber) =>
    versions.find(entry => entry.template_id === templateId && entry.version === version) ?? null);
  return { port: { getVersion } satisfies TemplateVersionReadPort, getVersion };
}

export function bindingOf(pins: TemplatePin[], overrides: Record<string, unknown> = {}): ResourceBindingCandidate {
  return {
    resource: { type: 'instance', id: 7 }, package: null, group_id: null, overrides, revision: 4,
    template_pins: pins,
  };
}

/** An in-memory catalog port; the same interface a persistence-backed catalog must satisfy. */
export class FixtureCatalog implements TriggerRuleCatalogPort {
  constructor(private readonly rules: TriggerRuleVersion[]) {}
  getVersion = vi.fn(async (ruleId: string, version: number): Promise<unknown> =>
    this.rules.find(rule => rule.rule_id === ruleId && rule.version === version) ?? null);
}

export interface Baseline {
  version: TemplateVersion;
  resolution: ResolvedTemplateBinding;
  catalog: FixtureCatalog;
  rules: TriggerRuleVersion[];
  planIdentity: string;
}

/**
 * Build the real chain: sealed release → registry → fixed template version with
 * trigger references → B1/B2A/B2B/B2C resolution. Tests then resolve triggers.
 */
export async function baseline(options: { rules?: TriggerRuleVersion[]; triggers?: TemplateVersion['aggregate']['triggers'] } = {}): Promise<Baseline> {
  const release = fixtureRelease();
  const version = templateVersion({
    template_id: 'tpl-monitoring',
    items: [item('tpl-monitoring', 'alpha', alpha, release)],
    triggers: options.triggers ?? [
      { rule_id: 'alpha-threshold', scope: 'item:alpha', version: 1 },
      { rule_id: 'alpha-average', scope: 'item:alpha', version: 1 },
    ],
  });
  const rules = options.rules ?? [thresholdRule(), averageRule()];
  const resolution = await resolveTemplateBinding(
    bindingOf([pinOf(version)]),
    { resource: resource(), group: null, capabilities: capabilities(), at: AT },
    portOf([version]).port,
    fixtureRegistry(),
  ) as ResolvedTemplateBinding;
  return {
    version, resolution, rules, catalog: new FixtureCatalog(rules),
    planIdentity: templateResolutionIdentity(resolution),
  };
}

export const near = (value: number, overrides: Partial<TriggerSample> = {}): TriggerSample => ({
  metric: metricRef(alpha),
  unit: '1',
  value: { encoding: 'float64', value },
  observed_at: FIVE_SECONDS_AGO,
  dimensions: {},
  quality: { status: 'good', reason: 'none' },
  accuracy: 'exact',
  coverage: 1,
  window: null,
  ...overrides,
});

export const evidence = (overrides: Record<string, unknown> = {}) => ({
  resource: { type: 'instance', id: 7 },
  applied_revision: 4,
  plan_identity: 'sha256:' + '0'.repeat(64),
  application_status: 'applied',
  ...overrides,
});
