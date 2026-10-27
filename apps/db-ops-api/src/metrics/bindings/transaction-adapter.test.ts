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
import {
  BindingTransactionError, bindingCandidateDigest,
  type BindingTransactionErrorCode, type TrustedAuthorization, type TrustedBindingOperationV2,
} from './transaction-guard.js';
import {
  resolveTemplateBinding, templateResolutionIdentity, type TemplateResolutionContext,
} from './resolve.js';
import { compileBindingCandidate } from './compile.js';
import type { TemplateVersionReadPort } from './preflight.js';
import {
  applyTemplateBindingMutation, BindingApplicationError,
  type BindingApplicationHost, type BindingApplicationIntent,
} from './transaction-adapter.js';

const T0 = '2026-10-01T00:00:00Z';
const T1 = '2026-10-02T00:00:00Z';
const AT = '2026-09-18T00:00:00.000Z';
const NOW = '2026-10-03T00:00:00Z';
const ISSUED = '2026-10-02T12:00:00Z';
const EXPIRES = '2026-10-04T00:00:00Z';
const DEP = `sha256:${'d'.repeat(64)}`;
const OTHER_DEP = `sha256:${'e'.repeat(64)}`;
const OLD_IDENTITY = `sha256:${'a'.repeat(64)}`;
const RESOURCE = { type: 'instance' as const, id: 7 };
const legacyPackage = { id: 'legacy-package', version: '2.3.4', digest: `sha256:${'c'.repeat(64)}` };

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
const releaseRef = packageReleaseRef(releaseV1.package);

function fixtureRegistry(): PackageRegistry {
  const registry = new PackageRegistry([], [mainImpl]);
  registry.install(releaseV1);
  return registry;
}

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

