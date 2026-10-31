import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type {
  CollectorDefinition, DerivedMetric, MetricDefinition,
} from '../../contracts/metrics/index.js';
import type {
  HashId, PackageCompositionEntry, ResourceBindingCandidate, SourceChain, TemplateItemVersion,
  TemplateParameters, TemplatePin, TemplateVersion, VersionNumber,
} from '../../contracts/metrics/templates.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from '../packages/model.js';
import { resolvePolicy } from '../policy/resolver.js';
import { packageReleaseRef, templateContentHash, type MetricRef } from '../templates/model.js';
import {
  BindingTransactionError, bindingCandidateDigest,
  type BindingTransactionErrorCode, type TrustedAuthorization,
} from './transaction-guard.js';
import { resolveTemplateBinding, templateResolutionIdentity, type TemplateResolutionContext } from './resolve.js';
import { compileBindingCandidate } from './compile.js';
import type { TemplateVersionReadPort } from './preflight.js';
import { BindingPersistenceError, decodeBindingPayload } from './persistence-codec.js';
import {
  BindingHostError, MYSQL_BINDING_HOST_SQL, MysqlBindingHost,
  type BindingSqlConnection, type BindingSqlPool, type TrustedBindingInputs,
} from './mysql-host.js';

const T0 = '2026-10-01T00:00:00Z';
const T1 = '2026-10-02T00:00:00Z';
const AT = '2026-09-18T00:00:00.000Z';
const NOW = '2026-10-03T00:00:00Z';
const ISSUED = '2026-10-02T12:00:00Z';
const EXPIRES = '2026-10-04T00:00:00Z';
const DEP = `sha256:${'d'.repeat(64)}`;
const RESOURCE = { type: 'instance' as const, id: 7 };
const RESOURCE_KEY = 'instance:7';

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
/** The existing single-package row pins this exact release, so its `resolved` is real. */
const legacyPackage = {
  id: releaseV1.package.id, version: releaseV1.package.version, digest: releaseV1.package.digest,
};

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
  evaluated_at: AT, valid_until: '2026-10-05T00:00:00.000Z',
}));

/** The trusted factory's same-connection view; the host adds the stored application state. */
const trustedContext = () => ({
  resource: trustedResource(), group: trustedGroup(), capabilities: supported(alpha, beta),
  at: AT, actor_id: 9,
});

