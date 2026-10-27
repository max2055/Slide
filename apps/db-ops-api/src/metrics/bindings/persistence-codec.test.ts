import { describe, expect, it } from 'vitest';
import type { CollectorDefinition, MetricDefinition } from '../../contracts/metrics/index.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from '../packages/model.js';
import { resolvePolicy } from '../policy/resolver.js';
import {
  BINDING_PAYLOAD_ENVELOPE, BINDING_PAYLOAD_PACKAGE_ENVELOPE, BindingPersistenceError,
  bindingPayloadSource, decodeBindingPayload, encodeBindingPayload, encodeTemplatePendingPayload,
  type BindingPersistenceErrorCode,
} from './persistence-codec.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const IDENTITY = `sha256:${'b'.repeat(64)}`;
const T1 = '2026-10-02T00:00:00Z';
const NOW = '2026-10-03T00:00:00Z';
const AT = '2026-09-18T00:00:00.000Z';
const RESOURCE = { type: 'instance' as const, id: 7 };
const PIN = { template_id: 'tpl-one', version: 1, content_hash: HASH };

// --- a real published package, so a legacy `Resolved` is the actual value -----
//
// F1: the previous effective snapshot is only evidence when it is what the
// accepted resolver writes, so the fixture builds that value with `resolvePolicy`
// instead of hand-writing a thinner look-alike.

type ExtensionDefinition = Extract<MetricDefinition, { category: 'extension' }>;

function extension(id: string, unit: MetricDefinition['unit']): ExtensionDefinition {
  return {
    category: 'extension', namespace: id.slice(0, id.indexOf('.')), id, semantic_version: '1.0.0',
    meaning: `${id} fixture metric`, resource_type: 'instance', unit, scope: 'resource', kind: 'gauge',
    roles: ['diagnostic'], temporality: 'instant', monotonic: false, value_type: 'float64',
    dimensions: { keys: [], max_series_per_resource: 100, max_value_length: 128, overflow: 'reject' },
    aggregation: {
      time: ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null',
      min_coverage: 1, quantiles: 'not_applicable',
    },
    lifecycle: 'active',
  };
}

const alpha = extension('fixture.alpha', '1');
const beta = extension('fixture.beta', 'count');

const implementation: ImplementationSpec = {
  id: 'impl:fixture.main', method: 'sql', resource_type: 'instance',
  applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
  outputs: [
    { raw_field: 'alpha', definition: alpha, input_unit: '1' },
    { raw_field: 'beta', definition: beta, input_unit: 'count' },
  ],
  permissions: ['SHOW FIXTURE MAIN'],
  discovery: 'fixture main status row',
};

const statusCollector: CollectorDefinition = {
  id: 'status', method: 'sql', implementation_ref: implementation.id, timeout_ms: 5000,
  estimated_cost: 'low',
  mappings: [alpha, beta].map(definition => ({
    metric: { id: definition.id, semantic_version: definition.semantic_version },
    raw_field: definition.id.slice('fixture.'.length), input_unit: definition.unit,
    output_unit: definition.unit, transform_version: '1.0.0', steps: ['decode', 'normalize'] as const,
  })),
};

