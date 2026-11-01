import { describe, expect, it, vi } from 'vitest';
import type {
  CollectorDefinition, DerivedMetric, MetricDefinition,
} from '../../contracts/metrics/index.js';
import type {
  PackageCompositionEntry, ResourceBindingCandidate, SourceChain, TemplateItemVersion,
  TemplateParameters, TemplatePin, TemplateVersion, VersionNumber,
} from '../../contracts/metrics/templates.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from '../packages/model.js';
import { packageReleaseRef, templateContentHash, type MetricRef } from '../templates/model.js';
import { BindingCandidateError, compileBindingCandidate } from './compile.js';
import { BindingPreflightError, type TemplateVersionReadPort } from './preflight.js';

const T0 = '2026-10-01T00:00:00Z';
const T1 = '2026-10-02T00:00:00Z';

type ExtensionDefinition = Extract<MetricDefinition, { category: 'extension' }>;
type CollectorStep = CollectorDefinition['mappings'][number]['steps'];

interface KeySpec { name: string; allowed?: string[] }

const dims = (keys: KeySpec[] = []) => ({
  keys: keys.map(key => ({
    name: key.name,
    meaning: `${key.name} fixture dimension`,
    required: true,
    ...(key.allowed === undefined ? {} : { allowed_values: key.allowed }),
  })),
  max_series_per_resource: 100,
  max_value_length: 128,
  overflow: 'reject' as const,
});

function extension(id: string, unit: MetricDefinition['unit'], keys: KeySpec[] = []): ExtensionDefinition {
  return {
    category: 'extension', namespace: id.slice(0, id.indexOf('.')), id, semantic_version: '1.0.0',
    meaning: `${id} fixture metric`, resource_type: 'instance', unit, scope: 'resource', kind: 'gauge',
    roles: ['diagnostic'], temporality: 'instant', monotonic: false, value_type: 'float64',
    dimensions: dims(keys),
    aggregation: {
      time: ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null',
      min_coverage: 1, quantiles: 'not_applicable',
    },
    lifecycle: 'active',
  };
}

const alpha = extension('fixture.alpha', '1');
const beta = extension('fixture.beta', 'count');
const gamma = extension('fixture.gamma', 'By');
const delta = extension('fixture.delta', '%', [{ name: 'mount' }, { name: 'device', allowed: ['sda1', 'sdb1'] }]);
const epsilon = extension('fixture.epsilon', 'count');
const extensions: ExtensionDefinition[] = [alpha, beta, gamma, delta, epsilon];

const mainImpl: ImplementationSpec = {
  id: 'impl:fixture.main', method: 'sql', resource_type: 'instance',
  applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
  outputs: [
    { raw_field: 'alpha', definition: alpha, input_unit: '1' },
    { raw_field: 'beta', definition: beta, input_unit: 'count' },
    { raw_field: 'delta', definition: delta, input_unit: '%' },
  ],
  permissions: ['SHOW FIXTURE MAIN'],
  discovery: 'fixture main singleton status row',
};
const extraImpl: ImplementationSpec = {
  id: 'impl:fixture.extra', method: 'sql', resource_type: 'instance',
  applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
  outputs: [{ raw_field: 'gamma', definition: gamma, input_unit: 'By' }],
  permissions: ['SHOW FIXTURE EXTRA'],
  discovery: 'fixture extra bounded table',
};

const scaleEpsilon: DerivedMetric = {
  id: 'fixture-epsilon-scaled', output: { id: epsilon.id, semantic_version: epsilon.semantic_version },
  transform_version: '1.0.0', inputs: [{ id: beta.id, semantic_version: beta.semantic_version }],
  operation: 'scale', factor: 2, join: 'same_resource_and_dimensions', max_skew_ms: 1000,
  on_missing: 'null', on_zero_denominator: 'null',
  quality_propagation: 'worst_input', accuracy_propagation: 'least_certain_input',
};

