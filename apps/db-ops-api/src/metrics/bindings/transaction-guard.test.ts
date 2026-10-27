import { describe, expect, it, vi } from 'vitest';
import type {
  CollectorDefinition, DerivedMetric, MetricDefinition,
} from '../../contracts/metrics/index.js';
import type {
  HashId, PackageCompositionEntry, ResourceBindingCandidate, SourceChain, TemplateItemVersion,
  TemplateParameters, TemplatePin, TemplateVersion, VersionNumber,
} from '../../contracts/metrics/templates.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from '../packages/model.js';
import { packageReleaseRef, templateContentHash, type MetricRef } from '../templates/model.js';
import { BindingCandidateError, compileBindingCandidate, type BindingTemplateCandidate } from './compile.js';
import { BindingPreflightError, type TemplateVersionReadPort } from './preflight.js';
import {
  BindingTransactionError, bindingCandidateDigest, bindingOperationKey,
  prepareTemplateBindingMutation,
  type BindingTransactionPort, type BindingItemRef, type TrustedAuthorization,
  type TrustedBindingOperation,
} from './transaction-guard.js';

const T0 = '2026-10-01T00:00:00Z';
const T1 = '2026-10-02T00:00:00Z';
const NOW = '2026-10-03T00:00:00Z';
const ISSUED = '2026-10-02T12:00:00Z';
const EXPIRES = '2026-10-04T00:00:00Z';
const DEP = `sha256:${'d'.repeat(64)}`;
const OTHER_DEP = `sha256:${'e'.repeat(64)}`;
const RESOURCE = { type: 'instance' as const, id: 7 };

type ExtensionDefinition = Extract<MetricDefinition, { category: 'extension' }>;
type CollectorStep = CollectorDefinition['mappings'][number]['steps'];

const dims = () => ({
  keys: [], max_series_per_resource: 100, max_value_length: 128, overflow: 'reject' as const,
});

function extension(id: string, unit: MetricDefinition['unit']): ExtensionDefinition {
  return {
    category: 'extension', namespace: id.slice(0, id.indexOf('.')), id, semantic_version: '1.0.0',
    meaning: `${id} fixture metric`, resource_type: 'instance', unit, scope: 'resource', kind: 'gauge',
    roles: ['diagnostic'], temporality: 'instant', monotonic: false, value_type: 'float64',
    dimensions: dims(),
    aggregation: {
      time: ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null',
      min_coverage: 1, quantiles: 'not_applicable',
    },
    lifecycle: 'active',
  };
}

const alpha = extension('fixture.alpha', '1');
const beta = extension('fixture.beta', 'count');
const extensions: ExtensionDefinition[] = [alpha, beta];

const mainImpl: ImplementationSpec = {
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
  id: 'status', method: 'sql', implementation_ref: mainImpl.id, timeout_ms: 5000,
  estimated_cost: 'low',
  mappings: [alpha, beta].map(definition => ({
    metric: { id: definition.id, semantic_version: definition.semantic_version },
    raw_field: definition.id.slice('fixture.'.length), input_unit: definition.unit,
    output_unit: definition.unit, transform_version: '1.0.0', steps: ['decode', 'normalize'] as CollectorStep,
  })),
};