const legacyRelease: PackageRelease = sealRelease({
  package: {
    id: 'legacy-package', version: '2.3.4', contract_version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`,
    resource_type: 'instance', applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
    collectors: [statusCollector],
  },
  extensions: [alpha, beta],
  derived: [],
  transforms: [{ id: 'normalize', version: '1.0.0' }],
  recommendations: {
    interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
    max_counter_gap_ms: 300000, max_rows: 100, enabled: true,
  },
  documentation: [{
    collector_id: statusCollector.id,
    permissions: implementation.permissions,
    discovery: implementation.discovery,
  }],
});

const LEGACY_PACKAGE = {
  id: legacyRelease.package.id, version: legacyRelease.package.version, digest: legacyRelease.package.digest,
};
const RELEASE_REF = `${LEGACY_PACKAGE.id}@${LEGACY_PACKAGE.version}#${LEGACY_PACKAGE.digest}`;

function fixtureRegistry(): PackageRegistry {
  const registry = new PackageRegistry([], [implementation]);
  registry.install(legacyRelease);
  return registry;
}

const legacyBinding = () => ({
  resource: { ...RESOURCE }, package: { ...LEGACY_PACKAGE }, group_id: 'web',
  overrides: { interval_ms: { mode: 'set' as const, value: 30000 } }, revision: 4,
});

/** The actual `Resolved` `resolvePolicy` writes for the row above. */
const legacyResolved = () => resolvePolicy(
  fixtureRegistry(), legacyBinding(),
  { id: 'web', revision: 2, policy_revision: 2, overrides: {} },
  {
    type: 'instance', id: '7',
    attributes: { 'db.engine': { value: 'fixture', observed_at: AT, source: 'fixture' } },
  } as never,
  [alpha, beta].map(definition => ({
    resource_id: '7', metric: { id: definition.id, semantic_version: definition.semantic_version },
    method: 'sql' as const, status: 'supported' as const,
    basis: [{ kind: 'permission' as const, evidence: 'fixed_read_succeeded' }],
    evaluated_at: AT, valid_until: '2026-10-05T00:00:00.000Z',
  })),
  AT,
);

function legacyPublished(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    binding: legacyBinding(),
    resolved: legacyResolved(),
    published_at: T1,
    application: { applied_revision: 4, reported_at: T1, status: 'applied', error_code: null },
    ...overrides,
  };
}

// --- a complete B2C collection plan shape ------------------------------------

const SETTINGS = {
  enabled: true, interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
  max_counter_gap_ms: 300000, max_rows: 100, max_concurrency: 1, max_series_per_resource: 100,
};

const plan = (
  revision: number,
  identity: string,
  resource: { type: string; id: string } = { type: 'instance', id: '7' },
) => ({
  kind: 'template_collection_plan', internal: true, persisted: false, applied: false,
  executable: true, identity, revision, resource,
  settings: { ...SETTINGS },
  parameters: [{
    pin: { ...PIN },
    parameters: [{
      name: 'interval_ms', type: 'integer', default: 30000, override: 40000,
      effective: 40000, source: 'override',
    }],
  }],
  triggers: [{ pin: { ...PIN }, refs: [{ rule_id: 'disk-full', scope: 'item:alpha-item', version: 1 }] }],
  releases: [{
    release: { ...LEGACY_PACKAGE }, release_ref: RELEASE_REF,
    interval_ms: 60000, timeout_ms: 5000, jitter_ms: 10,
    applicability: [{ attribute: 'db.engine', value: 'fixture', supported_values: ['fixture'], status: 'supported' }],
    collector_ids: ['status'], metric_keys: ['fixture.alpha@1.0.0'],
    queries: [{ implementation: implementation.id, collectors: ['status'], cost: 'low', logicalReads: 1 }],
    requests_per_hour_estimate: 60,
    steps: [{
      release: { ...LEGACY_PACKAGE }, release_ref: RELEASE_REF,
      collector_id: 'status', implementation_id: implementation.id, method: 'sql', estimated_cost: 'low',
      timeout_ms: 5000, timeout_source: { layer: 'resource', id: 'web', revision: 4 },
      logical_reads: 1, parameter_signature: HASH,
      metrics: [{ id: 'fixture.alpha', semantic_version: '1.0.0' }],
      items: [{
        pin: { ...PIN }, template_id: 'tpl-one', item_id: 'alpha-item', item_version: 1,
        canonical_metric: { id: 'fixture.alpha', semantic_version: '1.0.0' },
        unit: '1', dimensions: {},
        mapping: {
          metric: { id: 'fixture.alpha', semantic_version: '1.0.0' }, raw_field: 'alpha',
          input_unit: '1', output_unit: '1', transform_version: '1.0.0', steps: ['decode', 'normalize'],
        },
        capability: {
          resource_id: '7', metric: { id: 'fixture.alpha', semantic_version: '1.0.0' },
          status: 'supported', method: 'sql',
          basis: [{ kind: 'permission', evidence: 'fixed_read_succeeded' }],
          evaluated_at: AT, valid_until: '2026-10-05T00:00:00.000Z',
        },
      }],
    }],
  }],
  excluded: [],
  budget: {
    estimate: true, request_unit: 'logical_reads', estimated_series_upper_bound: 2,
    max_series_per_resource: 100, requests_per_hour_estimate: 60,
  },
});

const templateBinding = (overrides: Record<string, unknown> = {}) => ({
  resource: { ...RESOURCE }, package: null, group_id: 'web',
  overrides: {}, revision: 5, template_pins: [{ ...PIN }],
  ...overrides,
});

function templatePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    envelope: BINDING_PAYLOAD_ENVELOPE,
    binding: templateBinding(),
    template_resolution: {
      pending: {
        base_revision: 4, target_revision: 5, resolution_identity: IDENTITY,
        plan: plan(4, IDENTITY), decided_at: NOW, operation_key: `instance:7#5@${IDENTITY}`,
      },
    },
    application: {
      status: 'pending', applied_revision: 4, reported_at: null, error_code: null, resolution_identity: null,
    },
    effective: {
      source: 'package', revision: 4, resolution_identity: null, resolved: legacyResolved(),
    },
    published_at: NOW,
    ...overrides,
  };
}