const parameters = (interval: number): TemplateParameters => ({
  schema: { interval_ms: { type: 'integer', min: 1000, max: 60000 } },
  defaults: { interval_ms: interval },
});
const templateV1 = templateVersion({ items: [item('alpha-item', alpha), item('beta-item', beta)], parameters: parameters(30000) });
const templateV2 = templateVersion({
  items: [item('alpha-item', alpha), item('beta-item', beta)], version: 2, parameters: parameters(60000),
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

function candidate(overrides: Partial<ResourceBindingCandidate> = {}): ResourceBindingCandidate {
  return {
    resource: { ...RESOURCE },
    package: null,
    group_id: 'web',
    overrides: {
      interval_ms: { mode: 'set', value: 30000 },
      template_parameters: { 'tpl-one': { interval_ms: 40000 } },
    },
    revision: 4,
    template_pins: [pin(templateV1)],
    ...overrides,
  } as ResourceBindingCandidate;
}

function legacyCandidate(): ResourceBindingCandidate {
  return {
    resource: { ...RESOURCE }, package: legacyPackage, group_id: 'web', overrides: {}, revision: 4, template_pins: [],
  } as ResourceBindingCandidate;
}

const request = (overrides: Record<string, unknown> = {}) => ({
  resource: { ...RESOURCE }, candidate: candidate(), receipt_id: 'receipt-1', caller_key: 'caller-1', ...overrides,
});

const allowed = (dependency: HashId = DEP): TrustedAuthorization => ({
  allowed: true, cancelled: false, dependency_digest: dependency,
});

const trustedResource = () => ({
  type: 'instance', id: '7',
  attributes: { 'db.engine': { value: 'fixture', observed_at: AT, source: 'fixture' } },
});
const trustedGroup = (overrides: Record<string, unknown> = {}) => ({
  id: 'web', revision: 2, policy_revision: 2, overrides,
});
const supported = (...metrics: ExtensionDefinition[]) => metrics.map(definition => ({
  resource_id: '7', metric: metricRef(definition), method: 'sql' as const, status: 'supported' as const,
  basis: [{ kind: 'permission' as const, evidence: 'fixed_read_succeeded' }],
  evaluated_at: AT, valid_until: '2026-09-19T00:00:00.000Z',
}));

function applicationContext(overrides: Record<string, unknown> = {}) {
  return {
    resource: trustedResource(),
    group: trustedGroup(),
    capabilities: supported(alpha, beta),
    at: AT,
    actor_id: 9,
    application: { status: 'applied', applied_revision: 3, resolution_identity: OLD_IDENTITY },
    ...overrides,
  };
}

function resolutionContext(overrides: Record<string, unknown> = {}): TemplateResolutionContext {
  const base = applicationContext();
  return {
    resource: base.resource, group: base.group, capabilities: base.capabilities, at: base.at, ...overrides,
  };
}

const alphaRef = { template_id: 'tpl-one', item_id: 'alpha-item', item_version: 1 };
const betaRef = { template_id: 'tpl-one', item_id: 'beta-item', item_version: 1 };
const qualified = (ref: typeof alphaRef) => ({ ...ref, phases: { read: true, transform: true, unit: true } });

async function compileFor(input: unknown) {
  const compiled = await compileBindingCandidate(input, templatePort(), fixtureRegistry());
  if (compiled.kind !== 'template_candidate') throw new Error('fixture candidate must not be legacy');
  return compiled;
}
async function digestFor(input: unknown = candidate()): Promise<HashId> {
  return bindingCandidateDigest(await compileFor(input), 5, DEP);
}
async function identityFor(
  input: unknown = candidate(),
  context: TemplateResolutionContext = resolutionContext(),
): Promise<HashId> {
  const outcome = await resolveTemplateBinding(input, context, templatePort(), fixtureRegistry());
  if (outcome.kind !== 'template_resolution') throw new Error('fixture resolution must not be legacy');
  return templateResolutionIdentity(outcome);
}

const UNBOUND_DIGEST = `sha256:${'b'.repeat(64)}`;
const UNBOUND_IDENTITY = `sha256:${'9'.repeat(64)}`;

function receiptV2(overrides: Record<string, unknown> = {}) {
  return {
    receipt_version: 2,
    receipt_id: 'receipt-1',
    resource: { ...RESOURCE },
    base_revision: 4,
    target_revision: 5,
    candidate_digest: UNBOUND_DIGEST,
    resolution_identity: UNBOUND_IDENTITY,
    dependency_digest: DEP,
    issued_at: ISSUED,
    expires_at: EXPIRES,
    items: [qualified(alphaRef), qualified(betaRef)],
    optional_exclusions: [],
    ...overrides,
  };
}

async function boundReceipt(overrides: Record<string, unknown> = {}) {
  return receiptV2({
    candidate_digest: await digestFor(),
    resolution_identity: await identityFor(),
    ...overrides,
  });
}

// --- transaction fixture ----------------------------------------------------
//
// Four records are the only state: the binding payload, the operation journal,
// the receipt-consumption journal and the audit log. `stage` writes nothing
// visible; `settle` either applies all four writes atomically (committed),
// discards the staged intent (rolled_back) or applies them but reports unknown
// (the lost-response case). Write counters count only applied records, so a
// rollback is provably zero-write.

interface FixtureState {
  binding: Record<string, unknown> | null;
  operations: Map<string, TrustedBindingOperationV2>;
  consumptions: Map<string, string>;
  audits: Array<Record<string, unknown>>;
  pending: BindingApplicationIntent | null;
  intents: BindingApplicationIntent[];
  writes: { binding: number; operation: number; receipt: number; audit: number };
}

function freshState(): FixtureState {
  return {
    binding: {
      resource: { ...RESOURCE }, package: legacyPackage, group_id: 'web', overrides: {}, revision: 4, template_pins: [],
    },
    operations: new Map(), consumptions: new Map(), audits: [], pending: null, intents: [],
    writes: { binding: 0, operation: 0, receipt: 0, audit: 0 },
  };
}

const snapshot = (state: FixtureState) => structuredClone({
  binding: state.binding,
  operations: [...state.operations.entries()],
  consumptions: [...state.consumptions.entries()],
  audits: state.audits,
  writes: state.writes,
});

type CallName = 'templateVersions' | 'applicationContext' | 'authorize' | 'currentBinding'
  | 'findOperationExact' | 'findReceiptConsumption' | 'getTrialReceipt' | 'serverNow'
  | 'stageApplication' | 'settleApplication';
const defaultCalls = (): Record<CallName, number> => ({
  templateVersions: 0, applicationContext: 0, authorize: 0, currentBinding: 0,
  findOperationExact: 0, findReceiptConsumption: 0, getTrialReceipt: 0, serverNow: 0,
  stageApplication: 0, settleApplication: 0,
});

type SettleMode = 'committed' | 'rolled_back' | 'unknown' | 'invalid' | 'throw';
interface HostOptions {
  state?: FixtureState;
  /** `undefined` uses an unbound receipt; `null` simulates a missing receipt row. */
  receipt?: unknown;
  context?: Record<string, unknown>;
  authorize?: () => Promise<unknown>;
  operation?: (callerKey: string) => Promise<unknown>;
  consumption?: (receiptId: string) => Promise<unknown>;
  serverNow?: () => unknown;
  stage?: (intent: BindingApplicationIntent) => Promise<unknown>;
  settleMode?: SettleMode;
  settle?: (staged: unknown) => Promise<unknown>;
  templates?: TemplateVersionReadPort | (() => TemplateVersionReadPort);
  omit?: CallName[];
}

function makeHost(options: HostOptions = {}) {
  const state = options.state ?? freshState();
  const calls = defaultCalls();
  const settleMode = options.settleMode ?? 'committed';
  const templates = options.templates ?? templatePort();
  const receipt = options.receipt === undefined ? receiptV2() : options.receipt;

  const apply = (intent: BindingApplicationIntent): void => {
    state.binding = structuredClone(intent.binding) as unknown as Record<string, unknown>;
    state.operations.set(intent.operation.caller_key, structuredClone(intent.operation));
    state.consumptions.set(intent.receipt.receipt_id, intent.operation.caller_key);
    state.audits.push(structuredClone(intent.audit));
    state.writes.binding += 1; state.writes.operation += 1;
    state.writes.receipt += 1; state.writes.audit += 1;
  };

  const host: Record<string, unknown> = {
    templateVersions: () => {
      calls.templateVersions += 1;
      return typeof templates === 'function' ? templates() : templates;
    },
    applicationContext: async () => {
      calls.applicationContext += 1;
      return applicationContext(options.context);
    },
    authorize: async () => {
      calls.authorize += 1;
      return options.authorize ? options.authorize() : allowed();
    },
    currentBinding: async () => {
      calls.currentBinding += 1;
      return state.binding ?? null;
    },
    findOperationExact: async (callerKey: string) => {
      calls.findOperationExact += 1;
      return options.operation ? options.operation(callerKey) : { complete: true, operation: state.operations.get(callerKey) ?? null };
    },
    findReceiptConsumption: async (receiptId: string) => {
      calls.findReceiptConsumption += 1;
      return options.consumption ? options.consumption(receiptId) : { complete: true, consumed: state.consumptions.has(receiptId) };
    },
    getTrialReceipt: async () => {
      calls.getTrialReceipt += 1;
      return receipt;
    },
    serverNow: () => {
      calls.serverNow += 1;
      return options.serverNow ? options.serverNow() : NOW;
    },
    stageApplication: async (intent: BindingApplicationIntent) => {
      calls.stageApplication += 1;
      if (options.stage) return options.stage(intent);
      state.intents.push(structuredClone(intent));
      if (state.operations.has(intent.operation.caller_key)) return { status: 'rejected', code: 'OPERATION_CONFLICT' };
      if (state.consumptions.has(intent.receipt.receipt_id)) return { status: 'rejected', code: 'RECEIPT_CONSUMED' };
      if ((state.binding?.revision as number | undefined) !== intent.base_revision) {
        return { status: 'rejected', code: 'REVISION_CONFLICT' };
      }
      state.pending = structuredClone(intent);
      return { status: 'staged' };
    },
    settleApplication: async (staged: unknown) => {
      calls.settleApplication += 1;
      if (options.settle) return options.settle(staged);
      const intent = state.pending;
      if (!intent) return { status: 'rolled_back', code: 'STAGE_MISSING' };
      if (settleMode === 'throw') throw new Error('driver connection reset password=secret');
      if (settleMode === 'invalid') return { status: 'prepared' };
      if (settleMode === 'rolled_back') {
        state.pending = null;
        return { status: 'rolled_back', code: 'POLICY_STORE_UNAVAILABLE' };
      }
      if (settleMode === 'unknown') {
        // The lost-response case: the database committed, the caller saw nothing.
        apply(intent); state.pending = null;
        return { status: 'unknown' };
      }
      apply(intent); state.pending = null;
      return { status: 'committed', revision: intent.target_revision };
    },
  };
  for (const name of options.omit ?? []) delete host[name];
  return { host: host as unknown as BindingApplicationHost, state, calls };
}

async function run(options: HostOptions & { request?: unknown } = {}) {
  const fixture = makeHost(options);
  const outcome = await applyTemplateBindingMutation(
    options.request ?? request(), fixture.host, fixtureRegistry(),
  );
  return { ...fixture, outcome };
}

async function rejection(promise: Promise<unknown>): Promise<BindingTransactionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BindingTransactionError);
    return error as BindingTransactionError;
  }
  throw new Error('expected the application to reject');
}

