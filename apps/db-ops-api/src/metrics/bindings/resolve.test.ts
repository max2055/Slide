import { describe, expect, it, vi } from 'vitest';
import type { Capability, CollectorDefinition, MetricDefinition, Resource } from '../../contracts/metrics/index.js';
import type {
  PackageCompositionEntry, ResourceBindingCandidate, TemplateItemVersion, TemplateParameters,
  TemplatePin, TemplateVersion, VersionNumber,
} from '../../contracts/metrics/templates.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from '../packages/model.js';
import { packageReleaseRef, templateContentHash, type MetricRef } from '../templates/model.js';
import { BindingPreflightError, type TemplateVersionReadPort } from './preflight.js';
import {
  resolveTemplateBinding, templateResolutionIdentity, TemplateResolutionError,
  type ResolvedTemplateBinding, type TemplateResolutionContext,
} from './resolve.js';

const T0 = '2026-10-01T00:00:00Z';
const T1 = '2026-10-02T00:00:00Z';
const at = '2026-09-18T00:00:00.000Z';

type ExtensionDefinition = Extract<MetricDefinition, { category: 'extension' }>;
type CollectorStep = CollectorDefinition['mappings'][number]['steps'];
interface KeySpec { name: string; allowed?: string[] }

const dims = (keys: KeySpec[] = []) => ({
  keys: keys.map(key => ({ name: key.name, meaning: `${key.name} fixture dimension`, required: true,
    ...(key.allowed === undefined ? {} : { allowed_values: key.allowed }) })),
  max_series_per_resource: 100, max_value_length: 128, overflow: 'reject' as const,
});