function codeOf(run: () => unknown): BindingPersistenceErrorCode {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BindingPersistenceError);
    const persistence = error as BindingPersistenceError;
    expect(persistence.message).toBe(persistence.code);
    return persistence.code;
  }
  throw new Error('expected a BindingPersistenceError');
}

const templateWith = (mutate: (payload: Record<string, any>) => void): Record<string, unknown> => {
  const payload = structuredClone(templatePayload()) as Record<string, any>;
  mutate(payload);
  return payload;
};

const legacyWith = (mutate: (payload: Record<string, any>) => void): Record<string, unknown> => {
  const payload = structuredClone(legacyPublished()) as Record<string, any>;
  mutate(payload);
  return payload;
};

describe('legacy single-package payloads', () => {
  it('roundtrips a row without template_pins byte for byte, adding no field', () => {
    const text = JSON.stringify(legacyPublished());
    const decoded = decodeBindingPayload(text);

    expect(decoded.kind).toBe('legacy_published');
    expect(decoded.source).toBe('package');
    if (decoded.kind !== 'legacy_published') throw new Error('unreachable');
    expect(decoded.binding.template_pins).toEqual([]);
    expect(decoded.application).toEqual(legacyPublished().application);
    expect(encodeBindingPayload(decoded)).toBe(text);
    // No envelope, pins or pending snapshot is injected into the stored value.
    expect(decoded.payload).toEqual(legacyPublished());
    expect(Object.hasOwn(decoded.payload, 'envelope')).toBe(false);
    expect(Object.hasOwn(decoded.payload.binding as object, 'template_pins')).toBe(false);
  });

  it('roundtrips an explicit empty pin list unchanged', () => {
    const published = legacyPublished({ binding: { ...legacyBinding(), template_pins: [] } });
    const text = JSON.stringify(published);
    expect(encodeBindingPayload(decodeBindingPayload(text))).toBe(text);
  });

  it('proves the effective package snapshot only for the applied revision itself', () => {
    const decoded = decodeBindingPayload(JSON.stringify(legacyPublished()));
    if (decoded.kind !== 'legacy_published') throw new Error('unreachable');
    expect(decoded.effective_missing).toBe(false);
    expect(decoded.effective).toEqual({
      source: 'package', revision: 4, resolution_identity: null, resolved: legacyResolved(),
    });
  });

  it('reports a missing effective fact when the row only kept a newer pending resolved value', () => {
    const decoded = decodeBindingPayload(JSON.stringify(legacyPublished({
      application: { applied_revision: 3, reported_at: T1, status: 'pending', error_code: null },
    })));
    if (decoded.kind !== 'legacy_published') throw new Error('unreachable');
    expect(decoded.effective).toBeNull();
    expect(decoded.effective_missing).toBe(true);
    // The fact is reported; the row itself is still preserved untouched.
    expect(decodeBindingPayload(encodeBindingPayload(decoded)).kind).toBe('legacy_published');
  });

  it('allows a null applied revision and therefore no effective snapshot', () => {
    const decoded = decodeBindingPayload(JSON.stringify(legacyPublished({
      application: { applied_revision: null, reported_at: null, status: 'pending', error_code: null },
    })));
    if (decoded.kind !== 'legacy_published') throw new Error('unreachable');
    expect(decoded.effective).toBeNull();
    expect(decoded.effective_missing).toBe(false);
  });

  it('rejects a legacy application that claims applied without an applied revision', () => {
    expect(codeOf(() => decodeBindingPayload(JSON.stringify(legacyPublished({
      application: { applied_revision: null, reported_at: null, status: 'applied', error_code: null },
    }))))).toBe('BINDING_PAYLOAD_APPLICATION_INVALID');
  });
});