function resolutionContext(overrides: Record<string, unknown> = {}): TemplateResolutionContext {
  const base = trustedContext();
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

function receiptV2(overrides: Record<string, unknown> = {}) {
  return {
    receipt_version: 2,
    receipt_id: 'receipt-1',
    resource: { ...RESOURCE },
    base_revision: 4,
    target_revision: 5,
    candidate_digest: `sha256:${'b'.repeat(64)}`,
    resolution_identity: `sha256:${'9'.repeat(64)}`,
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

// --- fault-injecting SQL fixture -------------------------------------------
//
// A tiny in-memory model of the four tables and of one MySQL connection. It
// records every statement with its connection id and real parameters, enforces
// the two operation unique constraints, models commit/rollback and lets a test
// fail any point before or after a write. It proves the SQL/param/lifecycle
// contract only; it is not MySQL.

type FaultMode =
  | 'throw' | 'throw-after' | 'missing' | 'two-rows' | 'cas-zero'
  | 'conflict-caller' | 'conflict-receipt' | 'conflict-insert' | 'apply-throw';
type Faults = Record<string, FaultMode | undefined>;

interface OperationRecord {
  caller_key: string;
  receipt_id: string;
  resource_type: string;
  resource_id: number;
  resource_key: string;
  target_revision: number;
  candidate_digest: string;
  resolution_identity: string;
  dependency_digest: string;
  status: string;
}
interface BindingRow { payload: string; group_id: string; capabilities: string }
interface AuditRecord { target: string; payload: string }
interface SqlEvent { connection: number; at: string; sql: string | null; params: unknown[] }
interface TxState {
  bindings: Map<string, BindingRow>;
  operations: OperationRecord[];
  receipts: Map<string, unknown>;
  audits: AuditRecord[];
  pending: { binding: number; operation: number; audit: number };
}

const SQL_KEYS = Object.entries(MYSQL_BINDING_HOST_SQL) as Array<[string, string]>;
const sqlKeyOf = (sql: string): string | null => {
  for (const [key, statement] of SQL_KEYS) if (statement === sql) return key;
  return null;
};
const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  throw new Error('fixture: expected a string or UTF-8 buffer parameter');
};
const duplicateEntry = (): Error => Object.assign(new Error('fixture duplicate entry'), { code: 'ER_DUP_ENTRY' });

function cloneBindings(source: Map<string, BindingRow>): Map<string, BindingRow> {
  return new Map([...source].map(([key, row]) => [key, { ...row }]));
}

const operationColumns = (record: OperationRecord) => ({ ...record });

class FakeDatabase {
  bindings = new Map<string, BindingRow>();
  operations: OperationRecord[] = [];
  receipts = new Map<string, unknown>();
  audits: AuditRecord[] = [];
  writes = { binding: 0, operation: 0, audit: 0 };
  log: SqlEvent[] = [];
  events: string[] = [];
  connections: FakeSqlConnection[] = [];
  nextConnection = 1;

  seed(published: Record<string, unknown> = legacyPublished()): void {
    this.bindings.set(RESOURCE_KEY, {
      payload: JSON.stringify(published), group_id: 'web', capabilities: '[{"kept":true}]',
    });
  }
  eventNames(): string[] { return this.log.map(entry => entry.at); }
  connectionIds(): number[] { return [...new Set(this.log.map(entry => entry.connection))]; }
}

class FakeSqlConnection implements BindingSqlConnection {
  readonly id: number;
  state: 'new' | 'open' | 'committed' | 'rolled_back' | 'released' | 'destroyed' = 'new';
  private tx: TxState | null = null;

  constructor(private readonly db: FakeDatabase, private readonly faults: Faults) {
    this.id = db.nextConnection++;
    db.connections.push(this);
  }

  private mode(at: string): FaultMode | undefined { return this.faults[at]; }
  private record(at: string, params: unknown[] = [], sql: string | null = null): void {
    this.db.log.push({ connection: this.id, at, sql, params });
    this.db.events.push(`${this.id}:${at}`);
  }
  private openTx(): TxState {
    if (this.state !== 'open' || this.tx === null) throw new Error('fixture: statement outside an open transaction');
    return this.tx;
  }
  /** Reads are allowed in a transaction or (autocommit) before one begins. */
  private readState(): TxState {
    if (this.state === 'open' && this.tx !== null) return this.tx;
    // Autocommit reads before a transaction and after a confirmed rollback.
    if (this.state === 'new' || this.state === 'rolled_back') {
      return {
        bindings: this.db.bindings, operations: this.db.operations,
        receipts: this.db.receipts, audits: this.db.audits,
        pending: { binding: 0, operation: 0, audit: 0 },
      };
    }
    throw new Error('fixture: statement outside an open transaction');
  }

  async beginTransaction(): Promise<void> {
    this.record('begin');
    if (this.mode('begin') === 'throw') throw new Error('fixture begin failed');
    if (this.state !== 'new') throw new Error('fixture: transaction already begun');
    this.state = 'open';
    this.tx = {
      bindings: cloneBindings(this.db.bindings),
      operations: structuredClone(this.db.operations),
      receipts: new Map([...this.db.receipts].map(([key, value]) => [key, structuredClone(value)])),
      audits: structuredClone(this.db.audits),
      pending: { binding: 0, operation: 0, audit: 0 },
    };
  }

  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    const key = sqlKeyOf(sql);
    if (key === null) throw new Error(`fixture: unexpected SQL ${sql}`);
    this.record(key, params, sql);
    const mode = this.mode(key);
    const isRead = ['lock', 'bindingRead', 'bindingLock', 'receiptRead', 'operationRead', 'consumptionRead'].includes(key);
    const tx = isRead ? this.readState() : this.openTx();
    switch (key) {
      case 'lock': {
        if (mode === 'throw') throw new Error('fixture lock failed');
        if (mode === 'missing') return [[], []];
        if (mode === 'two-rows') return [[{ id: 1 }, { id: 1 }], []];
        return [[{ id: 1 }], []];
      }
      case 'bindingRead':
      case 'bindingLock': {
        if (mode === 'throw') throw new Error('fixture binding read failed');
        const row = tx.bindings.get(textOf(params[0]));
        return [row === undefined ? [] : [{ payload: row.payload }], []];
      }
      case 'receiptRead': {
        if (mode === 'throw') throw new Error('fixture receipt read failed');
        const value = tx.receipts.get(textOf(params[0]));
        return [value === undefined ? [] : [{ payload: JSON.stringify(value) }], []];
      }
      case 'operationRead': {
        if (mode === 'throw') throw new Error('fixture operation read failed');
        const caller = textOf(params[0]);
        return [tx.operations.filter(entry => entry.caller_key === caller).slice(0, 2).map(operationColumns), []];
      }
      case 'consumptionRead': {
        if (mode === 'throw') throw new Error('fixture consumption read failed');
        const receipt = textOf(params[0]);
        return [tx.operations.filter(entry => entry.receipt_id === receipt)
          .slice(0, 2).map(entry => ({ caller_key: entry.caller_key })), []];
      }
      case 'operationInsert': {
        const record: OperationRecord = {
          caller_key: textOf(params[0]), receipt_id: textOf(params[1]), resource_type: textOf(params[2]),
          resource_id: Number(params[3]), resource_key: textOf(params[4]), target_revision: Number(params[5]),
          candidate_digest: textOf(params[6]), resolution_identity: textOf(params[7]),
          dependency_digest: textOf(params[8]), status: textOf(params[9]),
        };
        if (mode === 'throw') throw new Error('fixture operation insert failed');
        if (mode === 'conflict-caller') {
          // A concurrent writer committed under this caller key after the guard read.
          this.db.operations.push({ ...record, receipt_id: 'concurrent-receipt' });
          throw duplicateEntry();
        }
        if (mode === 'conflict-receipt') {
          // A concurrent writer consumed this receipt after the guard read.
          this.db.operations.push({ ...record, caller_key: 'concurrent-caller' });
          throw duplicateEntry();
        }
        if (tx.operations.some(entry => entry.caller_key === record.caller_key || entry.receipt_id === record.receipt_id)) {
          throw duplicateEntry();
        }
        tx.operations.push(record);
        tx.pending.operation += 1;
        if (mode === 'throw-after') throw new Error('fixture operation insert failed after write');
        return [{ affectedRows: 1 }, []];
      }
      case 'bindingUpdate': {
        if (mode === 'throw') throw new Error('fixture binding update failed');
        if (mode === 'cas-zero') return [{ affectedRows: 0 }, []];
        const key = textOf(params[2]);
        const baseRevision = Number(params[3]);
        const row = tx.bindings.get(key);
        if (row === undefined) return [{ affectedRows: 0 }, []];
        const stored = JSON.parse(row.payload) as { binding?: { revision?: unknown } };
        if (stored.binding?.revision !== baseRevision) return [{ affectedRows: 0 }, []];
        tx.bindings.set(key, { ...row, payload: textOf(params[0]), group_id: textOf(params[1]) });
        tx.pending.binding += 1;
        if (mode === 'throw-after') throw new Error('fixture binding update failed after write');
        return [{ affectedRows: 1 }, []];
      }
      case 'bindingInsert': {
        if (mode === 'throw') throw new Error('fixture binding insert failed');
        const key = textOf(params[0]);
        const row: BindingRow = { payload: textOf(params[1]), group_id: textOf(params[2]), capabilities: textOf(params[3]) };
        // The primary key is the CAS for a first binding.
        if (tx.bindings.has(key)) throw duplicateEntry();
        if (mode === 'conflict-insert') {
          // A concurrent client created this row after the guard's absent read.
          tx.bindings.set(key, row);
          throw duplicateEntry();
        }
        tx.bindings.set(key, row);
        tx.pending.binding += 1;
        if (mode === 'throw-after') throw new Error('fixture binding insert failed after write');
        return [{ affectedRows: 1 }, []];
      }
      case 'auditInsert': {
        if (mode === 'throw') throw new Error('fixture audit insert failed');
        tx.audits.push({ target: textOf(params[0]), payload: textOf(params[1]) });
        tx.pending.audit += 1;
        if (mode === 'throw-after') throw new Error('fixture audit insert failed after write');
        return [{ affectedRows: 1 }, []];
      }
      default:
        throw new Error(`fixture: no handler for ${key}`);
    }
  }

  async commit(): Promise<void> {
    this.record('commit');
    const tx = this.openTx();
    const mode = this.mode('commit');
    if (mode === 'apply-throw') { this.apply(tx); throw new Error('fixture commit acknowledgement lost'); }
    if (mode === 'throw') throw new Error('fixture commit failed');
    this.apply(tx);
    this.state = 'committed';
  }

  async rollback(): Promise<void> {
    this.record('rollback');
    if (this.state !== 'open') throw new Error('fixture: rollback outside a transaction');
    if (this.mode('rollback') === 'throw') throw new Error('fixture rollback failed');
    this.tx = null;
    this.state = 'rolled_back';
  }

  release(): void {
    this.record('release');
    this.state = 'released';
  }

  destroy(): void {
    this.record('destroy');
    this.state = 'destroyed';
  }

  private apply(tx: TxState): void {
    this.db.bindings = cloneBindings(tx.bindings);
    this.db.operations = structuredClone(tx.operations);
    this.db.audits = structuredClone(tx.audits);
    this.db.writes.binding += tx.pending.binding;
    this.db.writes.operation += tx.pending.operation;
    this.db.writes.audit += tx.pending.audit;
    this.tx = null;
  }
}

// --- rows and the host under test ------------------------------------------

/**
 * The actual `Resolved` `resolvePolicy` writes for this resource's single-package
 * row. A thinner look-alike would not prove the stored effective snapshot, so
 * every successful row fixture carries the real value.
 */
function legacyResolved() {
  return resolvePolicy(
    fixtureRegistry(),
    { resource: { ...RESOURCE }, package: legacyPackage, group_id: 'web', overrides: {}, revision: 4 },
    trustedGroup(),
    trustedResource() as never,
    supported(alpha, beta),
    AT,
  );
}

function legacyPublished(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    binding: {
      resource: { ...RESOURCE }, package: legacyPackage, group_id: 'web', overrides: {},
      revision: 4, template_pins: [],
    },
    resolved: legacyResolved(),
    published_at: T1,
    application: { applied_revision: 4, reported_at: T1, status: 'applied', error_code: null },
    ...overrides,
  };
}