async function hostRejection(promise: Promise<unknown>): Promise<BindingApplicationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BindingApplicationError);
    return error as BindingApplicationError;
  }
  throw new Error('expected the adapter to reject the host contract');
}

const emptyWrites = { binding: 0, operation: 0, receipt: 0, audit: 0 };

async function committedOperation(): Promise<{ digest: HashId; identity: HashId; operation: TrustedBindingOperationV2 }> {
  const digest = await digestFor();
  const identity = await identityFor();
  return {
    digest, identity,
    operation: {
      caller_key: 'caller-1', resource: { ...RESOURCE }, target_revision: 5,
      candidate_digest: digest, resolution_identity: identity, dependency_digest: DEP,
      receipt_id: 'receipt-1', status: 'committed',
    },
  };
}

describe('atomic template binding application', () => {
  it('stages and commits one complete intent binding the candidate, resolution and dependency identities', async () => {
    const input = request();
    const inputSnapshot = structuredClone(input);
    const registry = fixtureRegistry();
    const registrySnapshot = registry.list();
    const digest = await digestFor();
    const identity = await identityFor();

    const { outcome, state, calls } = await run({ receipt: await boundReceipt() });

    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') throw new Error('unreachable');
    expect(outcome.status).toBe('committed');
    expect(outcome.persisted).toBe(true);
    expect(outcome.committed).toBe(true);
    expect(outcome.revision).toBe(5);
    expect(outcome.resolution_identity).toBe(identity);
    expect(outcome.operation).toEqual({
      key: expect.stringContaining('#5@'), caller_key: 'caller-1', receipt_id: 'receipt-1', status: 'committed',
    });

    // The one staged intent carries the raw binding and the attached plan only.
    expect(state.intents).toHaveLength(1);
    const intent = state.intents[0];
    expect(intent.kind).toBe('template_binding_application');
    expect(intent.protocol).toBe('max238.binding-application.v1');
    expect(intent.resource_key).toBe('instance:7');
    expect(intent.base_revision).toBe(4);
    expect(intent.target_revision).toBe(5);
    expect(intent.binding).toEqual({ ...candidate(), revision: 5 });
    expect(intent.binding.package).toBeNull();
    expect(intent.binding.template_pins).toEqual([pin(templateV1)]);
    expect(intent.pending.resolution_identity).toBe(identity);
    expect(intent.pending.plan.kind).toBe('template_collection_plan');
    expect(intent.pending.plan.identity).toBe(identity);
    expect(intent.pending.plan.executable).toBe(true);
    expect(intent.pending.plan.releases.flatMap(entry => entry.steps)
      .flatMap(step => step.items.map(entry => entry.item_id))).toEqual(['alpha-item', 'beta-item']);
    expect(intent.pending.decided_at).toBe(NOW);
    // A pending revision preserves the previous applied state and plan identity.
    expect(intent.application).toEqual({
      status: 'pending', applied_revision: 3, previous_resolution_identity: OLD_IDENTITY,
    });
    expect(intent.operation).toEqual({
      key: expect.stringContaining('#5@'), caller_key: 'caller-1', resource: RESOURCE, target_revision: 5,
      candidate_digest: digest, resolution_identity: identity, dependency_digest: DEP,
      receipt_id: 'receipt-1', status: 'committed',
    });
    expect(intent.receipt).toEqual({
      receipt_id: 'receipt-1', operation_key: intent.operation.key, expires_at: EXPIRES,
    });
    expect(intent.audit).toEqual({
      action: 'template_binding.apply', target: 'instance:7', revision: 5, actor_id: 9,
      idempotency_key: 'caller-1', candidate_digest: digest, resolution_identity: identity,
      dependency_digest: DEP, receipt_id: 'receipt-1', at: NOW,
    });

    // Exactly one write of each record, and the four-state fixture is consistent.
    expect(state.writes).toEqual({ binding: 1, operation: 1, receipt: 1, audit: 1 });
    expect(state.binding).toEqual({ ...candidate(), revision: 5 });
    expect([...state.operations.values()]).toEqual([intent.operation]);
    expect([...state.consumptions.entries()]).toEqual([['receipt-1', 'caller-1']]);
    expect(state.audits).toEqual([intent.audit]);
    expect(calls.stageApplication).toBe(1);
    expect(calls.settleApplication).toBe(1);
    expect(calls.templateVersions).toBe(1);
    expect(calls.getTrialReceipt).toBe(1);
    expect(calls.findReceiptConsumption).toBe(1);
    expect(calls.findOperationExact).toBe(1);

    expect(input).toEqual(inputSnapshot);
    expect(registry.list()).toEqual(registrySnapshot);
  });

  it('preserves a null previous application instead of inventing an applied revision', async () => {
    const { outcome, state } = await run({
      receipt: await boundReceipt(),
      context: { application: null },
    });

    expect(outcome.kind).toBe('committed');
    expect(state.intents[0].application).toEqual({
      status: 'pending', applied_revision: null, previous_resolution_identity: null,
    });
  });

  it('does not touch the transaction view, journal or audit for a legacy candidate', async () => {
    const { outcome, state, calls } = await run({ request: request({ candidate: legacyCandidate() }) });

    expect(outcome).toEqual({ kind: 'legacy_delegate', binding: legacyCandidate(), package: legacyPackage });
    expect(calls.stageApplication).toBe(0);
    expect(calls.settleApplication).toBe(0);
    expect(calls.applicationContext).toBe(0);
    expect(calls.findOperationExact).toBe(0);
    expect(calls.getTrialReceipt).toBe(0);
    expect(state.writes).toEqual(emptyWrites);
  });

  it.each([
    ['a resolution identity', { resolution_identity: OLD_IDENTITY }],
    ['a dependency digest', { dependency_digest: DEP }],
    ['a receipt body', { receipt: receiptV2() }],
    ['a candidate digest', { candidate_digest: UNBOUND_DIGEST }],
    ['a preview mode', { mode: 'preview' }],
  ])('rejects a request that tries to supply %s', async (_label, overrides) => {
    const fixture = makeHost({ receipt: await boundReceipt() });

    const error = await rejection(applyTemplateBindingMutation(
      request(overrides), fixture.host, fixtureRegistry(),
    ));

    expect(error.code).toBe('TRANSACTION_INPUT_INVALID');
    expect(fixture.calls.stageApplication).toBe(0);
    expect(fixture.state.writes).toEqual(emptyWrites);
  });
});