describe('source discrimination', () => {
  it('classifies the envelope form as template and the legacy form as package', () => {
    expect(bindingPayloadSource(JSON.stringify(templatePayload()))).toBe('template');
    expect(bindingPayloadSource(JSON.stringify(legacyPublished()))).toBe('package');
  });

  it('rejects unknown envelopes instead of guessing', () => {
    expect(codeOf(() => decodeBindingPayload({ ...templatePayload(), envelope: 'templates-v2' })))
      .toBe('BINDING_PAYLOAD_UNKNOWN_ENVELOPE');
    expect(codeOf(() => decodeBindingPayload({ ...legacyPublished(), envelope: 'package-v2' })))
      .toBe('BINDING_PAYLOAD_UNKNOWN_ENVELOPE');
  });

  it('rejects a package with pins and a template with a package as ambiguous', () => {
    expect(codeOf(() => decodeBindingPayload(legacyWith(payload => {
      payload.binding.template_pins = [{ ...PIN }];
    })))).toBe('BINDING_PAYLOAD_AMBIGUOUS_SOURCE');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.binding.package = LEGACY_PACKAGE;
    })))).toBe('BINDING_PAYLOAD_AMBIGUOUS_SOURCE');
  });

  it('rejects a payload with no version identity at all', () => {
    expect(codeOf(() => decodeBindingPayload({
      ...legacyPublished(), binding: { ...legacyBinding(), package: null },
    }))).toBe('BINDING_PAYLOAD_MISSING_SOURCE');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.binding.template_pins = [];
    })))).toBe('BINDING_PAYLOAD_MISSING_SOURCE');
  });

  it('rejects invalid JSON and non-object payloads', () => {
    expect(codeOf(() => decodeBindingPayload('{"binding": '))).toBe('BINDING_PAYLOAD_INVALID_JSON');
    expect(codeOf(() => decodeBindingPayload('[]'))).toBe('BINDING_PAYLOAD_NOT_OBJECT');
    expect(codeOf(() => decodeBindingPayload('null'))).toBe('BINDING_PAYLOAD_NOT_OBJECT');
    expect(codeOf(() => decodeBindingPayload(42))).toBe('BINDING_PAYLOAD_NOT_OBJECT');
  });
});

describe('the explicit package-v1 envelope', () => {
  it('reads the same published content and preserves the envelope on re-encode', () => {
    const text = JSON.stringify({ ...legacyPublished(), envelope: BINDING_PAYLOAD_PACKAGE_ENVELOPE });
    const decoded = decodeBindingPayload(text);

    expect(decoded.kind).toBe('legacy_published');
    expect(decoded.source).toBe('package');
    if (decoded.kind !== 'legacy_published') throw new Error('unreachable');
    expect(decoded.effective).not.toBeNull();
    expect(encodeBindingPayload(decoded)).toBe(text);
    expect(decoded.payload.envelope).toBe(BINDING_PAYLOAD_PACKAGE_ENVELOPE);
  });

  it('applies the legacy rules, including the ambiguity and missing-source rejections', () => {
    expect(codeOf(() => decodeBindingPayload({
      ...legacyPublished(), envelope: BINDING_PAYLOAD_PACKAGE_ENVELOPE,
      binding: { ...legacyBinding(), template_pins: [{ ...PIN }] },
    }))).toBe('BINDING_PAYLOAD_AMBIGUOUS_SOURCE');
    expect(codeOf(() => decodeBindingPayload({
      ...legacyPublished(), envelope: BINDING_PAYLOAD_PACKAGE_ENVELOPE,
      binding: { ...legacyBinding(), package: null },
    }))).toBe('BINDING_PAYLOAD_MISSING_SOURCE');
    expect(codeOf(() => decodeBindingPayload({
      ...legacyPublished(), envelope: BINDING_PAYLOAD_PACKAGE_ENVELOPE, extra: true,
    }))).toBe('BINDING_PAYLOAD_LEGACY_INVALID');
  });

  it('defaults only an absent pin list and rejects a present malformed one', () => {
    const absent = legacyPublished();
    expect(decodeBindingPayload({
      ...absent, envelope: BINDING_PAYLOAD_PACKAGE_ENVELOPE,
    }).kind).toBe('legacy_published');

    for (const templatePins of ['bad', null, {}, 7]) {
      expect(codeOf(() => decodeBindingPayload({
        ...legacyPublished(), binding: { ...legacyBinding(), template_pins: templatePins },
      }))).toBe('BINDING_PAYLOAD_BINDING_INVALID');
      expect(codeOf(() => decodeBindingPayload({
        ...legacyPublished(), envelope: BINDING_PAYLOAD_PACKAGE_ENVELOPE,
        binding: { ...legacyBinding(), template_pins: templatePins },
      }))).toBe('BINDING_PAYLOAD_BINDING_INVALID');
    }
    expect(decodeBindingPayload({
      ...legacyPublished(), binding: { ...legacyBinding(), template_pins: [] },
    }).kind).toBe('legacy_published');
  });
});