interface HostSetup {
  faults?: Faults;
  omit?: 'mandatoryItems' | 'trustedInputs';
  now?: () => unknown;
  pool?: BindingSqlPool | null;
}

function makeHost(db: FakeDatabase, setup: HostSetup = {}) {
  const faults = setup.faults ?? {};
  const factoryConnections: number[] = [];
  const pool: BindingSqlPool = {
    async getConnection() {
      if (faults.getConnection === 'throw') throw new Error('fixture connection unavailable');
      return new FakeSqlConnection(db, faults);
    },
  };
  const inputs: TrustedBindingInputs = {
    authorize: async () => allowed(),
    applicationContext: async () => trustedContext(),
    mandatoryItems: async () => [],
    templateVersions: () => templatePort(),
  };
  if (setup.omit === 'mandatoryItems') delete (inputs as unknown as Record<string, unknown>).mandatoryItems;
  const host = new MysqlBindingHost({
    pool: () => (setup.pool === undefined ? pool : setup.pool),
    trustedInputs: connection => {
      factoryConnections.push((connection as FakeSqlConnection).id);
      return inputs;
    },
    trustedNow: setup.now ?? (() => NOW),
  });
  return { host, factoryConnections, pool };
}

async function seededDb(options: { published?: Record<string, unknown>; receipt?: unknown } = {}): Promise<FakeDatabase> {
  const db = new FakeDatabase();
  db.seed(options.published ?? legacyPublished());
  db.receipts.set('receipt-1', options.receipt === undefined ? await boundReceipt() : options.receipt);
  return db;
}