describe('exact replay and unknown operations', () => {
  it('replays a committed operation without staging even when the receipt expired and the revision advanced', async () => {
    const { operation } = await committedOperation();
    const state = freshState();
    state.binding = { ...state.binding!, revision: 6 };
    state.operations.set('caller-1', operation);
    const before = snapshot(state);

    const { outcome, calls } = await run({ state, receipt: null });

    expect(outcome.kind).toBe('replay');
    if (outcome.kind !== 'replay') throw new Error('unreachable');
    expect(outcome.persisted).toBe(false);
    expect(outcome.operation).toEqual({
      key: expect.stringContaining('#5@'), caller_key: 'caller-1', receipt_id: 'receipt-1', status: 'committed',
    });
    expect(calls.stageApplication).toBe(0);
    expect(calls.getTrialReceipt).toBe(0);
    expect(snapshot(state)).toEqual(before);
  });

  it('returns an unknown operation for lookup without staging or resending', async () => {
    const { operation } = await committedOperation();
    const state = freshState();
    state.operations.set('caller-1', { ...operation, status: 'unknown', receipt_id: null });
    const before = snapshot(state);

    const { outcome, calls } = await run({ state });

    expect(outcome.kind).toBe('operation_lookup_required');
    expect(calls.stageApplication).toBe(0);
    expect(calls.settleApplication).toBe(0);
    expect(snapshot(state)).toEqual(before);
  });

  it.each([
    ['the receipt', { receipt_id: 'receipt-other' }],
    ['the resource', { resource: { type: 'instance', id: 8 } }],
    ['the target revision', { target_revision: 6 }],
    ['the candidate digest', { candidate_digest: UNBOUND_DIGEST }],
    ['the resolution identity', { resolution_identity: UNBOUND_IDENTITY }],
    ['the dependency digest', { dependency_digest: OTHER_DEP }],
  ])('treats the same caller key reused across %s as a collision, not a replay', async (_label, overrides) => {
    const { operation } = await committedOperation();
    const state = freshState();
    state.operations.set('caller-1', { ...operation, ...overrides } as TrustedBindingOperationV2);
    const before = snapshot(state);
    const fixture = makeHost({ state, receipt: await boundReceipt() });

    const error = await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()));

    expect(error.code).toBe('TRANSACTION_OPERATION_CONFLICT');
    expect(fixture.calls.stageApplication).toBe(0);
    expect(snapshot(state)).toEqual(before);
  });

  it.each([
    ['a missing exact lookup port', { omit: ['findOperationExact'] as CallName[] }, 'TRANSACTION_OPERATION_UNAVAILABLE'],
    ['a bare null lookup', { operation: async () => null }, 'TRANSACTION_OPERATION_UNAVAILABLE'],
    ['a lookup without a completeness assertion', { operation: async () => ({ operation: null }) }, 'TRANSACTION_OPERATION_UNAVAILABLE'],
    ['a lookup that admits it is incomplete', { operation: async () => ({ complete: false, operation: null }) }, 'TRANSACTION_OPERATION_UNAVAILABLE'],
    ['a v1 operation record without a resolution identity', {
      operation: async () => ({ complete: true, operation: {
        caller_key: 'caller-1', resource: { ...RESOURCE }, target_revision: 5,
        candidate_digest: UNBOUND_DIGEST, dependency_digest: DEP,
        receipt_id: 'receipt-1', status: 'committed',
      } }),
    }, 'TRANSACTION_OPERATION_INVALID'],
  ])('rejects %s instead of assuming a fresh operation', async (_label, options, code) => {
    const fixture = makeHost({ ...(options as HostOptions), receipt: await boundReceipt() });

    const error = await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()));

    expect(error.code).toBe(code as BindingTransactionErrorCode);
    expect(fixture.calls.stageApplication).toBe(0);
    expect(fixture.state.writes).toEqual(emptyWrites);
  });
});

