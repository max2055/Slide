import { describe, expect, it } from 'vitest';
import {
  BINDING_PAYLOAD_ENVELOPE, BindingPersistenceError, bindingPayloadSource,
  decodeBindingPayload, encodeBindingPayload, encodeTemplatePendingPayload,
  type BindingPersistenceErrorCode,
} from './persistence-codec.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const IDENTITY = `sha256:${'b'.repeat(64)}`;
const T1 = '2026-10-02T00:00:00Z';
const NOW = '2026-10-03T00:00:00Z';
const LEGACY_PACKAGE = { id: 'legacy-package', version: '2.3.4', digest: `sha256:${'c'.repeat(64)}` };
const PIN = { template_id: 'tpl-one', version: 1, content_hash: HASH };
const RESOURCE = { type: 'instance' as const, id: 7 };

const plan = (revision: number, identity: string, resource: { type: string; id: string } = { type: 'instance', id: '7' }) => ({
  kind: 'template_collection_plan', internal: true, persisted: false, applied: false,
  executable: true, identity, revision, resource,
  settings: {}, parameters: [], triggers: [], releases: [], excluded: [],
  budget: { estimate: true, request_unit: 'logical_reads', estimated_series_upper_bound: 0, max_series_per_resource: 0, requests_per_hour_estimate: 0 },
});

const legacyBinding = () => ({
  resource: { ...RESOURCE }, package: LEGACY_PACKAGE, group_id: 'web',
  overrides: { interval_ms: { mode: 'set', value: 30000 } }, revision: 4,
});

function legacyPublished(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    binding: legacyBinding(),
    resolved: { plan: { revision: 4 }, settings: { enabled: true } },
    published_at: T1,
    application: { applied_revision: 4, reported_at: T1, status: 'applied', error_code: null },
    ...overrides,
  };
}

function templateBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resource: { ...RESOURCE }, package: null, group_id: 'web',
    overrides: {}, revision: 5, template_pins: [{ ...PIN }],
    ...overrides,
  };
}

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
      source: 'package', revision: 4, resolution_identity: null, resolved: { plan: { revision: 4 } },
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
      source: 'package', revision: 4, resolution_identity: null,
      resolved: { plan: { revision: 4 }, settings: { enabled: true } },
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
  });

  it('rejects a package with pins and a template with a package as ambiguous', () => {
    expect(codeOf(() => decodeBindingPayload({
      ...legacyPublished(), binding: { ...legacyBinding(), template_pins: [{ ...PIN }] },
    }))).toBe('BINDING_PAYLOAD_AMBIGUOUS_SOURCE');
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
      source: 'package', revision: 4, resolution_identity: null, resolved: { plan: { revision: 4 } },
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
      resolved: { plan: { revision: 4 } },
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
});