async function outcomeOf(db: FakeDatabase, setup: HostSetup = {}, input: unknown = request()) {
  const context = makeHost(db, setup);
  const outcome = await context.host.apply(input, fixtureRegistry());
  return { ...context, outcome };
}

async function rejectionOf(promise: Promise<unknown>): Promise<BindingTransactionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BindingTransactionError);
    return error as BindingTransactionError;
  }
  throw new Error('expected the guard to reject');
}

async function hostErrorOf(promise: Promise<unknown>): Promise<BindingHostError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BindingHostError);
    return error as BindingHostError;
  }
  throw new Error('expected the host to reject');
}

const codeOf = async (db: FakeDatabase, setup: HostSetup = {}, input: unknown = request()) => {
  const error = await rejectionOf(makeHost(db, setup).host.apply(input, fixtureRegistry()));
  return error.code as BindingTransactionErrorCode;
};

function committedOperation(identity: HashId, digest: HashId): OperationRecord {
  return {
    caller_key: 'caller-1', receipt_id: 'receipt-1', resource_type: 'instance', resource_id: 7,
    resource_key: RESOURCE_KEY, target_revision: 5, candidate_digest: digest,
    resolution_identity: identity, dependency_digest: DEP, status: 'committed',
  };
}

describe('MySQL binding host', () => {
  it('accepts a real mysql2 pool and connection as the narrow injected port', () => {
    // Compile-time assignments only: no connection is created, nothing is imported at runtime.
    const toPool = (pool: Pool): BindingSqlPool => pool;
    const toConnection = (connection: PoolConnection): BindingSqlConnection => connection;
    expect(typeof toPool).toBe('function');
    expect(typeof toConnection).toBe('function');
  });

  it('creates the first binding of an unbound resource with the primary key as the CAS', async () => {
    const first = candidate({ revision: 0 });
    const compiled = await compileFor(first);
    const digest = bindingCandidateDigest(compiled, 1, DEP);
    const identity = await identityFor(first);
    const db = new FakeDatabase();
    db.receipts.set('receipt-1', receiptV2({
      base_revision: 0, target_revision: 1, candidate_digest: digest, resolution_identity: identity,
    }));

    const { outcome } = await outcomeOf(db, {}, request({ candidate: first }));

    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') throw new Error('unreachable');
    expect(outcome.revision).toBe(1);
    // The insert replaced the CAS update; no row existed to update.
    expect(db.eventNames()).toEqual([
      'begin', 'lock', 'bindingRead', 'operationRead', 'bindingRead', 'receiptRead',
      'consumptionRead', 'bindingLock', 'operationInsert', 'bindingInsert', 'auditInsert',
      'commit', 'release',
    ]);
    expect(db.log.some(entry => entry.at === 'bindingUpdate')).toBe(false);
    const insertedBinding = db.log.find(entry => entry.at === 'bindingInsert')!.params;
    expect((insertedBinding[0] as Buffer).toString('utf8')).toBe(RESOURCE_KEY);
    expect(insertedBinding[2]).toBe('web');
    // The first binding stores the trusted capability facts the enable decision
    // used, not an empty placeholder: later reads resolve from the same facts.
    expect((JSON.parse(String(insertedBinding[3])) as Array<{ metric: { id: string } }>)
      .map(capability => capability.metric.id)).toEqual(['fixture.alpha', 'fixture.beta']);
    expect(db.writes).toEqual({ binding: 1, operation: 1, audit: 1 });
    expect(db.operations).toHaveLength(1);
    expect(db.audits).toHaveLength(1);

    const stored = decodeBindingPayload(db.bindings.get(RESOURCE_KEY)!.payload);
    if (stored.kind !== 'template_pending') throw new Error('unreachable');
    expect(stored.binding.revision).toBe(1);
    expect(stored.binding.template_pins).toEqual([pin(templateV1)]);
    expect(stored.pending.base_revision).toBe(0);
    expect(stored.pending.target_revision).toBe(1);
    expect(stored.effective).toBeNull();
    expect(stored.application.applied_revision).toBeNull();
  });

  it('rejects a concurrent first binding as a revision conflict with no partial write', async () => {
    const first = candidate({ revision: 0 });
    const compiled = await compileFor(first);
    const digest = bindingCandidateDigest(compiled, 1, DEP);
    const db = new FakeDatabase();
    db.receipts.set('receipt-1', receiptV2({
      base_revision: 0, target_revision: 1, candidate_digest: digest, resolution_identity: await identityFor(first),
    }));

    const { outcome } = await outcomeOf(db, { faults: { bindingInsert: 'conflict-insert' } }, request({ candidate: first }));

    expect(outcome).toMatchObject({ kind: 'rejected', code: 'REVISION_CONFLICT' });
    // Rolled back: the operation row the insert preceded is gone with it.
    expect(db.operations).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
  });

  it('refuses a first binding that claims a history the storage does not have', async () => {
    const db = new FakeDatabase();
    db.receipts.set('receipt-1', await boundReceipt());

    // No row, but the candidate names base 4: not a create.
    expect(await codeOf(db, {}, request())).toBe('TRANSACTION_BINDING_MISSING');
  });

  it('commits one atomic intent on a single lease and stores the template pending payload', async () => {
    const db = await seededDb();
    const identity = await identityFor();
    const digest = await digestFor();
    const before = structuredClone(request());

    const { outcome, factoryConnections } = await outcomeOf(db, {}, before);

    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') throw new Error('unreachable');
    expect(outcome.revision).toBe(5);
    expect(outcome.resolution_identity).toBe(identity);

    // The complete statement sequence, all on the one connection this lease took.
    expect(db.eventNames()).toEqual([
      'begin', 'lock', 'bindingRead', 'operationRead', 'bindingRead', 'receiptRead',
      'consumptionRead', 'bindingLock', 'operationInsert', 'bindingUpdate', 'auditInsert',
      'commit', 'release',
    ]);
    expect(db.connectionIds()).toEqual([1]);
    expect(factoryConnections).toEqual([1]);
    expect(db.connections).toHaveLength(1);

    // Three physical writes; the four logical states are consistent.
    expect(db.writes).toEqual({ binding: 1, operation: 1, audit: 1 });
    expect(db.operations).toHaveLength(1);
    expect(db.operations[0]).toMatchObject({
      caller_key: 'caller-1', receipt_id: 'receipt-1', resource_key: RESOURCE_KEY,
      target_revision: 5, candidate_digest: digest, resolution_identity: identity,
      dependency_digest: DEP, status: 'committed',
    });
    expect(db.audits).toHaveLength(1);

    // The recorded statement text is exactly the host's declared SQL.
    expect(db.log.find(entry => entry.at === 'operationInsert')!.sql)
      .toBe(MYSQL_BINDING_HOST_SQL.operationInsert);
    expect(db.log.find(entry => entry.at === 'bindingUpdate')!.sql)
      .toBe(MYSQL_BINDING_HOST_SQL.bindingUpdate);

    // Real parameters: keys are UTF-8 bytes, the CAS revision is the trusted base.
    const write = (at: string) => db.log.find(entry => entry.at === at)!;
    const inserted = write('operationInsert').params;
    expect(Buffer.isBuffer(inserted[0])).toBe(true);
    expect((inserted[0] as Buffer).toString('utf8')).toBe('caller-1');
    expect((inserted[1] as Buffer).toString('utf8')).toBe('receipt-1');
    expect((inserted[4] as Buffer).toString('utf8')).toBe(RESOURCE_KEY);
    expect(inserted[5]).toBe(5);
    expect((inserted[9] as Buffer).toString('utf8')).toBe('committed');
    const updated = write('bindingUpdate').params;
    expect(updated[1]).toBe('web');
    expect((updated[2] as Buffer).toString('utf8')).toBe(RESOURCE_KEY);
    expect(updated[3]).toBe(4);
    const audit = write('auditInsert');
    expect((audit.params[0] as Buffer).toString('utf8')).toBe(RESOURCE_KEY);
    const auditPayload = JSON.parse(audit.params[1] as string) as Record<string, any>;
    expect(auditPayload.action).toBe('template_binding.apply');
    expect(auditPayload.actor_id).toBe(9);
    expect(auditPayload.request_id).toBe('caller-1');
    expect(auditPayload.configuration).toMatchObject({ base_revision: 4, target_revision: 5 });
    expect(JSON.stringify(auditPayload)).not.toContain(legacyPackage.digest);

    // The stored row: envelope, raw candidate at the target revision, the pending
    // snapshot for the *base* identity, and the previous effective value preserved.
    const row = db.bindings.get(RESOURCE_KEY)!;
    expect(row.group_id).toBe('web');
    expect(row.capabilities).toBe('[{"kept":true}]');
    const stored = decodeBindingPayload(row.payload);
    expect(stored.kind).toBe('template_pending');
    if (stored.kind !== 'template_pending') throw new Error('unreachable');
    expect(stored.binding.revision).toBe(5);
    expect(stored.binding.package).toBeNull();
    expect(stored.binding.template_pins).toEqual([pin(templateV1)]);
    expect(stored.pending).toMatchObject({
      base_revision: 4, target_revision: 5, resolution_identity: identity,
      operation_key: expect.stringContaining('#5@'),
    });
    expect(stored.pending.plan.identity).toBe(identity);
    expect(stored.pending.plan.revision).toBe(4);
    // The pending revision never promotes the applied revision or marks health.
    expect(stored.application.status).toBe('pending');
    expect(stored.application.applied_revision).toBe(4);
    // The carried snapshot is the actual legacy resolved view, not a label set.
    expect(stored.effective).toEqual({
      source: 'package', revision: 4, resolution_identity: null, resolved: legacyResolved(),
    });

    expect(before).toEqual(request());
  });

  it('delegates a legacy candidate without staging and without taking a second path', async () => {
    const db = await seededDb();
    const { outcome } = await outcomeOf(db, {}, request({ candidate: legacyCandidate() }));

    expect(outcome.kind).toBe('legacy_delegate');
    expect(db.eventNames()).toEqual(['begin', 'lock', 'rollback', 'release']);
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
  });

  it('replays the exact committed operation without writing or re-staging', async () => {
    const db = await seededDb();
    db.operations.push(committedOperation(await identityFor(), await digestFor()));
    const { outcome } = await outcomeOf(db);

    expect(outcome.kind).toBe('replay');
    expect(db.eventNames()).toEqual([
      'begin', 'lock', 'bindingRead', 'operationRead', 'bindingRead', 'rollback', 'release',
    ]);
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
  });

  it('only looks up an unknown operation and never resends the mutation', async () => {
    const db = await seededDb();
    db.operations.push({ ...committedOperation(await identityFor(), await digestFor()), status: 'unknown' });
    const { outcome } = await outcomeOf(db);

    expect(outcome.kind).toBe('operation_lookup_required');
    expect(db.eventNames()).not.toContain('operationInsert');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
  });

  it('reports a CAS conflict and rolls the whole staging back', async () => {
    const db = await seededDb();
    const { outcome } = await outcomeOf(db, { faults: { bindingUpdate: 'cas-zero' } });

    expect(outcome).toEqual({ kind: 'rejected', status: 'rejected', persisted: false, committed: false, code: 'REVISION_CONFLICT' });
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(db.operations).toHaveLength(0);
    expect(db.eventNames().filter(at => at === 'rollback')).toHaveLength(1);
    expect(db.connections[0].state).toBe('released');
  });

  it('distinguishes a concurrent caller-key conflict from a consumed receipt', async () => {
    const callerConflict = await seededDb();
    const first = await outcomeOf(callerConflict, { faults: { operationInsert: 'conflict-caller' } });
    expect(first.outcome).toMatchObject({ kind: 'rejected', code: 'OPERATION_CONFLICT' });
    expect(callerConflict.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(callerConflict.operations).toHaveLength(1); // the concurrent writer's row only

    const receiptConflict = await seededDb();
    const second = await outcomeOf(receiptConflict, { faults: { operationInsert: 'conflict-receipt' } });
    expect(second.outcome).toMatchObject({ kind: 'rejected', code: 'RECEIPT_CONSUMED' });
    expect(receiptConflict.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
  });

  it('treats caller keys and receipt ids as byte-exact, not case- or space-folding', async () => {
    const db = await seededDb();
    db.operations.push({
      ...committedOperation(`sha256:${'e'.repeat(64)}`, `sha256:${'f'.repeat(64)}`),
      caller_key: 'CALLER-1', receipt_id: 'RECEIPT-1',
    });
    db.operations.push({
      ...committedOperation(`sha256:${'e'.repeat(64)}`, `sha256:${'f'.repeat(64)}`),
      caller_key: 'caller-1 ', receipt_id: 'receipt-1 ',
    });
    const { outcome } = await outcomeOf(db);

    expect(outcome.kind).toBe('committed');
    expect(db.operations).toHaveLength(3);
    expect(db.operations.map(entry => entry.caller_key).sort())
      .toEqual(['CALLER-1', 'caller-1', 'caller-1 ']);
  });

  it('refuses a truncated operation read instead of inventing a fresh operation', async () => {
    const db = await seededDb();
    db.operations.push(committedOperation(await identityFor(), await digestFor()));
    db.operations.push({ ...committedOperation(await identityFor(), await digestFor()), receipt_id: 'other-receipt' });

    expect(await codeOf(db)).toBe('TRANSACTION_OPERATION_UNAVAILABLE');
    expect(db.eventNames()).not.toContain('operationInsert');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
  });

  it('rejects when the receipt cannot be read or is a v1 receipt', async () => {
    const readFailure = await seededDb();
    expect(await codeOf(readFailure, { faults: { receiptRead: 'throw' } })).toBe('TRANSACTION_RECEIPT_UNAVAILABLE');
    expect(readFailure.writes).toEqual({ binding: 0, operation: 0, audit: 0 });

    const v1Receipt = await seededDb();
    const legacyReceipt = receiptV2() as Record<string, unknown>;
    delete legacyReceipt.receipt_version;
    delete legacyReceipt.resolution_identity;
    v1Receipt.receipts.set('receipt-1', legacyReceipt);
    expect(await codeOf(v1Receipt)).toBe('TRANSACTION_RECEIPT_INVALID');
    expect(v1Receipt.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
  });

  it('keeps a lost commit acknowledgement as commit_unknown, destroys the connection and never retries', async () => {
    const db = await seededDb();
    const { outcome } = await outcomeOf(db, { faults: { commit: 'apply-throw' } });

    expect(outcome.kind).toBe('commit_unknown');
    if (outcome.kind !== 'commit_unknown') throw new Error('unreachable');
    expect(outcome.cause).toBe('host_reported_unknown');
    expect(outcome.lookup).toBe(true);

    // The fixture models the lost ack by applying the commit first; the host must
    // still not claim success and must not reuse the connection.
    expect(db.connections[0].state).toBe('destroyed');
    expect(db.eventNames().filter(at => at === 'begin')).toHaveLength(1);
    expect(db.eventNames().filter(at => at === 'operationInsert')).toHaveLength(1);
    expect(db.connections[0].state).not.toBe('released');

    // The unknown outcome is only ever resolved by looking up the original key.
    const context = makeHost(db);
    const lookup = await context.host.lookupOperation('caller-1');
    expect(lookup.complete).toBe(true);
    expect(lookup.operation).toMatchObject({ caller_key: 'caller-1', target_revision: 5, status: 'committed' });
  });

  it('destroys the connection when begin state is unknown', async () => {
    const db = await seededDb();
    const error = await hostErrorOf(makeHost(db, { faults: { begin: 'throw' } }).host.apply(request(), fixtureRegistry()));

    expect(error.code).toBe('HOST_BEGIN_UNKNOWN');
    expect(db.connections[0].state).toBe('destroyed');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
  });

  it('rejects a missing policy lock and releases the transaction', async () => {
    const db = await seededDb();
    const error = await hostErrorOf(makeHost(db, { faults: { lock: 'missing' } }).host.apply(request(), fixtureRegistry()));

    expect(error.code).toBe('HOST_LOCK_UNAVAILABLE');
    expect(db.eventNames()).toEqual(['begin', 'lock', 'rollback', 'release']);
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
  });

  it('releases rather than commits when the final CAS read fails', async () => {
    const db = await seededDb();
    const { outcome } = await outcomeOf(db, { faults: { bindingLock: 'throw' } });

    expect(outcome).toMatchObject({ kind: 'rejected', code: 'UNAVAILABLE', persisted: false });
    expect(db.eventNames()).not.toContain('commit');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(db.connections[0].state).toBe('released');
  });

  it('rolls back every write when the audit insert fails after staging', async () => {
    const db = await seededDb();
    const { outcome } = await outcomeOf(db, { faults: { auditInsert: 'throw' } });

    expect(outcome).toMatchObject({ kind: 'rejected', code: 'UNAVAILABLE' });
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(db.operations).toHaveLength(0);
    expect(db.eventNames().filter(at => at === 'rollback')).toHaveLength(1);
    expect(db.eventNames().filter(at => at === 'release')).toHaveLength(1);
    expect(db.connections[0].state).toBe('released');
  });

  it('rolls back a write that reached the transaction before failing, at every write point', async () => {
    for (const at of ['operationInsert', 'bindingUpdate', 'auditInsert']) {
      const db = await seededDb();
      const { outcome } = await outcomeOf(db, { faults: { [at]: 'throw-after' } });

      expect(outcome).toMatchObject({ kind: 'rejected', code: 'UNAVAILABLE', persisted: false });
      expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
      expect(db.eventNames().filter(name => name === 'rollback')).toHaveLength(1);
      expect(db.connections[0].state).toBe('released');
    }
  });

  it('reports commit_unknown and quarantines the connection when a failed write cannot be rolled back', async () => {
    const db = await seededDb();
    const { outcome } = await outcomeOf(db, { faults: { auditInsert: 'throw', rollback: 'throw' } });

    expect(outcome.kind).toBe('commit_unknown');
    if (outcome.kind !== 'commit_unknown') throw new Error('unreachable');
    expect(outcome.cause).toBe('stage_unavailable');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(db.eventNames().filter(at => at === 'rollback')).toHaveLength(1);
    expect(db.eventNames().filter(at => at === 'destroy')).toHaveLength(1);
    expect(db.connections[0].state).toBe('destroyed');
  });

  it('refuses to start without the full trusted-input factory', async () => {
    const db = await seededDb();
    const error = await hostErrorOf(
      makeHost(db, { omit: 'mandatoryItems' }).host.apply(request(), fixtureRegistry()),
    );

    expect(error.code).toBe('HOST_INPUTS_UNAVAILABLE');
    expect(db.eventNames()).toEqual(['begin', 'lock', 'rollback', 'release']);
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
  });

  it('refuses to stage over a legacy row whose applied plan cannot be proven', async () => {
    const published = legacyPublished({
      application: { applied_revision: 3, reported_at: T1, status: 'pending', error_code: null },
    });
    const db = await seededDb({ published });
    const original = db.bindings.get(RESOURCE_KEY)!.payload;
    const { outcome } = await outcomeOf(db);

    expect(outcome).toMatchObject({ kind: 'rejected', code: 'UNAVAILABLE', persisted: false });
    expect(db.bindings.get(RESOURCE_KEY)!.payload).toBe(original);
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(db.connections[0].state).toBe('released');
  });

  it('treats the stage acknowledgement as no commit at all', async () => {
    const db = await seededDb();
    const { outcome } = await outcomeOf(db, { faults: { commit: 'throw' } });

    // Counterexample guard: an implementation that reported "committed" from the
    // staging acknowledgement would fail here (and would have persisted nothing).
    expect(outcome.kind).toBe('commit_unknown');
    if (outcome.kind !== 'commit_unknown') throw new Error('unreachable');
    expect(outcome.persisted).toBe('unknown');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(db.connections[0].state).toBe('destroyed');
  });
});

describe('read-only caller-key lookup', () => {
  it('answers a complete exact lookup and never writes or begins a transaction', async () => {
    const db = await seededDb();
    db.operations.push(committedOperation(await identityFor(), await digestFor()));
    const { host } = makeHost(db);

    const found = await host.lookupOperation('caller-1');
    expect(found).toEqual({
      complete: true,
      operation: expect.objectContaining({
        caller_key: 'caller-1', resource: RESOURCE, target_revision: 5, status: 'committed',
      }),
    });
    expect(await host.lookupOperation('nobody')).toEqual({ complete: true, operation: null });
    expect(db.eventNames().filter(at => at === 'operationRead')).toHaveLength(2);
    expect(db.eventNames().filter(at => at === 'release')).toHaveLength(2);
    expect(db.eventNames()).not.toContain('begin');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(db.connections.map(connection => connection.state)).toEqual(['released', 'released']);
  });

  it('does not treat a damaged or unavailable read as an absent operation', async () => {
    const db = await seededDb();
    db.operations.push(committedOperation(await identityFor(), await digestFor()));
    db.operations.push({ ...committedOperation(`sha256:${'e'.repeat(64)}`, `sha256:${'f'.repeat(64)}`), receipt_id: 'other' });

    const { host } = makeHost(db);
    expect(await host.lookupOperation('caller-1')).toEqual({ complete: false, operation: null });

    const failing = await seededDb();
    const error = await hostErrorOf(makeHost(failing, { faults: { operationRead: 'throw' } }).host.lookupOperation('caller-1'));
    expect(error.code).toBe('HOST_QUERY_UNAVAILABLE');
    expect(failing.connections[0].state).toBe('released');
  });

  it('rejects a caller key that the storage key space cannot represent', async () => {
    const db = await seededDb();
    const { host } = makeHost(db);
    const error = await hostErrorOf(host.lookupOperation('x'.repeat(256)));
    expect(error.code).toBe('HOST_INTENT_INVALID');
    expect(db.connections).toHaveLength(0);
  });
});

describe('strict stored snapshots', () => {
  it('commits on an actual legacy Resolved and an actual B2C plan, and carries that snapshot forward', async () => {
    const db = await seededDb();
    const { outcome } = await outcomeOf(db);

    expect(outcome.kind).toBe('committed');
    const stored = decodeBindingPayload(db.bindings.get(RESOURCE_KEY)!.payload);
    expect(stored.kind).toBe('template_pending');
    if (stored.kind !== 'template_pending') throw new Error('unreachable');
    expect(stored.effective_missing).toBe(false);
    expect(stored.effective).toEqual({
      source: 'package', revision: 4, resolution_identity: null, resolved: legacyResolved(),
    });
    // The pending snapshot really is the B2C plan, not a label set.
    expect(stored.pending.plan.releases.length).toBeGreaterThan(0);
    expect(stored.pending.plan.releases[0].steps[0].items.length).toBeGreaterThan(0);
  });

  it('refuses to write when the old applied state has no actual effective plan', async () => {
    const db = await seededDb({ published: legacyPublished({ resolved: {} }) });
    const before = db.bindings.get(RESOURCE_KEY)!.payload;

    // The accepted guard converts an unreadable binding into its own fail-closed
    // rejection; nothing is staged and the row is untouched.
    const error = await rejectionOf(makeHost(db).host.apply(request(), fixtureRegistry()));

    expect(error.code).toBe('TRANSACTION_BINDING_UNAVAILABLE');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(db.eventNames()).not.toContain('operationInsert');
    expect(db.bindings.get(RESOURCE_KEY)!.payload).toBe(before);
    expect(db.connections[0].state).toBe('released');
  });

  it('refuses a real legacy plan whose config revision disagrees with the applied revision', async () => {
    const published = legacyPublished();
    (published.resolved as Record<string, any>).plan.binding.config_revision = 3;
    const db = await seededDb({ published });
    const before = db.bindings.get(RESOURCE_KEY)!.payload;

    const error = await rejectionOf(makeHost(db).host.apply(request(), fixtureRegistry()));

    expect(error.code).toBe('TRANSACTION_BINDING_UNAVAILABLE');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(db.bindings.get(RESOURCE_KEY)!.payload).toBe(before);
  });

  it('never reports a corrupt operation row as a complete lookup or as no operation', async () => {
    const identity = await identityFor();
    const digest = await digestFor();
    const corruptions: Array<Record<string, unknown>> = [
      { resource_type: 'not-a-resource' },
      { candidate_digest: 'not-a-hash' },
      { resolution_identity: '' },
      { dependency_digest: 'sha256:short' },
      { resource_id: 0 },
      { target_revision: '1.5' },
      { receipt_id: '' },
      { status: 'pending' },
    ];
    for (const corruption of corruptions) {
      const db = await seededDb();
      db.operations.push({ ...committedOperation(identity, digest), ...corruption });
      const found = await makeHost(db).host.lookupOperation('caller-1');
      expect(found).toEqual({ complete: false, operation: null });
    }
  });

  it('fails closed before any write when the stored operation row is corrupt', async () => {
    const db = await seededDb();
    db.operations.push({
      ...committedOperation(await identityFor(), await digestFor()), candidate_digest: 'not-a-hash',
    });

    expect(await codeOf(db)).toBe('TRANSACTION_OPERATION_UNAVAILABLE');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(db.eventNames()).not.toContain('operationInsert');
  });

  it('does not read a damaged receipt consumption row as a consumed receipt', async () => {
    const db = await seededDb();
    db.operations.push({ ...committedOperation(await identityFor(), await digestFor()), caller_key: '' });

    expect(await codeOf(db)).toBe('TRANSACTION_RECEIPT_UNAVAILABLE');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
    expect(db.eventNames()).not.toContain('operationInsert');
  });

  it('rejects a cross-resource effective plan built from a real B2C plan', async () => {
    const db = await seededDb();
    await outcomeOf(db);
    const raw = JSON.parse(db.bindings.get(RESOURCE_KEY)!.payload) as Record<string, any>;
    const complete = structuredClone(raw.template_resolution.pending.plan);
    complete.resource.id = '8';
    raw.application.resolution_identity = complete.identity;
    raw.effective = { source: 'template', revision: 4, resolution_identity: complete.identity, plan: complete };

    expect(() => decodeBindingPayload(raw)).toThrow(BindingPersistenceError);
  });

  it('accepts the same real B2C plan as this row\'s own effective template snapshot', async () => {
    const db = await seededDb();
    await outcomeOf(db);
    const raw = JSON.parse(db.bindings.get(RESOURCE_KEY)!.payload) as Record<string, any>;
    const own = structuredClone(raw.template_resolution.pending.plan);
    raw.application.resolution_identity = own.identity;
    raw.effective = { source: 'template', revision: 4, resolution_identity: own.identity, plan: own };

    const decoded = decodeBindingPayload(raw);
    if (decoded.kind !== 'template_pending') throw new Error('unreachable');
    expect(decoded.effective).toMatchObject({ source: 'template', revision: 4 });
  });
});