describe('receipt v2, consumption and trusted time', () => {
  it.each([
    ['a v1 receipt without a protocol version', { receipt_version: undefined }, 'TRANSACTION_RECEIPT_INVALID'],
    ['a receipt bound to another resolution', { resolution_identity: UNBOUND_IDENTITY }, 'TRANSACTION_RECEIPT_MISMATCH'],
    ['a receipt bound to another dependency', { dependency_digest: OTHER_DEP }, 'TRANSACTION_RECEIPT_MISMATCH'],
    ['an expired receipt', { expires_at: '2026-10-02T18:00:00Z' }, 'TRANSACTION_RECEIPT_EXPIRED'],
    ['a receipt issued in the future', { issued_at: '2026-10-05T00:00:00Z' }, 'TRANSACTION_RECEIPT_TIME_INVALID'],
  ])('rejects %s before any staging', async (_label, receiptOverrides, code) => {
    const fixture = makeHost({ receipt: await boundReceipt(receiptOverrides) });

    const error = await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()));

    expect(error.code).toBe(code as BindingTransactionErrorCode);
    expect(fixture.calls.stageApplication).toBe(0);
    expect(fixture.state.writes).toEqual(emptyWrites);
  });

  it('rejects a receipt already consumed by a complete exact lookup', async () => {
    const fixture = makeHost({
      receipt: await boundReceipt(),
      consumption: async () => ({ complete: true, consumed: true }),
    });

    const error = await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()));

    expect(error.code).toBe('TRANSACTION_RECEIPT_CONSUMED');
    expect(fixture.calls.stageApplication).toBe(0);
    expect(fixture.state.writes).toEqual(emptyWrites);
  });

  it.each([
    ['a missing consumption port', { omit: ['findReceiptConsumption'] as CallName[] }, 'TRANSACTION_RECEIPT_UNAVAILABLE'],
    ['an incomplete consumption answer', { consumption: async () => ({ consumed: false }) }, 'TRANSACTION_RECEIPT_UNAVAILABLE'],
    ['a throwing consumption port', {
      consumption: async () => { throw new Error('driver password=secret'); },
    }, 'TRANSACTION_RECEIPT_UNAVAILABLE'],
  ])('rejects %s instead of assuming the receipt is unused', async (_label, options, code) => {
    const fixture = makeHost({ ...(options as HostOptions), receipt: await boundReceipt() });

    const error = await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()));

    expect(error.code).toBe(code as BindingTransactionErrorCode);
    expect(fixture.state.writes).toEqual(emptyWrites);
  });

  it.each([
    ['a promise-valued trusted clock', () => Promise.resolve(NOW)],
    ['an unparseable trusted clock', () => 'not-a-time'],
    ['an empty trusted clock', () => undefined],
  ])('rejects %s without a decision', async (_label, serverNow) => {
    const fixture = makeHost({ receipt: await boundReceipt(), serverNow });

    const error = await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()));

    expect(error.code).toBe('TRANSACTION_TIME_UNAVAILABLE');
    expect(fixture.calls.stageApplication).toBe(0);
  });
});