/** A real release, sealed and installed through the existing registry contract. */
function release(): PackageRelease {
  return sealRelease({
    package: {
      id: 'fixture-a', version: '1.0.0', contract_version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`,
      resource_type: 'instance', applicability: [{ attribute: 'db.engine', values: ['fixture'] }],
      collectors: [statusCollector],
    },
    extensions,
    derived: [] as DerivedMetric[],
    transforms: [{ id: 'normalize', version: '1.0.0' }],
    recommendations: {
      interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
      max_counter_gap_ms: 300000, max_rows: 100, enabled: true,
    },
    documentation: [{
      collector_id: statusCollector.id,
      permissions: mainImpl.permissions,
      discovery: mainImpl.discovery,
    }],
  });
}

const releaseV1 = release();

function fixtureRegistry(): PackageRegistry {
  const registry = new PackageRegistry([], [mainImpl]);
  registry.install(releaseV1);
  return registry;
}

const releaseRef = packageReleaseRef(releaseV1.package);
const metricRef = (definition: ExtensionDefinition): MetricRef => ({
  id: definition.id, semantic_version: definition.semantic_version,
});

function item(itemId: string, definition: ExtensionDefinition): TemplateItemVersion {
  return {
    template_id: 'tpl-one', item_id: itemId, version: 1, display_name: itemId,
    canonical_metric: metricRef(definition), unit: definition.unit, dimensions: {},
    collector_ref: { package_release: releaseRef, implementation_id: mainImpl.id },
    params_default: {},
    source_chain: {
      actor_id: 1, request_id: `req-item-${itemId}`, base: null,
      created_at: T0, published_at: T1, retired_at: null, migration_ref: null,
    },
  };
}

interface VersionSpec {
  items: TemplateItemVersion[];
  version?: VersionNumber;
  parameters?: TemplateParameters;
  source_chain?: Partial<SourceChain>;
}

function templateVersion(spec: VersionSpec): TemplateVersion {
  const composition: PackageCompositionEntry[] = [{
    release: releaseRef, items: spec.items.map(stored => stored.item_id).sort(),
  }];
  const aggregate = {
    template_id: 'tpl-one',
    base: null,
    items: spec.items.map(stored => ({ item_id: stored.item_id, version: stored.version }))
      .sort((left, right) => left.item_id < right.item_id ? -1 : left.item_id > right.item_id ? 1 : 0),
    triggers: [],
    parameters: spec.parameters ?? { schema: {}, defaults: {} },
    capabilities: {
      discovery: { contract_version: '1.0.0', ref: null, executable: false as const },
      graphs: { contract_version: '1.0.0', ref: null, executable: false as const },
    },
    package_composition: composition,
  };
  return {
    template_id: 'tpl-one',
    version: spec.version ?? 1,
    status: 'published',
    content_hash: templateContentHash(aggregate),
    aggregate,
    items: spec.items,
    package_composition: composition,
    source_chain: {
      actor_id: 1, request_id: 'req-tpl-one', base: null,
      created_at: T0, published_at: T1, retired_at: null, migration_ref: null,
      ...spec.source_chain,
    },
    published_at: T1,
    retired_at: null,
  };
}

const params = (interval: number) => ({
  schema: { interval_ms: { type: 'integer' as const, min: 1000, max: 60000 } },
  defaults: { interval_ms: interval },
});
const templateV1 = templateVersion({ items: [item('alpha-item', alpha), item('beta-item', beta)], parameters: params(30000) });
const templateV2 = templateVersion({
  items: [item('alpha-item', alpha), item('beta-item', beta)], version: 2, parameters: params(60000),
});

const pin = (version: TemplateVersion): TemplatePin => ({
  template_id: version.template_id, version: version.version, content_hash: version.content_hash,
});

function portOf(versions: TemplateVersion[]) {
  const getVersion = vi.fn(async (templateId: string, version: VersionNumber) =>
    versions.find(entry => entry.template_id === templateId && entry.version === version) ?? null);
  return { port: { getVersion } satisfies TemplateVersionReadPort, getVersion };
}

const templatePort = () => portOf([templateV1, templateV2]).port;

const legacyPackage = { id: 'legacy-package', version: '2.3.4', digest: `sha256:${'c'.repeat(64)}` };
const currentBinding = {
  resource: RESOURCE, package: legacyPackage, group_id: 'web', overrides: {}, revision: 4, template_pins: [],
};

function candidate(overrides: Partial<ResourceBindingCandidate> = {}): ResourceBindingCandidate {
  return {
    resource: { ...RESOURCE },
    package: null,
    group_id: 'web',
    overrides: { interval_ms: { mode: 'set', value: 30000 } },
    revision: 4,
    template_pins: [pin(templateV1)],
    ...overrides,
  } as ResourceBindingCandidate;
}

function legacyCandidate() {
  return {
    resource: { ...RESOURCE }, package: legacyPackage, group_id: 'web', overrides: {}, revision: 4, template_pins: [],
  };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  resource: { ...RESOURCE }, candidate: candidate(), receipt_id: 'receipt-1', caller_key: 'caller-1', ...overrides,
});

const allowed = (dependency: HashId = DEP): TrustedAuthorization => ({
  allowed: true, cancelled: false, dependency_digest: dependency,
});

const alphaRef: BindingItemRef = { template_id: 'tpl-one', item_id: 'alpha-item', item_version: 1 };
const betaRef: BindingItemRef = { template_id: 'tpl-one', item_id: 'beta-item', item_version: 1 };
const phases = (read = true, transform = true, unit = true) => ({ read, transform, unit });
const qualified = (ref: BindingItemRef) => ({ ...ref, phases: phases() });

function receiptFor(digest: HashId, overrides: Record<string, unknown> = {}) {
  return {
    receipt_id: 'receipt-1',
    resource: { ...RESOURCE },
    base_revision: 4,
    target_revision: 5,
    candidate_digest: digest,
    dependency_digest: DEP,
    issued_at: ISSUED,
    expires_at: EXPIRES,
    items: [qualified(alphaRef), qualified(betaRef)],
    optional_exclusions: [],
    ...overrides,
  };
}

type CallName = 'authorize' | 'currentBinding' | 'findOperation' | 'getTrialReceipt' | 'mandatoryItems' | 'serverNow';
type PortSetup = Partial<Record<CallName, () => Promise<unknown>>> & { omit?: CallName[] };

const defaultCalls = (): Record<CallName, number> => ({
  authorize: 0, currentBinding: 0, findOperation: 0, getTrialReceipt: 0, mandatoryItems: 0, serverNow: 0,
});

/** Trusted-view fixture; only methods supplied here ever run, and every run is counted. */
function makePort(setup: PortSetup = {}) {
  const calls = defaultCalls();
  const defaults: Partial<Record<CallName, () => Promise<unknown>>> = {
    authorize: async () => allowed(),
    currentBinding: async () => structuredClone(currentBinding),
    findOperation: async () => null,
    serverNow: async () => NOW,
  };
  const port: Record<string, unknown> = {};
  for (const name of ['authorize', 'currentBinding', 'findOperation', 'getTrialReceipt', 'mandatoryItems', 'serverNow'] as CallName[]) {
    if (setup.omit?.includes(name)) continue;
    const invoke = setup[name] ?? defaults[name];
    if (invoke === undefined) continue;
    port[name] = async () => { calls[name] += 1; return invoke(); };
  }
  return { port: port as unknown as BindingTransactionPort, calls };
}

async function compileFor(candidateInput: unknown): Promise<BindingTemplateCandidate> {
  const compiled = await compileBindingCandidate(candidateInput, templatePort(), fixtureRegistry());
  if (compiled.kind !== 'template_candidate') throw new Error('fixture candidate must not be legacy');
  return compiled;
}

async function digestFor(candidateInput: unknown, target = 5, dependency: HashId = DEP): Promise<HashId> {
  return bindingCandidateDigest(await compileFor(candidateInput), target, dependency);
}

async function happyPort(
  candidateInput: unknown = candidate(),
  receiptOverrides: Record<string, unknown> = {},
  setup: PortSetup = {},
) {
  const digest = await digestFor(candidateInput);
  const built = makePort({ getTrialReceipt: async () => receiptFor(digest, receiptOverrides), ...setup });
  return { ...built, digest };
}

const prepare = (
  port: BindingTransactionPort,
  requestValue: unknown = request(),
  registry: PackageRegistry = fixtureRegistry(),
  templates: TemplateVersionReadPort = templatePort(),
) => prepareTemplateBindingMutation(requestValue, port, templates, registry);

async function rejection(promise: Promise<unknown>): Promise<BindingTransactionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BindingTransactionError);
    return error as BindingTransactionError;
  }
  throw new Error('expected the transaction guard to reject');
}

async function candidateRejection(promise: Promise<unknown>): Promise<BindingCandidateError | BindingPreflightError> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof BindingCandidateError || error instanceof BindingPreflightError).toBe(true);
    return error as BindingCandidateError | BindingPreflightError;
  }
  throw new Error('expected the candidate verification to reject');
}

describe('prepared template binding mutation', () => {
  it('prepares the exact pending revision for a fully qualified trusted receipt', async () => {
    const { port, calls, digest } = await happyPort();
    const requestValue = request();
    const inputSnapshot = structuredClone(requestValue);
    const registry = fixtureRegistry();
    const registrySnapshot = registry.list();

    const outcome = await prepare(port, requestValue, registry);

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') throw new Error('unreachable');
    expect(outcome.prepared).toBe(true);
    expect(outcome.persisted).toBe(false);
    expect(outcome.applied).toBe(false);
    expect(outcome.base_revision).toBe(4);
    expect(outcome.target_revision).toBe(5);
    expect(outcome.candidate_digest).toBe(digest);
    expect(outcome.candidate_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(outcome.operation).toEqual({
      key: bindingOperationKey(RESOURCE, 5, digest),
      caller_key: 'caller-1', receipt_id: 'receipt-1', status: 'pending',
    });
    expect(outcome.current).toEqual(currentBinding);
    expect(outcome.next).toEqual({ ...candidate(), revision: 5 });

    expect(calls).toEqual({
      authorize: 2, currentBinding: 1, findOperation: 1, getTrialReceipt: 1, mandatoryItems: 0, serverNow: 1,
    });
    expect(requestValue).toEqual(inputSnapshot);
    expect(registry.list()).toEqual(registrySnapshot);
  });

  it('treats an old payload without template_pins as the explicit empty legacy set', async () => {
    const legacyPayload: Record<string, unknown> = { ...currentBinding };
    delete legacyPayload.template_pins;
    const { port } = await happyPort(candidate(), {}, { currentBinding: async () => legacyPayload });

    const outcome = await prepare(port);

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') throw new Error('unreachable');
    expect(outcome.current.template_pins).toEqual([]);
    expect(outcome.current.package).toEqual(legacyPackage);
    expect(outcome.current.revision).toBe(4);
    expect(outcome.next.revision).toBe(5);
  });

  it('delegates a legacy single-package candidate without a digest, receipt or write decision', async () => {
    const templates = portOf([templateV1, templateV2]);
    const { port, calls } = makePort();

    const outcome = await prepare(port, request({ candidate: legacyCandidate() }), fixtureRegistry(), templates.port);

    expect(outcome).toEqual({ kind: 'legacy_delegate', binding: legacyCandidate(), package: legacyPackage });
    expect(templates.getVersion).not.toHaveBeenCalled();
    expect(calls).toEqual({
      authorize: 1, currentBinding: 0, findOperation: 0, getTrialReceipt: 0, mandatoryItems: 0, serverNow: 0,
    });
  });

  it.each([
    ['compiled flag', { compiled: true }],
    ['client digest', { candidate_digest: `sha256:${'a'.repeat(64)}` }],
    ['client receipt body', { receipt: receiptBody() }],
    ['client passed list', { passed: [alphaRef] }],
    ['missing caller key', { caller_key: undefined }],
    ['missing receipt id', { receipt_id: undefined }],
  ])('rejects a request carrying %s', async (_label, overrides) => {
    const { port } = await happyPort();
    const error = await rejection(prepare(port, request(overrides)));

    expect(error.code).toBe('TRANSACTION_INPUT_INVALID');
  });

  it('re-verifies the candidate through B2A and never trusts a caller snapshot', async () => {
    const tampered = candidate({
      template_pins: [{ template_id: 'tpl-one', version: 1, content_hash: `sha256:${'f'.repeat(64)}` }],
    });
    const { port, calls } = makePort();

    const error = await candidateRejection(prepare(port, request({ candidate: tampered })));

    expect((error as BindingPreflightError).code).toBe('PREFLIGHT_CONTENT_HASH_MISMATCH');
    expect(calls.currentBinding).toBe(0);
    expect(calls.findOperation).toBe(0);
    expect(calls.getTrialReceipt).toBe(0);
  });

  it('rejects a missing current binding instead of inventing a base revision', async () => {
    const { port } = await happyPort(candidate(), {}, { currentBinding: async () => null });

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_BINDING_MISSING');
  });

  it('rejects a current binding that belongs to another resource', async () => {
    const { port } = await happyPort(candidate(), {}, {
      currentBinding: async () => ({ ...currentBinding, resource: { type: 'instance', id: 8 } }),
    });

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_BINDING_IDENTITY');
  });

  it('rejects a candidate whose resource differs from the requested resource', async () => {
    const other = candidate({ resource: { type: 'instance', id: 8 } });
    const { port } = await happyPort(other);

    expect((await rejection(prepare(port, request({ candidate: other })))).code).toBe('TRANSACTION_BINDING_IDENTITY');
  });

  it('rejects a stale expected revision against the trusted current revision', async () => {
    const { port } = await happyPort(candidate(), {}, {
      currentBinding: async () => ({ ...currentBinding, revision: 5 }),
    });

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_REVISION_CONFLICT');
  });

  it('rejects a target revision that is not a safe integer', async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const saturated = candidate({ revision: max });
    const { port } = await happyPort(saturated, {}, {
      currentBinding: async () => ({ ...currentBinding, revision: max }),
    });

    expect((await rejection(prepare(port, request({ candidate: saturated })))).code)
      .toBe('TRANSACTION_REVISION_CONFLICT');
  });
});

describe('trusted trial receipt', () => {
  it('rejects when the receipt port is absent', async () => {
    const { port } = await happyPort(candidate(), {}, { omit: ['getTrialReceipt'] });

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_RECEIPT_UNAVAILABLE');
  });

  it('collapses a throwing receipt port into a stable code without its text', async () => {
    const { port } = await happyPort(candidate(), {}, {
      getTrialReceipt: async () => { throw new Error('driver password=secret'); },
    });

    const error = await rejection(prepare(port));

    expect(error.code).toBe('TRANSACTION_RECEIPT_UNAVAILABLE');
    expect(error.message).toBe('TRANSACTION_RECEIPT_UNAVAILABLE');
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('rejects a receipt that cannot be found', async () => {
    const { port } = await happyPort(candidate(), {}, { getTrialReceipt: async () => null });

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_RECEIPT_NOT_FOUND');
  });

  it.each([
    ['unknown top-level field', { credential_ref: 'credential:leak' }],
    ['missing phases', { items: [{ template_id: 'tpl-one', item_id: 'alpha-item', item_version: 1 }] }],
    ['non-boolean phase', { items: [{ ...alphaRef, phases: { read: 1, transform: true, unit: true } }] }],
    ['missing candidate digest', { candidate_digest: undefined }],
  ])('rejects a receipt with %s', async (_label, overrides) => {
    const { port } = await happyPort(candidate(), overrides);

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_RECEIPT_INVALID');
  });

  it.each([
    ['receipt id', { receipt_id: 'receipt-9' }],
    ['resource', { resource: { type: 'instance', id: 8 } }],
    ['base revision', { base_revision: 3 }],
    ['target revision', { target_revision: 6 }],
    ['candidate digest', { candidate_digest: `sha256:${'a'.repeat(64)}` }],
    ['dependency digest', { dependency_digest: OTHER_DEP }],
  ])('rejects a receipt bound to another %s', async (_label, overrides) => {
    const { port } = await happyPort(candidate(), overrides);

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_RECEIPT_MISMATCH');
  });

  it.each([
    ['a future issue time', { issued_at: '2026-10-05T00:00:00Z' }, 'TRANSACTION_RECEIPT_TIME_INVALID'],
    ['expiry before issue', { expires_at: '2026-10-02T00:00:00Z' }, 'TRANSACTION_RECEIPT_TIME_INVALID'],
    ['an expired receipt', { expires_at: '2026-10-02T18:00:00Z' }, 'TRANSACTION_RECEIPT_EXPIRED'],
  ])('rejects %s', async (_label, overrides, code) => {
    const { port } = await happyPort(candidate(), overrides);

    expect((await rejection(prepare(port))).code).toBe(code);
  });

  it('rejects an unusable trusted clock', async () => {
    const { port } = await happyPort(candidate(), {}, { serverNow: async () => 'not-a-timestamp' });

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_TIME_UNAVAILABLE');
  });

  it.each([
    ['a failed phase', { items: [{ ...qualified(alphaRef), phases: phases(true, true, false) }, qualified(betaRef)] }, [alphaRef]],
    ['a missing selected item', { items: [qualified(alphaRef)] }, [betaRef]],
    [
      'a foreign item',
      { items: [qualified(alphaRef), qualified(betaRef), qualified({ template_id: 'tpl-two', item_id: 'x', item_version: 1 })] },
      [{ template_id: 'tpl-two', item_id: 'x', item_version: 1 }],
    ],
    ['a duplicate item', { items: [qualified(alphaRef), qualified(alphaRef), qualified(betaRef)] }, [alphaRef]],
    ['a forged exclusion', { items: [qualified(alphaRef)], optional_exclusions: [betaRef] }, [betaRef]],
    [
      'an exclusion of an unknown item',
      { optional_exclusions: [{ template_id: 'tpl-one', item_id: 'ghost', item_version: 1 }] },
      [{ template_id: 'tpl-one', item_id: 'ghost', item_version: 1 }],
    ],
    [
      'an item both qualified and excluded',
      { items: [qualified(alphaRef), qualified(betaRef)], optional_exclusions: [betaRef] },
      [betaRef],
    ],
  ])('rejects %s', async (_label, overrides, flagged) => {
    const { port } = await happyPort(candidate(), overrides);

    const error = await rejection(prepare(port));

    expect(error.code).toBe('TRANSACTION_RECEIPT_ITEMS_INVALID');
    expect(error.items).toEqual(flagged);
  });

  it('allows an explicit exclusion only through the trusted mandatory list', async () => {
    const { port } = await happyPort(candidate(), {
      items: [qualified(alphaRef)],
      optional_exclusions: [betaRef],
    }, {
      mandatoryItems: async () => [alphaRef],
    });

    const outcome = await prepare(port);

    expect(outcome.kind).toBe('prepared');
  });

  it('rejects excluding an item the trusted list makes mandatory', async () => {
    const { port } = await happyPort(candidate(), {
      items: [qualified(betaRef)],
      optional_exclusions: [alphaRef],
    }, {
      mandatoryItems: async () => [alphaRef],
    });

    const error = await rejection(prepare(port));

    expect(error.code).toBe('TRANSACTION_RECEIPT_ITEMS_INVALID');
    expect(error.items).toEqual([alphaRef]);
  });

  it.each([
    ['a foreign mandatory item', [alphaRef, { template_id: 'tpl-one', item_id: 'ghost', item_version: 1 }]],
    ['a duplicated mandatory item', [alphaRef, alphaRef]],
  ])('rejects %s', async (_label, mandatory) => {
    const { port } = await happyPort(candidate(), {}, { mandatoryItems: async () => mandatory });

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_MANDATORY_INVALID');
  });

  it('collapses a throwing mandatory port into a stable code', async () => {
    const { port } = await happyPort(candidate(), {}, {
      mandatoryItems: async () => { throw new Error('policy password=secret'); },
    });

    const error = await rejection(prepare(port));

    expect(error.code).toBe('TRANSACTION_MANDATORY_UNAVAILABLE');
    expect(JSON.stringify(error)).not.toContain('secret');
  });
});

describe('authorization and asynchronous boundary', () => {
  it('checks authorization before the candidate read and rejects a denied grant', async () => {
    const templates = portOf([templateV1, templateV2]);
    const { port, calls } = makePort({
      authorize: async () => ({ allowed: false, cancelled: false, dependency_digest: DEP }),
    });

    const error = await rejection(prepare(port, request(), fixtureRegistry(), templates.port));

    expect(error.code).toBe('TRANSACTION_FORBIDDEN');
    expect(templates.getVersion).not.toHaveBeenCalled();
    expect(calls.currentBinding).toBe(0);
    expect(calls.getTrialReceipt).toBe(0);
  });

  it('rejects a grant revoked after the asynchronous reads (TOCTOU)', async () => {
    let checks = 0;
    const { port } = await happyPort(candidate(), {}, {
      authorize: async () => {
        checks += 1;
        return checks === 1 ? allowed() : { allowed: false, cancelled: false, dependency_digest: DEP };
      },
    });

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_FORBIDDEN');
    expect(checks).toBe(2);
  });

  it('rejects a attempt cancelled after the asynchronous reads', async () => {
    let checks = 0;
    const { port } = await happyPort(candidate(), {}, {
      authorize: async () => {
        checks += 1;
        return checks === 1 ? allowed() : { allowed: true, cancelled: true, dependency_digest: DEP };
      },
    });

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_CANCELLED');
    expect(checks).toBe(2);
  });

  it('rejects when the configuration dependency identity changes during the reads', async () => {
    let checks = 0;
    const { port } = await happyPort(candidate(), {}, {
      authorize: async () => {
        checks += 1;
        return allowed(checks === 1 ? DEP : OTHER_DEP);
      },
    });

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_DEPENDENCY_CHANGED');
  });

  it('collapses a throwing authorization port without its text', async () => {
    const { port } = makePort({
      authorize: async () => { throw new Error('grant password=secret'); },
    });

    const error = await rejection(prepare(port));

    expect(error.code).toBe('TRANSACTION_AUTH_UNAVAILABLE');
    expect(JSON.stringify(error)).not.toContain('secret');
  });
});

describe('idempotent operations', () => {
  const operation = (overrides: Partial<TrustedBindingOperation> = {}): TrustedBindingOperation => ({
    caller_key: 'caller-1', resource: { ...RESOURCE }, target_revision: 5,
    candidate_digest: '', status: 'committed', receipt_id: 'receipt-0', ...overrides,
  });

  it('replays the original committed receipt without a new revision or receipt read', async () => {
    const digest = await digestFor(candidate());
    const { port, calls } = makePort({ findOperation: async () => operation({ candidate_digest: digest }) });

    const outcome = await prepare(port);

    expect(outcome).toEqual({
      kind: 'replay', persisted: false, resource: RESOURCE, base_revision: 4, target_revision: 5,
      candidate_digest: digest,
      operation: {
        key: bindingOperationKey(RESOURCE, 5, digest),
        caller_key: 'caller-1', receipt_id: 'receipt-0', status: 'committed',
      },
    });
    expect(calls).toEqual({
      authorize: 2, currentBinding: 1, findOperation: 1, getTrialReceipt: 0, mandatoryItems: 0, serverNow: 0,
    });
  });

  it('replays an exact retry even when the current revision already equals the target', async () => {
    const digest = await digestFor(candidate());
    const { port } = makePort({
      findOperation: async () => operation({ candidate_digest: digest }),
      currentBinding: async () => ({ ...currentBinding, revision: 5 }),
    });

    expect((await prepare(port)).kind).toBe('replay');
  });

  const collisions: Array<[string, Partial<TrustedBindingOperation>]> = [
    ['another candidate digest', { candidate_digest: `sha256:${'a'.repeat(64)}` }],
    ['another resource', { resource: { type: 'instance', id: 8 } }],
    ['another target revision', { target_revision: 6 }],
    ['another caller key', { caller_key: 'caller-2' }],
  ];
  it.each(collisions)('rejects a caller-key collision with %s', async (_label, overrides) => {
    const digest = await digestFor(candidate());
    const stored = operation({ candidate_digest: digest, ...overrides });
    const { port } = makePort({ findOperation: async () => stored });

    const error = await rejection(prepare(port));

    expect(error.code).toBe('TRANSACTION_OPERATION_CONFLICT');
    expect(JSON.stringify(error)).not.toContain('instance:8');
  });

  it('asks the caller to look up an unknown original operation and never resends it', async () => {
    const digest = await digestFor(candidate());
    const { port, calls } = makePort({
      findOperation: async () => operation({ candidate_digest: digest, status: 'unknown', receipt_id: null }),
    });

    const outcome = await prepare(port);

    expect(outcome).toEqual({
      kind: 'operation_lookup_required', persisted: false, resource: RESOURCE, candidate_digest: digest,
      operation: { key: bindingOperationKey(RESOURCE, 5, digest), caller_key: 'caller-1', status: 'unknown' },
    });
    expect(calls.getTrialReceipt).toBe(0);
  });

  it('still requires current authorization before replaying a committed operation', async () => {
    const digest = await digestFor(candidate());
    let checks = 0;
    const { port } = makePort({
      findOperation: async () => operation({ candidate_digest: digest }),
      authorize: async () => {
        checks += 1;
        return checks === 1 ? allowed() : { allowed: false, cancelled: false, dependency_digest: DEP };
      },
    });

    expect((await rejection(prepare(port))).code).toBe('TRANSACTION_FORBIDDEN');
  });

  it('rejects an invalid or unreadable operation record', async () => {
    const digest = await digestFor(candidate());
    const committedWithoutReceipt = makePort({
      findOperation: async () => operation({ candidate_digest: digest, receipt_id: null }),
    });
    expect((await rejection(prepare(committedWithoutReceipt.port))).code).toBe('TRANSACTION_OPERATION_INVALID');

    const throwing = makePort({
      findOperation: async () => { throw new Error('row password=secret'); },
    });
    const error = await rejection(prepare(throwing.port));
    expect(error.code).toBe('TRANSACTION_OPERATION_UNAVAILABLE');
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('rejects when the current binding cannot be read or parsed', async () => {
    const throwing = await happyPort(candidate(), {}, {
      currentBinding: async () => { throw new Error('mysql password=secret'); },
    });
    const unavailable = await rejection(prepare(throwing.port));
    expect(unavailable.code).toBe('TRANSACTION_BINDING_UNAVAILABLE');
    expect(JSON.stringify(unavailable)).not.toContain('secret');

    const malformed = await happyPort(candidate(), {}, { currentBinding: async () => ({ revision: 4 }) });
    expect((await rejection(prepare(malformed.port))).code).toBe('TRANSACTION_BINDING_INVALID');
  });
});

describe('candidate identity digest', () => {
  it('covers every input that invalidates an old test', async () => {
    const base = await digestFor(candidate());

    expect(base).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await digestFor(candidate(), 5)).toBe(base);
    expect(await digestFor(candidate(), 6)).not.toBe(base);
    expect(await digestFor(candidate({ template_pins: [pin(templateV2)] }))).not.toBe(base);
    expect(await digestFor(candidate({ overrides: { interval_ms: { mode: 'set', value: 60000 } } }))).not.toBe(base);
    expect(await digestFor(candidate({ group_id: 'other' }))).not.toBe(base);
    expect(await digestFor(candidate({ package: legacyPackage }))).not.toBe(base);
    expect(await digestFor(candidate(), 5, OTHER_DEP)).not.toBe(base);
  });

  it('sorts only unordered sets and keeps ordered arrays intact', async () => {
    const reordered = candidate({ overrides: { b: 2, a: 1 } });
    const ordered = candidate({ overrides: { a: 1, b: 2 } });

    expect(await digestFor(reordered)).toBe(await digestFor(ordered));
    expect(await digestFor(candidate())).toBe(await digestFor(candidate()));
  });

  it('binds the digest to the exact target revision in the prepared decision', async () => {
    const { port, digest } = await happyPort();

    const outcome = await prepare(port);

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') throw new Error('unreachable');
    expect(outcome.candidate_digest).toBe(digest);
    expect(outcome.operation.key).toBe(bindingOperationKey(RESOURCE, outcome.target_revision, digest));
  });

  it('leaves every input unchanged when the guard rejects', async () => {
    const { port } = await happyPort(candidate(), { candidate_digest: `sha256:${'a'.repeat(64)}` });
    const requestValue = request();
    const requestSnapshot = structuredClone(requestValue);
    const registry = fixtureRegistry();
    const registrySnapshot = registry.list();

    await rejection(prepare(port, requestValue, registry));

    expect(requestValue).toEqual(requestSnapshot);
    expect(registry.list()).toEqual(registrySnapshot);
  });
});

/** A client-style receipt body used only to prove it is rejected in the request. */
function receiptBody() {
  return { receipt_id: 'receipt-1', candidate_digest: `sha256:${'a'.repeat(64)}`, items: [] };
}