interface MappingSpec { raw_field: string; metric: ExtensionDefinition }

function collector(id: string, implementation: ImplementationSpec, mappings: MappingSpec[]): CollectorDefinition {
  return {
    id, method: implementation.method, implementation_ref: implementation.id, timeout_ms: 5000,
    estimated_cost: 'low',
    mappings: mappings.map(entry => ({
      metric: { id: entry.metric.id, semantic_version: entry.metric.semantic_version },
      raw_field: entry.raw_field, input_unit: entry.metric.unit, output_unit: entry.metric.unit,
      transform_version: '1.0.0', steps: ['decode', 'normalize'] as CollectorStep,
    })),
  };
}

interface CollectorSpec { collector: CollectorDefinition; implementation: ImplementationSpec }

/** A real release, sealed and installed through the existing registry contract. */
function release(
  packageId: string,
  version: string,
  specs: CollectorSpec[],
  derived: DerivedMetric[] = [],
): PackageRelease {
  const transforms: PackageRelease['transforms'] = derived.length > 0
    ? [{ id: 'normalize', version: '1.0.0' }, { id: 'derive', version: '1.0.0' }]
    : [{ id: 'normalize', version: '1.0.0' }];
  return sealRelease({
    package: {
      id: packageId, version, contract_version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`,
      resource_type: 'instance', applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
      collectors: specs.map(spec => spec.collector),
    },
    extensions,
    derived,
    transforms,
    recommendations: {
      interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
      max_counter_gap_ms: 300000, max_rows: 100, enabled: true,
    },
    documentation: specs.map(spec => ({
      collector_id: spec.collector.id,
      permissions: spec.implementation.permissions,
      discovery: spec.implementation.discovery,
    })),
  });
}

const status = collector('status', mainImpl, [
  { raw_field: 'alpha', metric: alpha },
  { raw_field: 'beta', metric: beta },
  { raw_field: 'delta', metric: delta },
]);
const extra = collector('extra', extraImpl, [{ raw_field: 'gamma', metric: gamma }]);
const statusBetaOnly = collector('status', mainImpl, [{ raw_field: 'beta', metric: beta }]);

// fixture-a keeps two installed versions so an older fixed release can be pinned.
const releaseA1 = release('fixture-a', '1.0.0', [
  { collector: status, implementation: mainImpl }, { collector: extra, implementation: extraImpl },
], [scaleEpsilon]);
const releaseA2 = release('fixture-a', '2.0.0', [
  { collector: status, implementation: mainImpl },
]);
const releaseB = release('fixture-b', '1.0.0', [
  { collector: status, implementation: mainImpl }, { collector: extra, implementation: extraImpl },
], [scaleEpsilon]);
// Same collector id and implementation id as releaseA1 in a different release.
const releaseC = release('fixture-c', '1.0.0', [
  { collector: statusBetaOnly, implementation: mainImpl },
]);

function fixtureRegistry(): PackageRegistry {
  const registry = new PackageRegistry([], [mainImpl, extraImpl]);
  for (const entry of [releaseA1, releaseA2, releaseB, releaseC]) registry.install(entry);
  return registry;
}

const refOf = (entry: PackageRelease): string => packageReleaseRef(entry.package);
const metricRef = (definition: ExtensionDefinition): MetricRef => ({
  id: definition.id, semantic_version: definition.semantic_version,
});

const capabilities = () => ({
  discovery: { contract_version: '1.0.0', ref: null, executable: false as const },
  graphs: { contract_version: '1.0.0', ref: null, executable: false as const },
});

interface ItemSpec {
  template_id: string;
  item_id: string;
  metric: ExtensionDefinition;
  release: string;
  version?: VersionNumber;
  unit?: TemplateItemVersion['unit'];
  dimensions?: Record<string, string>;
  implementation_id?: string;
  params?: Record<string, number | string | boolean>;
}

function item(spec: ItemSpec): TemplateItemVersion {
  return {
    template_id: spec.template_id,
    item_id: spec.item_id,
    version: spec.version ?? 1,
    display_name: spec.item_id,
    canonical_metric: metricRef(spec.metric),
    unit: spec.unit ?? spec.metric.unit,
    dimensions: spec.dimensions ?? {},
    collector_ref: {
      package_release: spec.release,
      implementation_id: spec.implementation_id ?? mainImpl.id,
    },
    params_default: spec.params ?? {},
    source_chain: {
      actor_id: 1, request_id: `req-item-${spec.template_id}-${spec.item_id}`, base: null,
      created_at: T0, published_at: T1, retired_at: null, migration_ref: null,
    },
  };
}

interface VersionSpec {
  template_id: string;
  items: TemplateItemVersion[];
  version?: VersionNumber;
  parameters?: TemplateParameters;
  triggers?: TemplateVersion['aggregate']['triggers'];
  source_chain?: Partial<SourceChain>;
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
    template_id: spec.template_id,
    base: null,
    items: spec.items.map(stored => ({ item_id: stored.item_id, version: stored.version }))
      .sort((left, right) => left.item_id < right.item_id ? -1 : left.item_id > right.item_id ? 1 : 0),
    triggers: spec.triggers ?? [],
    parameters: spec.parameters ?? { schema: {}, defaults: {} },
    capabilities: capabilities(),
    package_composition: composition,
  };
  return {
    template_id: spec.template_id,
    version: spec.version ?? 1,
    status: 'published',
    content_hash: templateContentHash(aggregate),
    aggregate,
    items: spec.items,
    package_composition: composition,
    source_chain: {
      actor_id: 1, request_id: `req-${spec.template_id}`, base: null,
      created_at: T0, published_at: T1, retired_at: null, migration_ref: null,
      ...spec.source_chain,
    },
    published_at: T1,
    retired_at: null,
  };
}

const legacyPackage = { id: 'legacy-package', version: '2.3.4', digest: `sha256:${'c'.repeat(64)}` };

function binding(overrides: Partial<ResourceBindingCandidate> = {}): ResourceBindingCandidate {
  return {
    resource: { type: 'instance', id: 7 },
    package: null,
    group_id: 'web',
    overrides: { interval_ms: { mode: 'set', value: 30000 } },
    revision: 4,
    template_pins: [],
    ...overrides,
  };
}

function pin(version: TemplateVersion): TemplatePin {
  return {
    template_id: version.template_id, version: version.version, content_hash: version.content_hash,
  };
}

function portOf(versions: TemplateVersion[]) {
  const getVersion = vi.fn(async (templateId: string, version: VersionNumber) =>
    versions.find(entry => entry.template_id === templateId && entry.version === version) ?? null);
  return { port: { getVersion } satisfies TemplateVersionReadPort, getVersion };
}

async function failure(promise: Promise<unknown>): Promise<BindingCandidateError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BindingCandidateError);
    return error as BindingCandidateError;
  }
  throw new Error('expected the candidate compilation to reject');
}

const snapshot = (value: unknown): string => JSON.stringify(value);

describe('internal collector candidate compilation', () => {
  it('verifies real installed releases and keeps template, release and item provenance', async () => {
    const registry = fixtureRegistry();
    const registryBefore = structuredClone(registry.list());
    const first = templateVersion({
      template_id: 'tpl-one',
      items: [
        item({ template_id: 'tpl-one', item_id: 'same', metric: alpha, release: refOf(releaseA1) }),
        item({ template_id: 'tpl-one', item_id: 'beta-item', metric: beta, release: refOf(releaseA1) }),
      ],
      parameters: {
        schema: { interval_ms: { type: 'integer', min: 1000, max: 60000 } },
        defaults: { interval_ms: 30000 },
      },
      triggers: [{ rule_id: 'rule-1', scope: 'item:same', version: 1 }],
    });
    const second = templateVersion({
      template_id: 'tpl-two',
      items: [item({ template_id: 'tpl-two', item_id: 'same', metric: gamma, release: refOf(releaseB), implementation_id: extraImpl.id })],
    });
    const input = binding({ template_pins: [pin(first), pin(second)] });
    const original = structuredClone(input);

    const outcome = await compileBindingCandidate(input, portOf([first, second]).port, registry);

    expect(outcome.kind).toBe('template_candidate');
    if (outcome.kind !== 'template_candidate') throw new Error('unreachable');
    expect(outcome.compiled).toBe(false);
    expect(outcome.binding).toEqual(input);
    expect(outcome.pins.map(entry => entry.pin)).toEqual([pin(first), pin(second)]);
    expect(outcome.pins[0].unresolved.parameters).toEqual(first.aggregate.parameters);
    expect(outcome.pins[0].unresolved.trigger_refs).toEqual(first.aggregate.triggers);
    expect(outcome.pins[0].unresolved.source_chain).toEqual(first.source_chain);

    const groups = outcome.collectors;
    expect(groups).toHaveLength(2);
    const statusGroup = groups.find(entry => entry.collector_id === 'status')!;
    expect(statusGroup.release_ref).toBe(refOf(releaseA1));
    expect(statusGroup.implementation_id).toBe(mainImpl.id);
    expect(statusGroup.method).toBe('sql');
    expect(statusGroup.items.map(entry => `${entry.template_id}/${entry.item_id}`))
      .toEqual(['tpl-one/beta-item', 'tpl-one/same']);
    expect(statusGroup.mappings.map(entry => entry.raw_field)).toEqual(['alpha', 'beta']);
    expect(statusGroup.items[1].mapping.raw_field).toBe('alpha');
    expect(statusGroup.items.every(entry => entry.pin.template_id === 'tpl-one')).toBe(true);
    expect(statusGroup.items.every(entry => entry.release.version === '1.0.0')).toBe(true);

    const extraGroup = groups.find(entry => entry.collector_id === 'extra')!;
    expect(extraGroup.release_ref).toBe(refOf(releaseB));
    expect(extraGroup.implementation_id).toBe(extraImpl.id);
    expect(extraGroup.items.map(entry => `${entry.template_id}/${entry.item_id}`)).toEqual(['tpl-two/same']);
    expect(extraGroup.mappings.map(entry => entry.raw_field)).toEqual(['gamma']);
    // The unselected "status" collector of releaseB never enters the candidate.
    expect(groups.some(entry => entry.release_ref === refOf(releaseB) && entry.collector_id === 'status')).toBe(false);
    // releaseA2 is installed but not pinned by any template.
    expect(groups.some(entry => entry.release_ref === refOf(releaseA2))).toBe(false);
    expect(input).toEqual(original);
    expect(registry.list()).toEqual(registryBefore);
  });

  it('keeps the same collector and implementation id in two releases isolated', async () => {
    const registry = fixtureRegistry();
    const first = templateVersion({
      template_id: 'tpl-a',
      items: [item({ template_id: 'tpl-a', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
    });
    const second = templateVersion({
      template_id: 'tpl-c',
      items: [item({ template_id: 'tpl-c', item_id: 'beta', metric: beta, release: refOf(releaseC) })],
    });

    const outcome = await compileBindingCandidate(
      binding({ template_pins: [pin(first), pin(second)] }), portOf([first, second]).port, registry,
    );

    if (outcome.kind !== 'template_candidate') throw new Error('expected a template candidate');
    const byRelease = new Map(outcome.collectors.map(entry => [entry.release_ref, entry]));
    expect(outcome.collectors).toHaveLength(2);
    const releaseAGroup = byRelease.get(refOf(releaseA1))!;
    const releaseCGroup = byRelease.get(refOf(releaseC))!;
    expect(releaseAGroup.collector_id).toBe('status');
    expect(releaseCGroup.collector_id).toBe('status');
    expect(releaseAGroup.implementation_id).toBe(releaseCGroup.implementation_id);
    expect(releaseAGroup.items.map(entry => entry.item_id)).toEqual(['alpha']);
    expect(releaseCGroup.items.map(entry => entry.item_id)).toEqual(['beta']);
    expect(releaseAGroup.mappings.map(entry => entry.raw_field)).toEqual(['alpha']);
    expect(releaseCGroup.mappings.map(entry => entry.raw_field)).toEqual(['beta']);
  });

  it('reads the fixed older release even when a newer version is installed', async () => {
    const registry = fixtureRegistry();
    const older = templateVersion({
      template_id: 'tpl-old', version: 1,
      items: [item({ template_id: 'tpl-old', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
    });
    const newer = templateVersion({
      template_id: 'tpl-old', version: 2,
      items: [item({ template_id: 'tpl-old', item_id: 'alpha', metric: alpha, release: refOf(releaseA2) })],
    });
    const { port, getVersion } = portOf([older, newer]);

    const outcome = await compileBindingCandidate(binding({ template_pins: [pin(older)] }), port, registry);

    if (outcome.kind !== 'template_candidate') throw new Error('expected a template candidate');
    expect(getVersion).toHaveBeenCalledTimes(1);
    expect(getVersion).toHaveBeenCalledWith('tpl-old', 1);
    expect(outcome.collectors).toHaveLength(1);
    expect(outcome.collectors[0].release_ref).toBe(refOf(releaseA1));
    expect(outcome.collectors[0].release.version).toBe('1.0.0');
    expect(outcome.collectors[0].items[0].item_version).toBe(1);
  });

  it('only includes selected collectors and their selected mappings', async () => {
    const registry = fixtureRegistry();
    const version = templateVersion({
      template_id: 'tpl-only',
      items: [item({ template_id: 'tpl-only', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
    });

    const outcome = await compileBindingCandidate(binding({ template_pins: [pin(version)] }), portOf([version]).port, registry);

    if (outcome.kind !== 'template_candidate') throw new Error('expected a template candidate');
    expect(outcome.collectors).toHaveLength(1);
    expect(outcome.collectors[0].collector_id).toBe('status');
    expect(outcome.collectors[0].mappings.map(entry => entry.raw_field)).toEqual(['alpha']);
    expect(snapshot(outcome).includes('extra')).toBe(false);
    expect(snapshot(outcome).includes('gamma')).toBe(false);
  });

  it('preserves B1 canonical conflicts before touching the registry', async () => {
    const registry = fixtureRegistry();
    const get = vi.spyOn(registry, 'get');
    const first = templateVersion({
      template_id: 'tpl-x',
      items: [item({ template_id: 'tpl-x', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
    });
    const second = templateVersion({
      template_id: 'tpl-y',
      items: [item({ template_id: 'tpl-y', item_id: 'alpha-again', metric: alpha, release: refOf(releaseB) })],
    });

    await expect(compileBindingCandidate(
      binding({ template_pins: [pin(first), pin(second)] }), portOf([first, second]).port, registry,
    )).rejects.toBeInstanceOf(BindingPreflightError);
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it('passes the legacy branch through without a template read or registry access', async () => {
    const registry = fixtureRegistry();
    const get = vi.spyOn(registry, 'get');
    const { port, getVersion } = portOf([]);

    const outcome = await compileBindingCandidate(
      binding({ template_pins: [], package: legacyPackage }), port, registry,
    );

    expect(outcome.kind).toBe('legacy');
    if (outcome.kind !== 'legacy') throw new Error('expected the legacy branch');
    expect(outcome.compiled).toBe(false);
    expect(outcome.package).toEqual(legacyPackage);
    expect(getVersion).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it('rejects a metadata-only pin instead of calling it executable', async () => {
    const registry = fixtureRegistry();
    const empty = templateVersion({ template_id: 'tpl-empty', items: [] });

    const error = await failure(compileBindingCandidate(
      binding({ template_pins: [pin(empty)] }), portOf([empty]).port, registry,
    ));

    expect(error.code).toBe('CANDIDATE_TEMPLATE_NOT_EXECUTABLE');
    expect(error.location).toEqual({ pin: pin(empty), item: null, release: null });
  });

  it('rejects a missing release and a wrong digest with a stable locator only', async () => {
    const registry = fixtureRegistry();
    const missing = `fixture-missing@1.0.0#sha256:${'0'.repeat(64)}`;
    const wrongDigest = `fixture-a@1.0.0#sha256:${'f'.repeat(64)}`;
    for (const releaseRef of [missing, wrongDigest]) {
      const version = templateVersion({
        template_id: 'tpl-release',
        items: [item({ template_id: 'tpl-release', item_id: 'alpha', metric: alpha, release: releaseRef })],
      });

      const error = await failure(compileBindingCandidate(
        binding({ template_pins: [pin(version)] }), portOf([version]).port, registry,
      ));

      expect(error.code).toBe('CANDIDATE_RELEASE_UNAVAILABLE');
      expect(error.location.release).toEqual({
        id: releaseRef.slice(0, releaseRef.lastIndexOf('@')),
        version: '1.0.0',
        digest: releaseRef.slice(releaseRef.indexOf('#') + 1),
      });
      expect(error.location.item).toEqual({ item_id: 'alpha', version: 1 });
      expect(error.message).toBe('CANDIDATE_RELEASE_UNAVAILABLE');
      expect(error.message).not.toContain('PACKAGE_PIN');
    }
  });

  it('rejects an implementation the exact release does not register', async () => {
    const registry = fixtureRegistry();
    const version = templateVersion({
      template_id: 'tpl-impl',
      items: [item({
        template_id: 'tpl-impl', item_id: 'alpha', metric: alpha, release: refOf(releaseA1),
        implementation_id: 'impl:fixture.absent',
      })],
    });

    const error = await failure(compileBindingCandidate(binding({ template_pins: [pin(version)] }), portOf([version]).port, registry));

    expect(error.code).toBe('CANDIDATE_IMPLEMENTATION_UNAVAILABLE');
    expect(error.location.release?.id).toBe('fixture-a');
  });

  it('rejects an implementation that exists but does not provide the metric', async () => {
    const registry = fixtureRegistry();
    const version = templateVersion({
      template_id: 'tpl-metric',
      items: [item({
        template_id: 'tpl-metric', item_id: 'alpha', metric: alpha, release: refOf(releaseA1),
        // The "status" collector of the same release provides alpha, but it belongs to another implementation.
        implementation_id: extraImpl.id,
      })],
    });

    const error = await failure(compileBindingCandidate(binding({ template_pins: [pin(version)] }), portOf([version]).port, registry));

    expect(error.code).toBe('CANDIDATE_METRIC_UNAVAILABLE');
  });

  it('rejects a derived-only metric the template shape cannot express', async () => {
    const registry = fixtureRegistry();
    const version = templateVersion({
      template_id: 'tpl-derived',
      items: [item({ template_id: 'tpl-derived', item_id: 'epsilon', metric: epsilon, release: refOf(releaseA1) })],
    });

    const error = await failure(compileBindingCandidate(binding({ template_pins: [pin(version)] }), portOf([version]).port, registry));

    expect(error.code).toBe('CANDIDATE_DERIVED_UNREPRESENTABLE');
  });

  it('rejects a unit that differs from the canonical definition', async () => {
    const registry = fixtureRegistry();
    const version = templateVersion({
      template_id: 'tpl-unit',
      items: [item({
        template_id: 'tpl-unit', item_id: 'delta', metric: delta, release: refOf(releaseA1),
        unit: 'ms', dimensions: { mount: '/', device: 'sda1' },
      })],
    });

    const error = await failure(compileBindingCandidate(binding({ template_pins: [pin(version)] }), portOf([version]).port, registry));

    expect(error.code).toBe('CANDIDATE_UNIT_MISMATCH');
  });

  it('rejects dimensions that do not satisfy the canonical definition', async () => {
    const registry = fixtureRegistry();
    const cases: Array<Record<string, string>> = [
      {},
      { mount: '/', device: 'sdb9' },
      { mount: '/', device: 'sda1', unexpected: 'x' },
    ];
    for (const dimensions of cases) {
      const version = templateVersion({
        template_id: 'tpl-dims',
        items: [item({ template_id: 'tpl-dims', item_id: 'delta', metric: delta, release: refOf(releaseA1), dimensions })],
      });

      const error = await failure(compileBindingCandidate(binding({ template_pins: [pin(version)] }), portOf([version]).port, registry));

      expect(error.code).toBe('CANDIDATE_DIMENSION_INVALID');
    }
  });

  it('never reads params_default as runtime configuration', async () => {
    const registry = fixtureRegistry();
    const version = templateVersion({
      template_id: 'tpl-params',
      items: [item({
        template_id: 'tpl-params', item_id: 'alpha', metric: alpha, release: refOf(releaseA1),
        params: { secret_sql: 'DROP TABLE fixture', interval_ms: 15000 },
      })],
    });

    const outcome = await compileBindingCandidate(binding({ template_pins: [pin(version)] }), portOf([version]).port, registry);

    if (outcome.kind !== 'template_candidate') throw new Error('expected a template candidate');
    expect(snapshot(outcome)).not.toContain('DROP TABLE');
    expect(snapshot(outcome)).not.toContain('secret_sql');
    expect(outcome.collectors[0].mappings[0]).toEqual({
      metric: metricRef(alpha), raw_field: 'alpha', input_unit: '1', output_unit: '1',
      transform_version: '1.0.0', steps: ['decode', 'normalize'],
    });
  });

  it('is deterministic and leaves the input and registry untouched on failure', async () => {
    const registry = fixtureRegistry();
    const registryBefore = structuredClone(registry.list());
    const good = templateVersion({
      template_id: 'tpl-stable',
      items: [item({ template_id: 'tpl-stable', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
    });
    const input = binding({ template_pins: [pin(good)] });
    const original = structuredClone(input);

    const once = await compileBindingCandidate(input, portOf([good]).port, registry);
    const twice = await compileBindingCandidate(input, portOf([good]).port, registry);
    expect(once).toEqual(twice);

    const bad = templateVersion({
      template_id: 'tpl-bad',
      items: [item({
        template_id: 'tpl-bad', item_id: 'alpha', metric: alpha, release: refOf(releaseA1),
        implementation_id: extraImpl.id,
      })],
    });
    const badInput = binding({ template_pins: [pin(bad)] });
    const badOriginal = structuredClone(badInput);
    await failure(compileBindingCandidate(badInput, portOf([bad]).port, registry));

    expect(input).toEqual(original);
    expect(badInput).toEqual(badOriginal);
    expect(registry.list()).toEqual(registryBefore);
  });

  it('does not leak a registry exception message', async () => {
    const version = templateVersion({
      template_id: 'tpl-leak',
      items: [item({ template_id: 'tpl-leak', item_id: 'alpha', metric: alpha, release: refOf(releaseA1) })],
    });
    const noisy = {
      get: () => { throw new Error('password=secret db down'); },
      catalog: () => { throw new Error('password=secret db down'); },
    } as unknown as PackageRegistry;

    const error = await failure(compileBindingCandidate(binding({ template_pins: [pin(version)] }), portOf([version]).port, noisy));

    expect(error.code).toBe('CANDIDATE_RELEASE_UNAVAILABLE');
    expect(error.message).toBe('CANDIDATE_RELEASE_UNAVAILABLE');
    expect(error.message).not.toContain('password');
  });
});