describe('trusted authorization, dependencies and B2C invalidation', () => {
  it('rejects a revoked grant before any read', async () => {
    const fixture = makeHost({ authorize: async () => ({ ...allowed(), allowed: false }) });

    expect((await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()))).code)
      .toBe('TRANSACTION_FORBIDDEN');
    expect(fixture.state.writes).toEqual(emptyWrites);
  });

  it('rejects a cancellation before any read', async () => {
    const fixture = makeHost({ authorize: async () => ({ ...allowed(), cancelled: true }) });

    expect((await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()))).code)
      .toBe('TRANSACTION_CANCELLED');
  });

  it('rejects when the grant is revoked during the asynchronous work', async () => {
    let calls = 0;
    const fixture = makeHost({
      receipt: await boundReceipt(),
      authorize: async () => (++calls === 1 ? allowed() : { ...allowed(), allowed: false }),
    });

    expect((await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()))).code)
      .toBe('TRANSACTION_FORBIDDEN');
    expect(fixture.calls.stageApplication).toBe(0);
  });

  it('rejects when the trusted dependency identity changes during the asynchronous work', async () => {
    let calls = 0;
    const fixture = makeHost({
      receipt: await boundReceipt(),
      authorize: async () => (++calls === 1 ? allowed() : allowed(OTHER_DEP)),
    });

    expect((await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()))).code)
      .toBe('TRANSACTION_DEPENDENCY_CHANGED');
    expect(fixture.calls.stageApplication).toBe(0);
  });

  it('rejects a receipt whose resolution identity changed with group settings', async () => {
    const fixture = makeHost({
      receipt: await boundReceipt(),
      // The receipt was issued for an empty group override set; the resource layer
      // does not shadow this setting, so only the group layer can change it.
      context: { group: trustedGroup({ stale_after_ms: { mode: 'set', value: 180000 } }) },
    });

    expect((await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()))).code)
      .toBe('TRANSACTION_RECEIPT_MISMATCH');
    expect(fixture.calls.stageApplication).toBe(0);
  });

  it('rejects a receipt whose resolution identity changed with the capability evidence', async () => {
    const changed = supported(alpha, beta).map(capability => ({
      ...capability, basis: [{ kind: 'permission' as const, evidence: 'fixed_read_succeeded_v2' }],
    }));
    const fixture = makeHost({ receipt: await boundReceipt(), context: { capabilities: changed } });

    expect((await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()))).code)
      .toBe('TRANSACTION_RECEIPT_MISMATCH');
  });

  it('rejects a receipt whose resolved parameters changed', async () => {
    const changed = candidate({
      overrides: {
        interval_ms: { mode: 'set', value: 30000 },
        template_parameters: { 'tpl-one': { interval_ms: 50000 } },
      },
    });
    // The receipt binds the new candidate digest but the old resolved parameters.
    const fixture = makeHost({ receipt: receiptV2({ candidate_digest: await digestFor(changed), resolution_identity: await identityFor() }) });

    expect((await rejection(applyTemplateBindingMutation(request({ candidate: changed }), fixture.host, fixtureRegistry()))).code)
      .toBe('TRANSACTION_RECEIPT_MISMATCH');
    expect(fixture.calls.stageApplication).toBe(0);
  });

  it('blocks an unsupported or unknown capability instead of staging an enable', async () => {
    const fixture = makeHost({ context: { capabilities: supported(alpha) } });

    const error = await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()));

    expect(error.code).toBe('TRANSACTION_RESOLUTION_BLOCKED');
    expect(error.items).toEqual([betaRef]);
    expect(fixture.calls.stageApplication).toBe(0);
    expect(fixture.calls.getTrialReceipt).toBe(0);
  });

  it('rejects an explicit settings disable through the enable entry', async () => {
    const fixture = makeHost({ context: { group: trustedGroup({ enabled: 'disable' }) } });

    expect((await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()))).code)
      .toBe('TRANSACTION_RESOLUTION_DISABLED');
    expect(fixture.calls.stageApplication).toBe(0);
  });

  it('rejects an enable whose selected metrics are all disabled', async () => {
    const allDisabled = candidate({
      overrides: {
        interval_ms: { mode: 'set', value: 30000 },
        template_parameters: { 'tpl-one': { interval_ms: 40000 } },
        metrics: { 'fixture.alpha@1.0.0': 'disable', 'fixture.beta@1.0.0': 'disable' },
      },
    });
    const fixture = makeHost({});

    expect((await rejection(applyTemplateBindingMutation(
      request({ candidate: allDisabled }), fixture.host, fixtureRegistry(),
    ))).code).toBe('TRANSACTION_RESOLUTION_EMPTY');
    expect(fixture.calls.stageApplication).toBe(0);
  });

  it('rejects a stale base revision before any resolution or receipt read', async () => {
    const state = freshState();
    state.binding = { ...state.binding!, revision: 5 };
    const fixture = makeHost({ state, receipt: await boundReceipt() });

    expect((await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()))).code)
      .toBe('TRANSACTION_REVISION_CONFLICT');
    expect(fixture.calls.applicationContext).toBe(0);
    expect(fixture.calls.getTrialReceipt).toBe(0);
    expect(fixture.state.writes).toEqual(emptyWrites);
  });

  it('rejects a missing current binding instead of inventing a base revision', async () => {
    const state = freshState();
    state.binding = null;
    const fixture = makeHost({ state, receipt: await boundReceipt() });

    expect((await rejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()))).code)
      .toBe('TRANSACTION_BINDING_MISSING');
    expect(fixture.state.writes).toEqual(emptyWrites);
  });
});

