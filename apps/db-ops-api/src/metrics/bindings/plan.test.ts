import { describe, expect, it, vi } from 'vitest';
import type { Capability, CollectorDefinition, MetricDefinition, Resource } from '../../contracts/metrics/index.js';
import type {
  PackageCompositionEntry, ResourceBindingCandidate, TemplateItemVersion, TemplateParameters,
  TemplatePin, TemplateVersion, VersionNumber,
} from '../../contracts/metrics/templates.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from '../packages/model.js';
import { packageReleaseRef, templateContentHash, type MetricRef } from '../templates/model.js';
import type { TemplateVersionReadPort } from './preflight.js';
import {
  buildTemplateCollectionPlan, TemplatePlanError, type TemplateCollectionPlan,
} from './plan.js';
import {
  resolveTemplateBinding, templateResolutionIdentity, type ResolvedTemplateBinding, type TemplateResolutionContext,
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

function collector(id: string, implementation: ImplementationSpec, mappings: { raw_field: string; metric: ExtensionDefinition }[]): CollectorDefinition {
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

function release(packageId: string): PackageRelease {
  return sealRelease({
    package: {
      id: packageId, version: '1.0.0', contract_version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`,
      resource_type: 'instance', applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
      collectors: [status, extra],
    },
    extensions, derived: [], transforms: [{ id: 'normalize', version: '1.0.0' }],
    recommendations: { interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000, max_counter_gap_ms: 300000,
      max_rows: 100, enabled: true },
    documentation: [
      { collector_id: 'status', permissions: mainImpl.permissions, discovery: mainImpl.discovery },
      { collector_id: 'extra', permissions: extraImpl.permissions, discovery: extraImpl.discovery },
    ],
  });
}

const releaseA = release('fixture-a');
const releaseB = release('fixture-b');

function fixtureRegistry(): PackageRegistry {
  const registry = new PackageRegistry([], [mainImpl, extraImpl]);
  for (const entry of [releaseA, releaseB]) registry.install(entry);
  return registry;
}

const refOf = (entry: PackageRelease): string => packageReleaseRef(entry.package);
const metricRef = (definition: ExtensionDefinition): MetricRef => ({
  id: definition.id, semantic_version: definition.semantic_version,
});

function item(templateId: string, itemId: string, metric: ExtensionDefinition, entry: PackageRelease,
  overrides: { dimensions?: Record<string, string>; implementationId?: string } = {}): TemplateItemVersion {
  return {
    template_id: templateId, item_id: itemId, version: 1, display_name: itemId,
    canonical_metric: metricRef(metric), unit: metric.unit, dimensions: overrides.dimensions ?? {},
    collector_ref: { package_release: refOf(entry), implementation_id: overrides.implementationId ?? mainImpl.id },
    params_default: {},
    source_chain: { actor_id: 1, request_id: `req-${templateId}-${itemId}`, base: null, created_at: T0,
      published_at: T1, retired_at: null, migration_ref: null },
  };
}

function templateVersion(templateId: string, items: TemplateItemVersion[], parameters?: TemplateParameters): TemplateVersion {
  const byRelease = new Map<string, string[]>();
  for (const stored of items) {
    const ids = byRelease.get(stored.collector_ref.package_release) ?? [];
    ids.push(stored.item_id);
    byRelease.set(stored.collector_ref.package_release, ids);
  }
  const composition: PackageCompositionEntry[] = [...byRelease.entries()].sort(([left], [right]) => left < right ? -1 : 1)
    .map(([entryRelease, ids]) => ({ release: entryRelease, items: [...ids].sort() }));
  const aggregate = {
    template_id: templateId, base: null,
    items: items.map(stored => ({ item_id: stored.item_id, version: stored.version }))
      .sort((left, right) => left.item_id < right.item_id ? -1 : 1),
    triggers: [],
    parameters: parameters ?? { schema: {}, defaults: {} },
    capabilities: {
      discovery: { contract_version: '1.0.0', ref: null, executable: false as const },
      graphs: { contract_version: '1.0.0', ref: null, executable: false as const },
    },
    package_composition: composition,
  };
  return {
    template_id: templateId, version: 1, status: 'published', content_hash: templateContentHash(aggregate),
    aggregate, items, package_composition: composition,
    source_chain: { actor_id: 1, request_id: `req-${templateId}`, base: null, created_at: T0, published_at: T1,
      retired_at: null, migration_ref: null },
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
  return { resource: { type: 'instance', id: 7 }, package: null, group_id: null, overrides: {}, revision: 4,
    template_pins: [], ...overrides };
}

function resource(): Resource {
  return { type: 'instance', id: '7', attributes: { 'db.engine': { value: 'fixture', observed_at: at, source: 'fixture' } } };
}

function capability(metric: ExtensionDefinition, overrides: Partial<Capability> = {}): Capability {
  return { resource_id: '7', metric: metricRef(metric), method: 'sql', status: 'supported',
    basis: [{ kind: 'permission', evidence: 'fixed_read_succeeded' }], evaluated_at: at,
    valid_until: '2026-09-19T00:00:00.000Z', ...overrides };
}

function context(capabilities: Capability[] = [alpha, beta, gamma].map(metric => capability(metric)),
  overrides: Partial<TemplateResolutionContext> = {}): TemplateResolutionContext {
  return { resource: resource(), group: null, capabilities, at, ...overrides };
}

async function resolve(versions: TemplateVersion[], input: ResourceBindingCandidate,
  ctx: TemplateResolutionContext = context()): Promise<ResolvedTemplateBinding> {
  const outcome = await resolveTemplateBinding(input, ctx, portOf(versions).port, fixtureRegistry());
  if (outcome.kind !== 'template_resolution') throw new Error('expected a multi-template resolution');
  return outcome;
}

const twoTemplates = () => {
  const one = templateVersion('tpl-one', [item('tpl-one', 'alpha', alpha, releaseA)]);
  const two = templateVersion('tpl-two', [item('tpl-two', 'gamma', gamma, releaseB, { implementationId: extraImpl.id })]);
  return { one, two, input: binding({ template_pins: [pin(one), pin(two)] }) };
};

function planOf(resolution: ResolvedTemplateBinding): TemplateCollectionPlan {
  return buildTemplateCollectionPlan(resolution);
}

describe('internal multi-template release plans', () => {
  it('builds isolated selected-only release plans with the exact resolution identity', async () => {
    const { one, two, input } = twoTemplates();
    const resolution = await resolve([one, two], input);
    const plan = planOf(resolution);

    expect(plan.kind).toBe('template_collection_plan');
    expect(plan.internal).toBe(true);
    expect(plan.persisted).toBe(false);
    expect(plan.applied).toBe(false);
    expect(plan.executable).toBe(true);
    expect(plan.identity).toBe(templateResolutionIdentity(resolution));
    expect(plan.resource).toEqual({ type: 'instance', id: '7' });
    expect(plan.revision).toBe(4);
    // Parameters and unresolved trigger references travel with the plan.
    expect(plan.parameters).toEqual(resolution.templates);
    expect(plan.triggers).toEqual(resolution.triggers);

    expect(plan.releases.map(entry => entry.release_ref)).toEqual([refOf(releaseA), refOf(releaseB)]);
    expect(plan.releases[0].steps.map(step => step.collector_id)).toEqual(['status']);
    expect(plan.releases[1].steps.map(step => step.collector_id)).toEqual(['extra']);
    expect(plan.releases[0].metric_keys).toEqual(['fixture.alpha@1.0.0']);
    expect(plan.releases[1].metric_keys).toEqual(['fixture.gamma@1.0.0']);
    // Unselected mappings, the unpinned newer metrics and every foreign release stay out.
    const snapshot = JSON.stringify(plan);
    expect(snapshot.includes('fixture.beta')).toBe(false);
    expect(snapshot.includes('fixture.delta')).toBe(false);
    expect(plan.releases[0].steps[0].items.map(entry => entry.item_id)).toEqual(['alpha']);
    expect(plan.releases[1].steps[0].items.map(entry => entry.item_id)).toEqual(['gamma']);
    // One logical read per release every 60s.
    expect(plan.releases[0].requests_per_hour_estimate).toBe(60);
    expect(plan.releases[1].requests_per_hour_estimate).toBe(60);
    expect(plan.budget).toMatchObject({ estimate: true, request_unit: 'logical_reads',
      requests_per_hour_estimate: 120, estimated_series_upper_bound: 2 });
  });

  it('keeps two releases and identical collector ids apart instead of merging them', async () => {
    const one = templateVersion('tpl-a', [item('tpl-a', 'alpha', alpha, releaseA)]);
    const two = templateVersion('tpl-b', [item('tpl-b', 'beta', beta, releaseB)]);
    const plan = planOf(await resolve([one, two], binding({ template_pins: [pin(one), pin(two)] })));

    expect(plan.releases).toHaveLength(2);
    expect(plan.releases[0].steps[0].release_ref).toBe(refOf(releaseA));
    expect(plan.releases[1].steps[0].release_ref).toBe(refOf(releaseB));
    expect(plan.releases[0].steps[0].items[0].canonical_metric).toEqual(metricRef(alpha));
    expect(plan.releases[1].steps[0].items[0].canonical_metric).toEqual(metricRef(beta));
    expect(plan.budget.requests_per_hour_estimate).toBe(120);
  });

  it('never plans unsupported or unknown items and reports them as blocking', async () => {
    const one = templateVersion('tpl-one', [item('tpl-one', 'alpha', alpha, releaseA)]);
    const two = templateVersion('tpl-two', [item('tpl-two', 'gamma', gamma, releaseB, { implementationId: extraImpl.id })]);

    const unsupported = planOf(await resolve([one, two], binding({ template_pins: [pin(one), pin(two)] }),
      context([capability(alpha), capability(gamma, { status: 'unsupported' })])));
    expect(unsupported.executable).toBe(false);
    expect(unsupported.releases[1].steps).toEqual([]);
    expect(unsupported.releases[1].queries).toEqual([]);
    expect(unsupported.excluded.map(entry => entry.reason)).toContain('capability_unsupported');
    expect(unsupported.excluded.find(entry => entry.reason === 'capability_unsupported')?.blocking).toBe(true);

    const unknown = planOf(await resolve([one, two], binding({ template_pins: [pin(one), pin(two)] }), context([])));
    expect(unknown.executable).toBe(false);
    expect(unknown.releases.every(entry => entry.steps.length === 0)).toBe(true);
    expect(unknown.budget.requests_per_hour_estimate).toBe(0);
    expect(unknown.excluded.every(entry => entry.blocking)).toBe(true);
  });

  it('excludes disabled metrics and a disabled collection without inflating budget or queries', async () => {
    const one = templateVersion('tpl-1', [item('tpl-1', 'alpha', alpha, releaseA), item('tpl-1', 'beta', beta, releaseA)]);
    const disabledMetric = planOf(await resolve([one], binding({ template_pins: [pin(one)],
      overrides: { metrics: { 'fixture.beta@1.0.0': 'disable' } } })));
    expect(disabledMetric.releases[0].metric_keys).toEqual(['fixture.alpha@1.0.0']);
    expect(disabledMetric.releases[0].steps[0].items.map(entry => entry.item_id)).toEqual(['alpha']);
    expect(disabledMetric.excluded).toContainEqual(expect.objectContaining({ item_id: 'beta', reason: 'metric_disabled', blocking: false }));
    expect(disabledMetric.budget.estimated_series_upper_bound).toBe(1);

    const off = planOf(await resolve([one], binding({ template_pins: [pin(one)], overrides: { enabled: 'disable' } })));
    expect(off.executable).toBe(false);
    expect(off.releases[0].steps).toEqual([]);
    expect(off.releases[0].queries).toEqual([]);
    expect(off.budget).toMatchObject({ estimated_series_upper_bound: 0, requests_per_hour_estimate: 0 });
    expect(off.excluded.every(entry => entry.reason === 'settings_disabled' && !entry.blocking)).toBe(true);
  });

  it('shares one query only with identical resolved parameters', async () => {
    const parameters: TemplateParameters = {
      schema: { batch: { type: 'integer', min: 1, max: 100 } }, defaults: { batch: 10 },
    };
    const first = templateVersion('tpl-p1', [item('tpl-p1', 'alpha', alpha, releaseA)], parameters);
    const second = templateVersion('tpl-p2', [item('tpl-p2', 'beta', beta, releaseA)], parameters);
    const pinned = binding({ template_pins: [pin(first), pin(second)] });

    const differing = planOf(await resolve([first, second], { ...pinned,
      overrides: { template_parameters: { 'tpl-p2': { batch: 20 } } } }));
    expect(differing.releases).toHaveLength(1);
    expect(differing.releases[0].steps).toHaveLength(2);
    expect(differing.releases[0].queries).toHaveLength(2);
    expect(differing.releases[0].steps.every(step => step.parameter_signature.startsWith('sha256:'))).toBe(true);
    expect(differing.releases[0].requests_per_hour_estimate).toBe(120);

    const shared = planOf(await resolve([first, second], pinned));
    expect(shared.releases[0].steps).toHaveLength(1);
    expect(shared.releases[0].steps[0].items.map(entry => entry.item_id)).toEqual(['alpha', 'beta']);
    expect(shared.releases[0].queries).toHaveLength(1);
    expect(shared.releases[0].requests_per_hour_estimate).toBe(60);
    expect(shared.budget.estimated_series_upper_bound).toBe(2);
  });

  it('preserves concrete dimensions, ordered mapping steps and per-release jitter', async () => {
    const one = templateVersion('tpl-dims', [item('tpl-dims', 'delta', delta, releaseA,
      { dimensions: { mount: '/', device: 'sda1' } })]);
    const plan = planOf(await resolve([one], binding({ template_pins: [pin(one)] }),
      context([capability(delta)])));

    const planned = plan.releases[0].steps[0].items[0];
    expect(planned.dimensions).toEqual({ mount: '/', device: 'sda1' });
    expect(planned.mapping.steps).toEqual(['decode', 'normalize']);
    expect(planned.pin.content_hash).toMatch(/^sha256:/);
    expect(plan.releases[0].jitter_ms).toBeGreaterThanOrEqual(0);
    expect(plan.releases[0].jitter_ms).toBeLessThan(10000);
    const again = planOf(await resolve([one], binding({ template_pins: [pin(one)] }), context([capability(delta)])));
    expect(again.releases[0].jitter_ms).toBe(plan.releases[0].jitter_ms);
    expect(plan.releases[0].applicability[0].status).toBe('supported');
  });

  it('returns an isolated copy and never mutates the resolution', async () => {
    const { one, two, input } = twoTemplates();
    const resolution = await resolve([one, two], input);
    const before = structuredClone(resolution);
    const fresh = planOf(resolution);
    const plan = planOf(resolution);

    plan.settings.interval_ms = 1;
    plan.releases[0].steps[0].items[0].mapping.steps.push('rate');
    plan.releases[0].applicability[0].value = 'changed';
    expect(resolution).toEqual(before);
    expect(planOf(resolution)).toEqual(fresh);
    expect(plan.settings.interval_ms).toBe(1);
  });

  it('rejects a legacy delegate instead of coercing it into a multi-template plan', async () => {
    const legacy = await resolveTemplateBinding(binding({ package: { id: 'legacy', version: '1.0.0',
      digest: `sha256:${'c'.repeat(64)}` } }), context(), portOf([]).port, fixtureRegistry());
    expect(legacy.kind).toBe('legacy_delegate');
    expect(() => buildTemplateCollectionPlan(legacy as unknown as ResolvedTemplateBinding))
      .toThrow(TemplatePlanError);
    expect(() => buildTemplateCollectionPlan(null as unknown as ResolvedTemplateBinding))
      .toThrow(TemplatePlanError);
  });

  it('rejects a selected set larger than the effective series budget', async () => {
    const one = templateVersion('tpl-budget', [item('tpl-budget', 'alpha', alpha, releaseA),
      item('tpl-budget', 'beta', beta, releaseA)]);
    const resolution = await resolve([one], binding({ template_pins: [pin(one)],
      overrides: { max_series_per_resource: { mode: 'set', value: 1 } } }));
    expect(() => buildTemplateCollectionPlan(resolution)).toThrow(TemplatePlanError);
    try {
      buildTemplateCollectionPlan(resolution);
    } catch (error) {
      expect((error as TemplatePlanError).code).toBe('PLAN_SERIES_BUDGET');
    }
  });
});