function extension(id: string, unit: MetricDefinition['unit'], keys: KeySpec[] = []): ExtensionDefinition {
  return {
    category: 'extension', namespace: id.slice(0, id.indexOf('.')), id, semantic_version: '1.0.0',
    meaning: `${id} fixture metric`, resource_type: 'instance', unit, scope: 'resource', kind: 'gauge',
    roles: ['diagnostic'], temporality: 'instant', monotonic: false, value_type: 'float64', dimensions: dims(keys),
    aggregation: { time: ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' },
    lifecycle: 'active',
  };
}

const alpha = extension('fixture.alpha', '1');
const beta = extension('fixture.beta', 'count');
const gamma = extension('fixture.gamma', 'By');
const delta = extension('fixture.delta', '%', [{ name: 'mount' }, { name: 'device', allowed: ['sda1', 'sdb1'] }]);
const extensions: ExtensionDefinition[] = [alpha, beta, gamma, delta];

const mainImpl: ImplementationSpec = {
  id: 'impl:fixture.main', method: 'sql', resource_type: 'instance',
  applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
  outputs: [
    { raw_field: 'alpha', definition: alpha, input_unit: '1' },
    { raw_field: 'beta', definition: beta, input_unit: 'count' },
    { raw_field: 'delta', definition: delta, input_unit: '%' },
  ],
  permissions: ['SHOW FIXTURE MAIN'], discovery: 'fixture main singleton status row',
};
const extraImpl: ImplementationSpec = {
  id: 'impl:fixture.extra', method: 'sql', resource_type: 'instance',
  applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
  outputs: [{ raw_field: 'gamma', definition: gamma, input_unit: 'By' }],
  permissions: ['SHOW FIXTURE EXTRA'], discovery: 'fixture extra bounded table',
};

interface MappingSpec { raw_field: string; metric: ExtensionDefinition }

function collector(id: string, implementation: ImplementationSpec, mappings: MappingSpec[]): CollectorDefinition {
  return {
    id, method: implementation.method, implementation_ref: implementation.id, timeout_ms: 5000, estimated_cost: 'low',
    mappings: mappings.map(entry => ({
      metric: { id: entry.metric.id, semantic_version: entry.metric.semantic_version },
      raw_field: entry.raw_field, input_unit: entry.metric.unit, output_unit: entry.metric.unit,
      transform_version: '1.0.0', steps: ['decode', 'normalize'] as CollectorStep,
    })),
  };
}

const status = collector('status', mainImpl, [
  { raw_field: 'alpha', metric: alpha }, { raw_field: 'beta', metric: beta }, { raw_field: 'delta', metric: delta },
]);
const extra = collector('extra', extraImpl, [{ raw_field: 'gamma', metric: gamma }]);

function release(packageId: string, version: string, recommendations: Partial<PackageRelease['recommendations']> = {}): PackageRelease {
  return sealRelease({
    package: {
      id: packageId, version, contract_version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`,
      resource_type: 'instance', applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
      collectors: [status, extra],
    },
    extensions, derived: [], transforms: [{ id: 'normalize', version: '1.0.0' }],
    recommendations: { interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000, max_counter_gap_ms: 300000,
      max_rows: 100, enabled: true, ...recommendations },
    documentation: [
      { collector_id: 'status', permissions: mainImpl.permissions, discovery: mainImpl.discovery },
      { collector_id: 'extra', permissions: extraImpl.permissions, discovery: extraImpl.discovery },
    ],
  });
}

const releaseA1 = release('fixture-a', '1.0.0');
const releaseA2 = release('fixture-a', '2.0.0');
const releaseB = release('fixture-b', '1.0.0');
const releaseSlow = release('fixture-c', '1.0.0', { interval_ms: 90000 });

function fixtureRegistry(): PackageRegistry {
  const registry = new PackageRegistry([], [mainImpl, extraImpl]);
  for (const entry of [releaseA1, releaseA2, releaseB, releaseSlow]) registry.install(entry);
  return registry;
}

const refOf = (entry: PackageRelease): string => packageReleaseRef(entry.package);
const refObject = (entry: PackageRelease) => {
  const { id, version, digest } = entry.package;
  return { id, version, digest };
};
const metricRef = (definition: ExtensionDefinition): MetricRef => ({
  id: definition.id, semantic_version: definition.semantic_version,
});

interface ItemSpec {
  template_id: string;
  item_id: string;
  metric: ExtensionDefinition;
  release: string;
  dimensions?: Record<string, string>;
  implementation_id?: string;
  params?: Record<string, number | string | boolean>;
}

function item(spec: ItemSpec): TemplateItemVersion {
  return {
    template_id: spec.template_id, item_id: spec.item_id, version: 1, display_name: spec.item_id,
    canonical_metric: metricRef(spec.metric), unit: spec.metric.unit, dimensions: spec.dimensions ?? {},
    collector_ref: { package_release: spec.release, implementation_id: spec.implementation_id ?? mainImpl.id },
    params_default: spec.params ?? {},
    source_chain: { actor_id: 1, request_id: `req-item-${spec.template_id}-${spec.item_id}`, base: null,
      created_at: T0, published_at: T1, retired_at: null, migration_ref: null },
  };
}

interface VersionSpec {
  template_id: string;
  items: TemplateItemVersion[];
  version?: VersionNumber;
  parameters?: TemplateParameters;
  triggers?: TemplateVersion['aggregate']['triggers'];
}

function templateVersion(spec: VersionSpec): TemplateVersion {
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
    triggers: spec.triggers ?? [],
    parameters: spec.parameters ?? { schema: {}, defaults: {} },
    capabilities: {
      discovery: { contract_version: '1.0.0', ref: null, executable: false as const },
      graphs: { contract_version: '1.0.0', ref: null, executable: false as const },
    },
    package_composition: composition,
  };
  return {
    template_id: spec.template_id, version: spec.version ?? 1, status: 'published',
    content_hash: templateContentHash(aggregate), aggregate, items: spec.items, package_composition: composition,
    source_chain: { actor_id: 1, request_id: `req-${spec.template_id}`, base: null, created_at: T0,
      published_at: T1, retired_at: null, migration_ref: null },
    published_at: T1, retired_at: null,
  };
}

function pin(version: TemplateVersion): TemplatePin {
  return { template_id: version.template_id, version: version.version, content_hash: version.content_hash };
}

function portOf(versions: TemplateVersion[]) {
  const getVersion = vi.fn(async (templateId: string, version: VersionNumber) =>
    versions.find(entry => entry.template_id === templateId && entry.version === version) ?? null);
  return { port: { getVersion } satisfies TemplateVersionReadPort, getVersion };
}

function binding(overrides: Partial<ResourceBindingCandidate> = {}): ResourceBindingCandidate {
  return { resource: { type: 'instance', id: 7 }, package: null, group_id: null, overrides: {},
    revision: 4, template_pins: [], ...overrides };
}

function resource(attributes: Resource['attributes'] = {
  'db.engine': { value: 'fixture', observed_at: at, source: 'fixture' },
}): Resource {
  return { type: 'instance', id: '7', attributes };
}

function capability(metric: ExtensionDefinition, overrides: Partial<Capability> = {}): Capability {
  return { resource_id: '7', metric: metricRef(metric), method: 'sql', status: 'supported',
    basis: [{ kind: 'permission', evidence: 'fixed_read_succeeded' }], evaluated_at: at,
    valid_until: '2026-09-19T00:00:00.000Z', ...overrides };
}

function context(overrides: Partial<TemplateResolutionContext> = {}): TemplateResolutionContext {
  return { resource: resource(), group: null, capabilities: [], at, ...overrides };
}

const supported = (...metrics: ExtensionDefinition[]): Capability[] => metrics.map(metric => capability(metric));

async function failure(promise: Promise<unknown>): Promise<TemplateResolutionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateResolutionError);
    return error as TemplateResolutionError;
  }
  throw new Error('expected the resolution to reject');
}

function resolution(outcome: unknown): ResolvedTemplateBinding {
  const result = outcome as ResolvedTemplateBinding;
  expect(result.kind).toBe('template_resolution');
  return result;
}

const parameters = (schema: TemplateParameters['schema'], defaults: TemplateParameters['defaults']): TemplateParameters =>
  ({ schema, defaults });

describe('internal multi-template resolution', () => {
  it('resolves two exact releases with parameters, settings provenance and selected-only items', async () => {
    const registry = fixtureRegistry(), registryBefore = structuredClone(registry.list());
    const first = templateVersion({
      template_id: 'tpl-one',
      items: [item({ template_id: 'tpl-one', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
      parameters: parameters({ batch_size: { type: 'integer', min: 1, max: 100 } }, { batch_size: 10 }),
    });
    const second = templateVersion({
      template_id: 'tpl-two',
      items: [item({ template_id: 'tpl-two', item_id: 'gamma', metric: gamma, release: refOf(releaseB), implementation_id: extraImpl.id })],
      parameters: parameters({ batch_size: { type: 'integer', min: 1, max: 100 } }, { batch_size: 20 }),
    });
    const input = binding({ template_pins: [pin(first), pin(second)],
      overrides: { template_parameters: { 'tpl-one': { batch_size: 50 } } } });
    const original = structuredClone(input);

    const result = resolution(await resolveTemplateBinding(input, context({ capabilities: supported(alpha, gamma) }),
      portOf([first, second]).port, registry));

    expect(result.binding).toEqual(input);
    expect(result.resource).toEqual({ type: 'instance', id: '7' });
    expect(result.revision).toBe(4);
    expect(result.group).toBeNull();
    // The same parameter name stays isolated per template; the override never crosses.
    expect(result.templates.map(entry => entry.pin)).toEqual([pin(first), pin(second)]);
    expect(result.templates[0].parameters).toEqual([{ name: 'batch_size', type: 'integer', default: 10, override: 50,
      effective: 50, source: 'override' }]);
    expect(result.templates[1].parameters).toEqual([{ name: 'batch_size', type: 'integer', default: 20, override: null,
      effective: 20, source: 'default' }]);
    // Parameters never become cadence: the release recommendation still decides the interval.
    expect(result.settings.interval_ms).toBe(60000);
    expect(result.settings.max_series_per_resource).toBe(103);
    expect(result.sources.interval_ms).toEqual({ layer: 'package',
      releases: [refObject(releaseA1), refObject(releaseB)] });
    expect(result.sources.max_series_per_resource).toEqual({ layer: 'platform', id: 'metrics-limits-v1' });
    expect(result.releases.map(entry => entry.release_ref)).toEqual([refOf(releaseA1), refOf(releaseB)]);
    for (const entry of result.releases) {
      expect(entry.collectors).toHaveLength(1);
      expect(entry.collectors[0].items).toHaveLength(1);
      expect(entry.collectors[0].items[0].release_ref).toBe(entry.release_ref);
    }
    expect(result.releases[0].collectors[0].items[0].canonical_metric).toEqual(metricRef(alpha));
    expect(result.releases[1].collectors[0].collector_id).toBe('extra');
    expect(result.releases[1].collectors[0].items[0].canonical_metric).toEqual(metricRef(gamma));
    // Unselected mappings and the unpinned newer release never appear.
    const snapshot = JSON.stringify(result);
    expect(snapshot.includes('fixture-a@2.0.0')).toBe(false);
    expect(result.releases[0].collectors[0].items.map(entry => entry.item_id)).toEqual(['alpha']);
    expect(result.releases[0].collectors[0].items.some(entry => entry.mapping.raw_field === 'beta')).toBe(false);
    expect(result.executable).toBe(true);
    expect(result.excluded).toEqual([]);
    expect(result.triggers).toEqual([{ pin: pin(first), refs: [] }, { pin: pin(second), refs: [] }]);
    expect(input).toEqual(original);
    expect(registry.list()).toEqual(registryBefore);
  });

  it('keeps the same collector and implementation id isolated per release', async () => {
    const registry = fixtureRegistry();
    const one = templateVersion({ template_id: 'tpl-a', items: [
      item({ template_id: 'tpl-a', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })] });
    const two = templateVersion({ template_id: 'tpl-b', items: [
      item({ template_id: 'tpl-b', item_id: 'beta', metric: beta, release: refOf(releaseB) })] });

    const result = resolution(await resolveTemplateBinding(binding({ template_pins: [pin(one), pin(two)] }),
      context({ capabilities: supported(alpha, beta) }), portOf([one, two]).port, registry));

    expect(result.releases).toHaveLength(2);
    const [first, second] = result.releases;
    expect(first.collectors[0].collector_id).toBe('status');
    expect(second.collectors[0].collector_id).toBe('status');
    expect(first.collectors[0].implementation_id).toBe(second.collectors[0].implementation_id);
    expect(first.collectors[0].items.map(entry => entry.canonical_metric.id)).toEqual(['fixture.alpha']);
    expect(second.collectors[0].items.map(entry => entry.canonical_metric.id)).toEqual(['fixture.beta']);
    expect(first.collectors[0].items[0].release_ref).toBe(refOf(releaseA1));
    expect(second.collectors[0].items[0].release_ref).toBe(refOf(releaseB));
  });

  it('resolves string lengths, integer bounds and restores inheritance when an override is removed', async () => {
    const registry = fixtureRegistry();
    const version = templateVersion({
      template_id: 'tpl-params',
      items: [item({ template_id: 'tpl-params', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
      parameters: parameters({
        count: { type: 'integer', min: 1, max: 10 },
        label: { type: 'string', min: 2, max: 4 },
        flag: { type: 'boolean' },
        ratio: { type: 'number', min: 0.5, max: 2.5 },
      }, { count: 5, label: 'abc', flag: true, ratio: 1.5 }),
    });
    const pinned = binding({ template_pins: [pin(version)] });
    const port = portOf([version]).port;

    const inherited = resolution(await resolveTemplateBinding(pinned, context({ capabilities: supported(alpha) }), port, registry));
    expect(inherited.templates[0].parameters.map(entry => entry.source)).toEqual(['default', 'default', 'default', 'default']);
    expect(inherited.templates[0].parameters.map(entry => entry.effective)).toEqual([5, true, 'abc', 1.5]);

    const overridden = resolution(await resolveTemplateBinding({
      ...pinned, overrides: { template_parameters: { 'tpl-params': { count: 9, label: 'ab', flag: false, ratio: 2.5 } } },
    }, context({ capabilities: supported(alpha) }), port, registry));
    expect(overridden.templates[0].parameters.map(entry => entry.effective)).toEqual([9, false, 'ab', 2.5]);
    expect(overridden.templates[0].parameters.every(entry => entry.source === 'override')).toBe(true);

    const again = resolution(await resolveTemplateBinding(pinned, context({ capabilities: supported(alpha) }), port, registry));
    expect(again.templates).toEqual(inherited.templates);
  });

  it.each([
    ['unknown parameter', { nope: 1 }, 'RESOLVE_PARAMETER_UNKNOWN'],
    ['wrong type', { count: '5' }, 'RESOLVE_PARAMETER_TYPE'],
    ['non-integer integer', { count: 1.5 }, 'RESOLVE_PARAMETER_RANGE'],
    ['below minimum', { count: 0 }, 'RESOLVE_PARAMETER_RANGE'],
    ['above maximum', { count: 11 }, 'RESOLVE_PARAMETER_RANGE'],
    ['non-finite number', { ratio: Infinity }, 'RESOLVE_PARAMETER_RANGE'],
    ['string too short', { label: 'a' }, 'RESOLVE_PARAMETER_RANGE'],
    ['string too long', { label: 'abcde' }, 'RESOLVE_PARAMETER_RANGE'],
    ['boolean type', { flag: 'yes' }, 'RESOLVE_PARAMETER_TYPE'],
  ])('rejects an invalid override: %s', async (_, override, code) => {
    const registry = fixtureRegistry();
    const version = templateVersion({
      template_id: 'tpl-bad',
      items: [item({ template_id: 'tpl-bad', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
      parameters: parameters({
        count: { type: 'integer', min: 1, max: 10 },
        label: { type: 'string', min: 2, max: 4 },
        flag: { type: 'boolean' },
        ratio: { type: 'number', min: 0.5, max: 2.5 },
      }, { count: 5, label: 'abc', flag: true, ratio: 1.5 }),
    });
    const error = await failure(resolveTemplateBinding(binding({ template_pins: [pin(version)],
      overrides: { template_parameters: { 'tpl-bad': override } } }),
    context({ capabilities: supported(alpha) }), portOf([version]).port, registry));
    expect(error.code).toBe(code);
    expect(error.location.template_id).toBe('tpl-bad');
  });

  it('rejects unselected templates, unsupported specs, invalid defaults and a missing value', async () => {
    const registry = fixtureRegistry();
    const base = templateVersion({
      template_id: 'tpl-spec',
      items: [item({ template_id: 'tpl-spec', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
      parameters: parameters({ size: { type: 'string' } }, { size: 'x' }),
    });
    const pinned = binding({ template_pins: [pin(base)] });

    const unselected = await failure(resolveTemplateBinding({ ...pinned,
      overrides: { template_parameters: { 'tpl-other': { size: 'y' } } } }, context(), portOf([base]).port, registry));
    expect(unselected.code).toBe('RESOLVE_PARAMETER_TEMPLATE_UNSELECTED');

    const malformed = await failure(resolveTemplateBinding({ ...pinned,
      overrides: { template_parameters: [] } }, context(), portOf([base]).port, registry));
    expect(malformed.code).toBe('RESOLVE_PARAMETERS_INVALID');

    const booleanBounds = templateVersion({
      template_id: 'tpl-spec', version: 2,
      items: [item({ template_id: 'tpl-spec', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
      parameters: parameters({ flag: { type: 'boolean', min: 0 } }, { flag: true }),
    });
    expect((await failure(resolveTemplateBinding(binding({ template_pins: [pin(booleanBounds)] }), context(),
      portOf([booleanBounds]).port, registry))).code).toBe('RESOLVE_PARAMETER_SPEC');

    const invalidDefault = templateVersion({
      template_id: 'tpl-spec', version: 3,
      items: [item({ template_id: 'tpl-spec', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
      parameters: parameters({ count: { type: 'integer', min: 1, max: 10 } }, { count: 99 }),
    });
    // The invalid default is rejected even though an override would otherwise supply the value.
    const defaultError = await failure(resolveTemplateBinding({
      ...binding({ template_pins: [pin(invalidDefault)] }),
      overrides: { template_parameters: { 'tpl-spec': { count: 5 } } },
    }, context(), portOf([invalidDefault]).port, registry));
    expect(defaultError.code).toBe('RESOLVE_PARAMETER_DEFAULT_INVALID');

    const missing = templateVersion({
      template_id: 'tpl-spec', version: 4,
      items: [item({ template_id: 'tpl-spec', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
      parameters: parameters({ required: { type: 'integer' } }, {}),
    });
    expect((await failure(resolveTemplateBinding(binding({ template_pins: [pin(missing)] }), context(),
      portOf([missing]).port, registry))).code).toBe('RESOLVE_PARAMETER_MISSING');
  });

  it('rejects conflicting release defaults and resolves them only through an explicit layer', async () => {
    const registry = fixtureRegistry();
    const one = templateVersion({ template_id: 'tpl-a', items: [
      item({ template_id: 'tpl-a', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })] });
    const two = templateVersion({ template_id: 'tpl-c', items: [
      item({ template_id: 'tpl-c', item_id: 'beta', metric: beta, release: refOf(releaseSlow) })] });
    const pinned = binding({ template_pins: [pin(one), pin(two)] });
    const port = portOf([one, two]).port;

    const conflict = await failure(resolveTemplateBinding(pinned, context({ capabilities: supported(alpha, beta) }), port, registry));
    expect(conflict.code).toBe('RESOLVE_SETTING_CONFLICT');
    expect(conflict.conflicts).toEqual([{ field: 'interval_ms', values: [
      { release: refObject(releaseA1), value: 60000 }, { release: refObject(releaseSlow), value: 90000 },
    ] }]);

    const resourceSet = resolution(await resolveTemplateBinding({
      ...pinned, overrides: { interval_ms: { mode: 'set', value: 30000 } },
    }, context({ capabilities: supported(alpha, beta) }), port, registry));
    expect(resourceSet.settings.interval_ms).toBe(30000);
    expect(resourceSet.sources.interval_ms).toEqual({ layer: 'resource', id: 'instance:7', revision: 4 });
    expect(resourceSet.executable).toBe(true);

    const grouped = resolution(await resolveTemplateBinding({ ...pinned, group_id: 'web' }, context({
      capabilities: supported(alpha, beta),
      group: { id: 'web', revision: 3, overrides: { interval_ms: { mode: 'set', value: 10000 } } },
    }), port, registry));
    expect(grouped.settings.interval_ms).toBe(10000);
    expect(grouped.sources.interval_ms).toEqual({ layer: 'group', id: 'web', revision: 3 });
    expect(grouped.group).toEqual({ id: 'web', revision: 3 });
  });

  it('rejects unknown metric toggles and invalid group overrides with stable codes', async () => {
    const registry = fixtureRegistry();
    const version = templateVersion({ template_id: 'tpl-toggle', items: [
      item({ template_id: 'tpl-toggle', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })] });
    const port = portOf([version]).port;
    const unknown = await failure(resolveTemplateBinding(binding({ template_pins: [pin(version)],
      overrides: { metrics: { 'fixture.absent@1.0.0': 'disable' } } }), context(), port, registry));
    expect(unknown.code).toBe('RESOLVE_OVERRIDE_INVALID');
    expect(unknown.rule).toBe('POLICY_UNKNOWN_METRIC');

    const groupParameters = await failure(resolveTemplateBinding(binding({ template_pins: [pin(version)], group_id: 'web' }),
      context({ group: { id: 'web', revision: 1, overrides: { template_parameters: { 'tpl-toggle': { x: 1 } } } } }), port, registry));
    expect(groupParameters.code).toBe('RESOLVE_OVERRIDE_INVALID');

    const invalidPlatform = await failure(resolveTemplateBinding(binding({ template_pins: [pin(version)],
      overrides: { stale_after_ms: { mode: 'set', value: 1000 } } }), context(), port, registry));
    expect(invalidPlatform.code).toBe('RESOLVE_SETTINGS_INVALID');
    expect(invalidPlatform.rule).toBe('POLICY_TIMING');
  });

  it('reports unsupported, unknown, future and expired capability without inventing support', async () => {
    const registry = fixtureRegistry();
    const version = templateVersion({ template_id: 'tpl-cap', items: [
      item({ template_id: 'tpl-cap', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })] });
    const pinned = binding({ template_pins: [pin(version)] });
    const port = portOf([version]).port;

    const absent = resolution(await resolveTemplateBinding(pinned, context(), port, registry));
    expect(absent.releases[0].collectors[0].items[0].decision).toBe('capability_unknown');
    expect(absent.releases[0].collectors[0].items[0].capability.basis).toEqual([
      { kind: 'method', evidence: 'capability_not_probed' }]);
    expect(absent.excluded[0]).toMatchObject({ reason: 'capability_unknown', blocking: true });
    expect(absent.executable).toBe(false);

    const unsupported = resolution(await resolveTemplateBinding(pinned,
      context({ capabilities: supported(alpha).map(entry => ({ ...entry, status: 'unsupported' as const })) }), port, registry));
    expect(unsupported.releases[0].collectors[0].items[0].decision).toBe('unsupported');
    expect(unsupported.excluded[0]).toMatchObject({ reason: 'capability_unsupported', blocking: true });

    const future = resolution(await resolveTemplateBinding(pinned, context({
      capabilities: supported(alpha).map(entry => ({ ...entry, status: 'unknown' as const,
        evaluated_at: '2026-09-20T00:00:00.000Z', valid_until: '2026-09-21T00:00:00.000Z' })),
    }), port, registry));
    expect(future.releases[0].collectors[0].items[0].decision).toBe('capability_unknown');
    expect(future.releases[0].collectors[0].items[0].capability.basis).toEqual([
      { kind: 'method', evidence: 'capability_expired_or_future' }]);

    const expired = resolution(await resolveTemplateBinding(pinned, context({
      capabilities: supported(alpha).map(entry => ({ ...entry, status: 'unknown' as const,
        evaluated_at: '2026-09-01T00:00:00.000Z', valid_until: '2026-09-02T00:00:00.000Z' })),
    }), port, registry));
    expect(expired.releases[0].collectors[0].items[0].capability.basis).toEqual([
      { kind: 'method', evidence: 'capability_expired_or_future' }]);

    const wrongEngine = resolution(await resolveTemplateBinding(pinned, context({
      resource: resource({ 'db.engine': { value: 'mysql', observed_at: at, source: 'fixture' } }),
      capabilities: supported(alpha),
    }), port, registry));
    expect(wrongEngine.releases[0].applicability[0].status).toBe('unsupported');
    expect(wrongEngine.releases[0].collectors[0].items[0].decision).toBe('unsupported');

    const unknownEngine = resolution(await resolveTemplateBinding(pinned, context({ resource: resource({}),
      capabilities: supported(alpha) }), port, registry));
    expect(unknownEngine.releases[0].applicability[0].status).toBe('unknown');
    expect(unknownEngine.releases[0].collectors[0].items[0].decision).toBe('capability_unknown');
  });

  it('preserves concrete dimensions and ordered mapping steps instead of generic discovery rows', async () => {
    const registry = fixtureRegistry();
    const version = templateVersion({ template_id: 'tpl-dims', items: [item({ template_id: 'tpl-dims', item_id: 'delta',
      metric: delta, release: refOf(releaseA1), dimensions: { mount: '/', device: 'sda1' } })] });

    const result = resolution(await resolveTemplateBinding(binding({ template_pins: [pin(version)] }),
      context({ capabilities: supported(delta) }), portOf([version]).port, registry));

    const itemResult = result.releases[0].collectors[0].items[0];
    expect(itemResult.dimensions).toEqual({ mount: '/', device: 'sda1' });
    expect(itemResult.mapping.steps).toEqual(['decode', 'normalize']);
    expect(itemResult.decision).toBe('collect');
  });

  it.each([
    ['resource identity', context({ resource: resource() }), { resource: { type: 'instance' as const, id: 8 } }, 'RESOLVE_RESOURCE_IDENTITY'],
    ['resource type', context({ resource: { type: 'server', id: '7', attributes: {} } }), {}, 'RESOLVE_RESOURCE_IDENTITY'],
  ])('rejects a %s mismatch', async (_, ctx, bindingOverride, code) => {
    const registry = fixtureRegistry();
    const version = templateVersion({ template_id: 'tpl-id', items: [
      item({ template_id: 'tpl-id', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })] });
    const error = await failure(resolveTemplateBinding(binding({ template_pins: [pin(version)], ...bindingOverride }),
      ctx, portOf([version]).port, registry));
    expect(error.code).toBe(code);
  });

  it('rejects a missing or mismatched trusted group and an invalid trusted input', async () => {
    const registry = fixtureRegistry();
    const version = templateVersion({ template_id: 'tpl-group', items: [
      item({ template_id: 'tpl-group', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })] });
    const pinned = binding({ template_pins: [pin(version)], group_id: 'web' });
    const port = portOf([version]).port;

    expect((await failure(resolveTemplateBinding(pinned, context(), port, registry))).code).toBe('RESOLVE_GROUP_IDENTITY');
    expect((await failure(resolveTemplateBinding(pinned,
      context({ group: { id: 'other', revision: 1, overrides: {} } }), port, registry))).code).toBe('RESOLVE_GROUP_IDENTITY');
    expect((await failure(resolveTemplateBinding(pinned,
      context({ group: { id: 'web', revision: 1 } }), port, registry))).code).toBe('RESOLVE_GROUP_INVALID');
    expect((await failure(resolveTemplateBinding(binding({ template_pins: [pin(version)] }),
      context({ group: { id: 'web', revision: 1, overrides: {} } }), port, registry))).code).toBe('RESOLVE_GROUP_IDENTITY');
    expect((await failure(resolveTemplateBinding(binding({ template_pins: [pin(version)] }),
      context({ at: 'not-a-time' }), port, registry))).code).toBe('RESOLVE_AT_INVALID');
    expect((await failure(resolveTemplateBinding(binding({ template_pins: [pin(version)] }),
      context({ capabilities: [{ metric: {} }] as never }), port, registry))).code).toBe('RESOLVE_CAPABILITY_INVALID');
    expect((await failure(resolveTemplateBinding(binding({ template_pins: [pin(version)] }),
      context({ resource: { type: 'instance' } }), port, registry))).code).toBe('RESOLVE_RESOURCE_INVALID');
  });

  it('delegates legacy bindings untouched without reading templates or the registry', async () => {
    const registry = fixtureRegistry();
    const get = vi.spyOn(registry, 'get');
    const { port, getVersion } = portOf([]);
    const legacyPackage = { id: 'legacy-package', version: '2.3.4', digest: `sha256:${'c'.repeat(64)}` };

    const result = await resolveTemplateBinding(binding({ package: legacyPackage }), context(), port, registry);

    expect(result.kind).toBe('legacy_delegate');
    if (result.kind !== 'legacy_delegate') throw new Error('unreachable');
    expect(result.binding.package).toEqual(legacyPackage);
    expect(result.package).toEqual(legacyPackage);
    expect(result.persisted).toBe(false);
    expect(result.applied).toBe(false);
    expect(getVersion).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it('preserves B1 rejections for an empty binding and a canonical overlap', async () => {
    const registry = fixtureRegistry(), port = portOf([]).port;
    const empty = binding();
    await expect(resolveTemplateBinding(empty, context(), port, registry)).rejects.toBeInstanceOf(BindingPreflightError);

    const first = templateVersion({ template_id: 'tpl-x', items: [
      item({ template_id: 'tpl-x', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })] });
    const second = templateVersion({ template_id: 'tpl-y', items: [
      item({ template_id: 'tpl-y', item_id: 'alpha-again', metric: alpha, release: refOf(releaseB) })] });
    await expect(resolveTemplateBinding(binding({ template_pins: [pin(first), pin(second)] }), context(),
      portOf([first, second]).port, registry)).rejects.toBeInstanceOf(BindingPreflightError);
  });

  it('gives the same identity for the same resolved input and changes it with every source', async () => {
    const registry = fixtureRegistry();
    const base = templateVersion({ template_id: 'tpl-id', items: [
      item({ template_id: 'tpl-id', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
      parameters: parameters({ batch: { type: 'integer', min: 1, max: 100 } }, { batch: 10 }) });
    const pinned = binding({ template_pins: [pin(base)] });
    const resolve = (input: ResourceBindingCandidate, ctx = context({ capabilities: supported(alpha) })) =>
      resolveTemplateBinding(input, ctx, portOf([base]).port, registry);

    const once = resolution(await resolve(pinned)), twice = resolution(await resolve(pinned));
    const identity = templateResolutionIdentity(once);
    expect(templateResolutionIdentity(twice)).toBe(identity);
    // `at` is not part of the identity when the resolved semantics are unchanged.
    const later = resolution(await resolve(pinned, context({ capabilities: supported(alpha),
      at: '2026-09-18T05:00:00.000Z' })));
    expect(templateResolutionIdentity(later)).toBe(identity);
    // A parameter override changes it.
    const overridden = resolution(await resolve({ ...pinned,
      overrides: { template_parameters: { 'tpl-id': { batch: 20 } } } }));
    expect(templateResolutionIdentity(overridden)).not.toBe(identity);
    // A resource settings override changes it.
    const resourced = resolution(await resolve({ ...pinned, overrides: { timeout_ms: { mode: 'set', value: 4000 } } }));
    expect(templateResolutionIdentity(resourced)).not.toBe(identity);
    // A capability inventory change changes it.
    const noCapability = resolution(await resolve(pinned, context()));
    expect(templateResolutionIdentity(noCapability)).not.toBe(identity);
    // A changed trigger reference changes it.
    const trigger = templateVersion({ template_id: 'tpl-id', version: 2, items: [
      item({ template_id: 'tpl-id', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
      parameters: parameters({ batch: { type: 'integer', min: 1, max: 100 } }, { batch: 10 }),
      triggers: [{ rule_id: 'rule-1', scope: 'item:alpha', version: 1 }] });
    const triggered = resolution(await resolveTemplateBinding(binding({ template_pins: [pin(trigger)] }),
      context({ capabilities: supported(alpha) }), portOf([trigger]).port, registry));
    expect(templateResolutionIdentity(triggered)).not.toBe(identity);
    // A different pinned content hash changes it.
    const other = templateVersion({ template_id: 'tpl-id', version: 3, items: [
      item({ template_id: 'tpl-id', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
      parameters: parameters({ batch: { type: 'integer', min: 1, max: 100 } }, { batch: 10 }) });
    const otherPin = resolution(await resolveTemplateBinding(binding({ template_pins: [pin(other)] }),
      context({ capabilities: supported(alpha) }), portOf([other]).port, registry));
    expect(templateResolutionIdentity(otherPin)).not.toBe(identity);
  });

  it('is deterministic and never mutates the input, trusted inputs or registry on failure', async () => {
    const registry = fixtureRegistry(), registryBefore = structuredClone(registry.list());
    const version = templateVersion({ template_id: 'tpl-stable', items: [
      item({ template_id: 'tpl-stable', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
      parameters: parameters({ count: { type: 'integer', min: 1, max: 10 } }, { count: 5 }) });
    const input = binding({ template_pins: [pin(version)] });
    const original = structuredClone(input);
    const ctx = context({ capabilities: supported(alpha) });
    const before = structuredClone(ctx);

    const once = await resolveTemplateBinding(input, ctx, portOf([version]).port, registry);
    const twice = await resolveTemplateBinding(input, ctx, portOf([version]).port, registry);
    expect(once).toEqual(twice);

    const bad = binding({ template_pins: [pin(version)], overrides: { template_parameters: { 'tpl-stable': { count: 99 } } } });
    const badOriginal = structuredClone(bad);
    await failure(resolveTemplateBinding(bad, ctx, portOf([version]).port, registry));

    expect(input).toEqual(original);
    expect(ctx).toEqual(before);
    expect(bad).toEqual(badOriginal);
    expect(registry.list()).toEqual(registryBefore);
  });
});