describe('atomic staging and host settlement', () => {
  it('reports an explicit staging rejection with zero writes when a concurrent duplicate wins', async () => {
    const state = freshState();
    const fixture = makeHost({
      state,
      receipt: await boundReceipt(),
      // A concurrent caller inserts the same key after the guard's exact lookup.
      stage: async () => ({ status: 'rejected', code: 'OPERATION_CONFLICT' }),
    });
    const before = snapshot(state);

    const outcome = await applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry());

    expect(outcome).toEqual({
      kind: 'rejected', status: 'rejected', persisted: false, committed: false, code: 'OPERATION_CONFLICT',
    });
    expect(fixture.calls.settleApplication).toBe(0);
    expect(snapshot(state)).toEqual(before);
  });

  it('reports an uncertain staging failure as unknown and never resends', async () => {
    const state = freshState();
    const fixture = makeHost({
      state,
      receipt: await boundReceipt(),
      stage: async () => { throw new Error('driver password=secret'); },
    });
    const before = snapshot(state);

    const outcome = await applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry());

    expect(outcome.kind).toBe('commit_unknown');
    if (outcome.kind !== 'commit_unknown') throw new Error('unreachable');
    expect(outcome.cause).toBe('stage_unavailable');
    expect(outcome.lookup).toBe(true);
    expect(outcome.committed).toBe('unknown');
    expect(JSON.stringify(outcome)).not.toContain('secret');
    expect(fixture.calls.settleApplication).toBe(0);
    expect(snapshot(state)).toEqual(before);
  });

  it('never treats a staging acknowledgement as committed', async () => {
    const fixture = makeHost({ receipt: await boundReceipt(), stage: async () => ({ status: 'ok' }) });

    const outcome = await applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry());

    expect(outcome.kind).toBe('commit_unknown');
    expect(outcome).not.toHaveProperty('committed', true);
  });

  it('reports a host rollback with zero applied writes and no leftover staged intent', async () => {
    const state = freshState();
    const fixture = makeHost({ state, receipt: await boundReceipt(), settleMode: 'rolled_back' });
    const before = snapshot(state);

    const outcome = await applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry());

    expect(outcome).toEqual({
      kind: 'rolled_back', status: 'rolled_back', persisted: false, committed: false, code: 'POLICY_STORE_UNAVAILABLE',
    });
    expect(state.pending).toBeNull();
    expect(snapshot(state)).toEqual(before);
  });

  it('returns the unknown-operation lookup when the host lost the commit response', async () => {
    const state = freshState();
    const fixture = makeHost({ state, receipt: await boundReceipt(), settleMode: 'unknown' });

    const outcome = await applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry());

    expect(outcome.kind).toBe('commit_unknown');
    if (outcome.kind !== 'commit_unknown') throw new Error('unreachable');
    expect(outcome.cause).toBe('host_reported_unknown');
    expect(outcome.operation).toEqual({
      key: expect.stringContaining('#5@'), caller_key: 'caller-1', status: 'unknown',
    });
    // The host may have committed; the adapter neither claims success nor writes again.
    expect(fixture.calls.stageApplication).toBe(1);
    expect(fixture.calls.settleApplication).toBe(1);
    expect(state.writes).toEqual({ binding: 1, operation: 1, receipt: 1, audit: 1 });
  });

  it.each([
    ['a prepared acknowledgement instead of a settlement', 'invalid', 'settle_invalid'],
    ['a throwing settlement', 'throw', 'settle_unavailable'],
  ] as const)('reports %s as unknown, never committed', async (_label, settleMode, cause) => {
    const state = freshState();
    const fixture = makeHost({ state, receipt: await boundReceipt(), settleMode });

    const outcome = await applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry());

    expect(outcome.kind).toBe('commit_unknown');
    if (outcome.kind !== 'commit_unknown') throw new Error('unreachable');
    expect(outcome.cause).toBe(cause);
    expect(fixture.calls.stageApplication).toBe(1);
  });

  it('reports a committed settlement for another revision as unknown, not success', async () => {
    const fixture = makeHost({
      receipt: await boundReceipt(),
      settle: async () => ({ status: 'committed', revision: 6 }),
    });

    const outcome = await applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry());

    expect(outcome.kind).toBe('commit_unknown');
    if (outcome.kind !== 'commit_unknown') throw new Error('unreachable');
    expect(outcome.cause).toBe('settle_invalid');
    expect(fixture.calls.stageApplication).toBe(1);
  });

  it.each([
    ['a missing staging method', { omit: ['stageApplication'] as CallName[] }],
    ['a missing settlement method', { omit: ['settleApplication'] as CallName[] }],
    ['a missing template reader', { omit: ['templateVersions'] as CallName[] }],
  ])('refuses to run with %s', async (_label, options) => {
    const fixture = makeHost({ ...(options as HostOptions), receipt: await boundReceipt() });

    const error = await hostRejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()));

    expect(error.code).toBe('APPLICATION_HOST_UNAVAILABLE');
    expect(fixture.state.writes).toEqual(emptyWrites);
  });

  it('rejects a template reader that is not bound to the transaction view', async () => {
    const fixture = makeHost({
      receipt: await boundReceipt(),
      templates: () => ({} as TemplateVersionReadPort),
    });

    const error = await hostRejection(applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry()));

    expect(error.code).toBe('APPLICATION_TEMPLATE_READER_UNAVAILABLE');
    expect(fixture.state.writes).toEqual(emptyWrites);
  });

  it('reads template versions through the host reader, not a caller snapshot', async () => {
    const hostPort = portOf([templateV1, templateV2]);
    const fixture = makeHost({ receipt: await boundReceipt(), templates: hostPort.port });

    const outcome = await applyTemplateBindingMutation(request(), fixture.host, fixtureRegistry());

    expect(outcome.kind).toBe('committed');
    expect(hostPort.getVersion).toHaveBeenCalled();
    expect(fixture.calls.templateVersions).toBe(1);
  });
});