describe('a stored effective snapshot must be a real resolved view', () => {
  it('rejects an empty resolved object instead of proving it', () => {
    expect(codeOf(() => decodeBindingPayload(legacyPublished({ resolved: {} }))))
      .toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    expect(codeOf(() => decodeBindingPayload(legacyPublished({ resolved: { plan: { revision: 4 } } }))))
      .toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    expect(codeOf(() => decodeBindingPayload(legacyPublished({ resolved: null }))))
      .toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  });

  it('rejects a plan whose config revision disagrees with the row and the applied revision', () => {
    expect(codeOf(() => decodeBindingPayload(legacyWith(payload => {
      payload.resolved.plan.binding.config_revision = 3;
    })))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  });

  it('rejects a resolved view that belongs to another resource or package', () => {
    expect(codeOf(() => decodeBindingPayload(legacyWith(payload => {
      payload.resolved.plan.binding.resource_id = '8';
    })))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    expect(codeOf(() => decodeBindingPayload(legacyWith(payload => {
      payload.resolved.plan.binding.package.digest = `sha256:${'f'.repeat(64)}`;
    })))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    expect(codeOf(() => decodeBindingPayload(legacyWith(payload => {
      payload.resolved.plan.binding.policy_id = 'other-group';
    })))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  });

  it('rejects a resolved view whose settings and plan policy disagree', () => {
    expect(codeOf(() => decodeBindingPayload(legacyWith(payload => {
      payload.resolved.settings.interval_ms = 45000;
    })))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  });

  it('still reports a missing fact for a valid snapshot of a newer revision', () => {
    const decoded = decodeBindingPayload(JSON.stringify(legacyPublished({
      application: { applied_revision: 3, reported_at: T1, status: 'pending', error_code: null },
    })));
    if (decoded.kind !== 'legacy_published') throw new Error('unreachable');
    expect(decoded.effective).toBeNull();
    expect(decoded.effective_missing).toBe(true);
  });
});

describe('template pending payloads', () => {
  it('decodes the full pending value with the base→target mapping intact', () => {
    const decoded = decodeBindingPayload(JSON.stringify(templatePayload()));
    expect(decoded.kind).toBe('template_pending');
    if (decoded.kind !== 'template_pending') throw new Error('unreachable');
    expect(decoded.binding.revision).toBe(5);
    expect(decoded.binding.package).toBeNull();
    expect(decoded.pending.base_revision).toBe(4);
    expect(decoded.pending.target_revision).toBe(5);
    expect(decoded.pending.resolution_identity).toBe(IDENTITY);
    expect(decoded.pending.plan.identity).toBe(IDENTITY);
    // The plan keeps the identity of the resolution that produced it (base), not the target.
    expect(decoded.pending.plan.revision).toBe(4);
    expect(decoded.pending.operation_key).toBe(`instance:7#5@${IDENTITY}`);
    expect(decoded.application.applied_revision).toBe(4);
    expect(decoded.application.status).toBe('pending');
    expect(decoded.effective).toEqual({
      source: 'package', revision: 4, resolution_identity: null, resolved: legacyResolved(),
    });
    expect(encodeBindingPayload(decoded)).toBe(JSON.stringify(templatePayload()));
  });

  it('rejects a binding revision that does not equal the pending target', () => {
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.binding.revision = 6;
    })))).toBe('BINDING_PAYLOAD_REVISION_INVALID');
  });

  it('rejects a non-consecutive base/target pair (a repeated revision)', () => {
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.template_resolution.pending.target_revision = 4;
      payload.binding.revision = 4;
    })))).toBe('BINDING_PAYLOAD_REVISION_INVALID');
  });

  it('rejects a pending plan whose identity or revision drifted', () => {
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.template_resolution.pending.plan.identity = HASH;
    })))).toBe('BINDING_PAYLOAD_PLAN_INVALID');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.template_resolution.pending.plan.revision = 5;
    })))).toBe('BINDING_PAYLOAD_PLAN_INVALID');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.template_resolution.pending.plan.resource.id = '8';
    })))).toBe('BINDING_PAYLOAD_PLAN_INVALID');
  });

  it('rejects a plan that carries only the four identity labels', () => {
    const labels = {
      kind: 'template_collection_plan', identity: IDENTITY, revision: 4,
      resource: { type: 'instance', id: '7' },
    };
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.template_resolution.pending.plan = { ...labels };
    })))).toBe('BINDING_PAYLOAD_PLAN_INVALID');
    // Even with the labels in place, a missing or mistyped part is not a plan.
    for (const key of ['settings', 'parameters', 'triggers', 'releases', 'excluded', 'budget', 'executable']) {
      expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
        delete payload.template_resolution.pending.plan[key];
      })))).toBe('BINDING_PAYLOAD_PLAN_INVALID');
    }
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.template_resolution.pending.plan.internal = false;
    })))).toBe('BINDING_PAYLOAD_PLAN_INVALID');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.template_resolution.pending.plan.releases[0].steps[0].items = [];
    })))).toBe('BINDING_PAYLOAD_PLAN_INVALID');
  });

  it('rejects a malformed pending snapshot and unknown top-level fields', () => {
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      delete payload.template_resolution.pending.operation_key;
    })))).toBe('BINDING_PAYLOAD_PENDING_INVALID');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.template_resolution.extra = true;
    })))).toBe('BINDING_PAYLOAD_PENDING_INVALID');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.extra = true;
    })))).toBe('BINDING_PAYLOAD_SHAPE_INVALID');
  });

  it('rejects an application/effective pair that disagrees', () => {
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.application.applied_revision = null;
    })))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.effective.revision = 3;
    })))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.application.resolution_identity = IDENTITY;
    })))).toBe('BINDING_PAYLOAD_IDENTITY_MISMATCH');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.application.status = 'applied';
      payload.application.applied_revision = null;
      payload.effective = null;
    })))).toBe('BINDING_PAYLOAD_APPLICATION_INVALID');
  });

  it('rejects a carried package snapshot that is empty or from another resource', () => {
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.effective.resolved = {};
    })))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.effective.resolved.plan.binding.resource_id = '8';
    })))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.effective.resolved.plan.binding.config_revision = 3;
    })))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  });

  it('rejects a template effective snapshot belonging to another resource', () => {
    expect(codeOf(() => decodeBindingPayload(templateWith(payload => {
      payload.application.resolution_identity = HASH;
      payload.effective = {
        source: 'template', revision: 4, resolution_identity: HASH,
        plan: plan(4, HASH, { type: 'instance', id: '8' }),
      };
    })))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  });

  it('accepts a template effective snapshot of this row and keeps its plan', () => {
    const decoded = decodeBindingPayload(templateWith(payload => {
      payload.application.resolution_identity = HASH;
      payload.effective = {
        source: 'template', revision: 4, resolution_identity: HASH, plan: plan(4, HASH),
      };
    }));
    if (decoded.kind !== 'template_pending') throw new Error('unreachable');
    expect(decoded.effective).toMatchObject({ source: 'template', revision: 4, resolution_identity: HASH });
  });

  it('never echoes payload values in an error', () => {
    const secret = 'password-value-must-not-leak';
    try {
      decodeBindingPayload(templateWith(payload => {
        payload.binding.template_pins = [];
        payload.binding.overrides = { secret };
      }));
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(BindingPersistenceError);
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

describe('object input that JSON would silently rewrite', () => {
  it('rejects non-finite numbers, BigInt and undefined instead of encoding them away', () => {
    const nonFinite = templatePayload() as Record<string, any>;
    nonFinite.template_resolution.pending.plan.budget.requests_per_hour_estimate = Number.NaN;
    expect(codeOf(() => decodeBindingPayload(nonFinite))).toBe('BINDING_PAYLOAD_SHAPE_INVALID');

    const infinite = legacyPublished();
    (infinite as Record<string, any>).resolved.impact.requests_per_hour_estimate = Number.POSITIVE_INFINITY;
    expect(codeOf(() => decodeBindingPayload(infinite))).toBe('BINDING_PAYLOAD_SHAPE_INVALID');

    const big = legacyPublished();
    (big as Record<string, any>).resolved.settings.interval_ms = BigInt(60000);
    expect(codeOf(() => decodeBindingPayload(big))).toBe('BINDING_PAYLOAD_SHAPE_INVALID');

    const absent = templatePayload();
    (absent as Record<string, any>).template_resolution.pending.plan.executable = undefined;
    expect(codeOf(() => decodeBindingPayload(absent))).toBe('BINDING_PAYLOAD_SHAPE_INVALID');
  });

  it('rejects a cyclic object as not a stored row', () => {
    const cyclic = legacyPublished() as Record<string, any>;
    cyclic.resolved.impact.active_collectors.push(cyclic.resolved);
    expect(codeOf(() => decodeBindingPayload(cyclic))).toBe('BINDING_PAYLOAD_SHAPE_INVALID');
  });
});

describe('template pending encoding', () => {
  const input = () => ({
    binding: templateBinding() as never,
    base_revision: 4,
    target_revision: 5,
    resolution_identity: IDENTITY,
    plan: plan(4, IDENTITY) as never,
    decided_at: NOW,
    operation_key: `instance:7#5@${IDENTITY}`,
    applied_revision: 4,
    previous_resolution_identity: null,
    previous_effective: {
      source: 'package' as const, revision: 4, resolution_identity: null,
      resolved: legacyResolved() as unknown as Record<string, unknown>,
    },
    published_at: NOW,
  });

  it('writes a payload the decoder accepts and preserves the previous effective snapshot', () => {
    const text = encodeTemplatePendingPayload(input());
    const decoded = decodeBindingPayload(text);
    expect(decoded.kind).toBe('template_pending');
    if (decoded.kind !== 'template_pending') throw new Error('unreachable');
    expect(decoded.application.applied_revision).toBe(4);
    expect(decoded.effective).toEqual(input().previous_effective);
    expect(decoded.binding.revision).toBe(5);
  });

  it('is isolated from later input mutation and from decoded-value mutation', () => {
    const source = input();
    const text = encodeTemplatePendingPayload(source);
    (source.plan as unknown as Record<string, unknown>).executable = false;
    (source.binding as unknown as Record<string, unknown>).revision = 9;
    expect(decodeBindingPayload(text).kind).toBe('template_pending');

    const decoded = decodeBindingPayload(JSON.stringify(templatePayload()));
    if (decoded.kind !== 'template_pending') throw new Error('unreachable');
    decoded.binding.template_pins[0].version = 9;
    expect(decodeBindingPayload(JSON.stringify(templatePayload()))).toMatchObject({
      kind: 'template_pending', pending: { target_revision: 5 },
    });
  });

  it('refuses to write an identity or effective revision that disagrees with the intent', () => {
    expect(codeOf(() => encodeTemplatePendingPayload({
      ...input(), previous_resolution_identity: IDENTITY,
    }))).toBe('BINDING_PAYLOAD_IDENTITY_MISMATCH');
    expect(codeOf(() => encodeTemplatePendingPayload({
      ...input(), applied_revision: 3,
    }))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  });

  it('refuses a plan or effective value that is not a stored snapshot', () => {
    expect(codeOf(() => encodeTemplatePendingPayload({
      ...input(), plan: { kind: 'template_collection_plan', identity: IDENTITY, revision: 4 } as never,
    }))).toBe('BINDING_PAYLOAD_PLAN_INVALID');
    expect(codeOf(() => encodeTemplatePendingPayload({
      ...input(),
      previous_effective: {
        source: 'package', revision: 4, resolution_identity: null, resolved: {},
      },
    }))).toBe('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  });

  it('refuses a value JSON.stringify would rewrite', () => {
    const source = input();
    (source.plan as unknown as Record<string, any>).budget.requests_per_hour_estimate = Number.NaN;
    expect(codeOf(() => encodeTemplatePendingPayload(source))).toBe('BINDING_PAYLOAD_SHAPE_INVALID');
  });
});
