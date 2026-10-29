/**
 * MAX-238 / B2G — offline v2 trial-receipt issuer + writer, on one SQL fixture.
 *
 * The fixture models the candidate receipt table and one MySQL connection; it is
 * not MySQL. It proves the compiled payload is the private v2 shape the accepted
 * B2D guard accepts after being read back with the accepted B2E host SELECT, the
 * writer's single connection/admission/insert/replay/collision behavior, and the
 * zero-write rejections. It proves no real uniqueness, CAS, permission or trial.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import type {
  CollectorDefinition, DerivedMetric, MetricDefinition,
} from '../../contracts/metrics/index.js';
import type {
  HashId, PackageCompositionEntry, ResourceBindingCandidate, SourceChain, TemplateItemVersion,
  TemplateParameters, TemplatePin, TemplateVersion, VersionNumber,
} from '../../contracts/metrics/templates.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from '../packages/model.js';
import { packageReleaseRef, templateContentHash, type MetricRef } from '../templates/model.js';
import type { TemplateVersionReadPort } from './preflight.js';
import { compileBindingCandidate } from './compile.js';
import {
  resolveTemplateBinding, templateResolutionIdentity, type TemplateResolutionContext,
} from './resolve.js';
import {
  bindingCandidateDigest, prepareTemplateBindingMutation, prepareTemplateBindingMutationV2,
  type BindingTransactionPortV2, type TrustedAuthorization,
} from './transaction-guard.js';
import { MYSQL_BINDING_HOST_SQL } from './mysql-host.js';
import {
  issueTrialReceipt, TrialReceiptIssueError, type IssuedTrialReceipt, type TrialReceiptIssuerOptions,
} from './trial-receipt-issuer.js';
import {
  TRIAL_RECEIPT_INSERT_SQL, TrialReceiptWriteError, writeTrialReceipt,
} from './trial-receipt-writer.js';

const T0 = '2026-10-01T00:00:00Z';
const T1 = '2026-10-02T00:00:00Z';
const AT = '2026-09-18T00:00:00.000Z';
const NOW = '2026-10-03T00:00:00Z';
const TTL = 8 * 60 * 60 * 1000;
const EXPIRES = '2026-10-03T08:00:00.000Z';
const DEP = `sha256:${'d'.repeat(64)}`;
const DEP2 = `sha256:${'e'.repeat(64)}`;
const RESOURCE = { type: 'instance' as const, id: 7 };
const RECEIPT_ID = 'receipt-1';

// --- template fixtures (same accepted package/template shape as B2E/B2F) ----

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
    documentation: [{ collector_id: statusCollector.id, permissions: mainImpl.permissions, discovery: mainImpl.discovery }],
  });
}
const releaseV1 = release();
const releaseRef = packageReleaseRef(releaseV1.package);
const legacyPackage = { id: releaseV1.package.id, version: releaseV1.package.version, digest: releaseV1.package.digest };
function fixtureRegistry(): PackageRegistry {
  const registry = new PackageRegistry([], [mainImpl]);
  registry.install(releaseV1);
  return registry;
}
const metricRef = (definition: ExtensionDefinition): MetricRef => ({ id: definition.id, semantic_version: definition.semantic_version });
function item(itemId: string, definition: ExtensionDefinition): TemplateItemVersion {
  return {
    template_id: 'tpl-one', item_id: itemId, version: 1, display_name: itemId,
    canonical_metric: metricRef(definition), unit: definition.unit, dimensions: {},
    collector_ref: { package_release: releaseRef, implementation_id: mainImpl.id },
    params_default: {},
    source_chain: { actor_id: 1, request_id: `req-item-${itemId}`, base: null, created_at: T0, published_at: T1, retired_at: null, migration_ref: null },
  };
}
interface VersionSpec { items: TemplateItemVersion[]; version?: VersionNumber; parameters?: TemplateParameters; source_chain?: Partial<SourceChain> }
function templateVersion(spec: VersionSpec): TemplateVersion {
  const composition: PackageCompositionEntry[] = [{ release: releaseRef, items: spec.items.map(stored => stored.item_id).sort() }];
  const aggregate = {
    template_id: 'tpl-one', base: null,
    items: spec.items.map(stored => ({ item_id: stored.item_id, version: stored.version }))
      .sort((left, right) => left.item_id < right.item_id ? -1 : left.item_id > right.item_id ? 1 : 0),
    triggers: [], parameters: spec.parameters ?? { schema: {}, defaults: {} },
    capabilities: {
      discovery: { contract_version: '1.0.0', ref: null, executable: false as const },
      graphs: { contract_version: '1.0.0', ref: null, executable: false as const },
    },
    package_composition: composition,
  };
  return {
    template_id: 'tpl-one', version: spec.version ?? 1, status: 'published',
    content_hash: templateContentHash(aggregate), aggregate, items: spec.items, package_composition: composition,
    source_chain: { actor_id: 1, request_id: 'req-tpl-one', base: null, created_at: T0, published_at: T1, retired_at: null, migration_ref: null, ...spec.source_chain },
    published_at: T1, retired_at: null,
  };
}
const parameters = (interval: number): TemplateParameters => ({
  schema: { interval_ms: { type: 'integer', min: 1000, max: 60000 } }, defaults: { interval_ms: interval },
});
const templateV1 = templateVersion({ items: [item('alpha-item', alpha), item('beta-item', beta)], parameters: parameters(30000) });
const pin = (version: TemplateVersion): TemplatePin => ({
  template_id: version.template_id, version: version.version, content_hash: version.content_hash,
});
const templatePort = (): TemplateVersionReadPort => ({
  getVersion: async (templateId: string, version: VersionNumber) =>
    [templateV1].find(entry => entry.template_id === templateId && entry.version === version) ?? null,
});
function candidate(overrides: Partial<ResourceBindingCandidate> = {}): ResourceBindingCandidate {
  return {
    resource: { ...RESOURCE }, package: null, group_id: 'web',
    overrides: { interval_ms: { mode: 'set', value: 30000 }, template_parameters: { 'tpl-one': { interval_ms: 40000 } } },
    revision: 4, template_pins: [pin(templateV1)],
    ...overrides,
  } as ResourceBindingCandidate;
}
function request(overrides: Record<string, unknown> = {}) {
  return { resource: { ...RESOURCE }, candidate: candidate(), receipt_id: RECEIPT_ID, ...overrides };
}
/** The guard's own request shape; `caller_key` is a guard fact, never an issuer one. */
function guardRequest(overrides: Record<string, unknown> = {}) {
  return { ...request(overrides), caller_key: 'caller-1' };
}

// --- trusted context (same accepted shapes as the B2F gateway fixtures) -----

const allowed = (dependency: HashId = DEP): TrustedAuthorization => ({ allowed: true, cancelled: false, dependency_digest: dependency });
const trustedResource = () => ({
  type: 'instance', id: '7',
  attributes: { 'db.engine': { value: 'fixture', observed_at: AT, source: 'fixture' } },
});
const trustedGroup = () => ({ id: 'web', revision: 2, policy_revision: 2, overrides: {} });
const supported = (...metrics: ExtensionDefinition[]) => metrics.map(definition => ({
  resource_id: '7', metric: metricRef(definition), method: 'sql' as const, status: 'supported' as const,
  basis: [{ kind: 'permission' as const, evidence: 'fixed_read_succeeded' }],
  evaluated_at: AT, valid_until: '2026-10-05T00:00:00.000Z',
}));
const trustedContext = () => ({
  resource: trustedResource(), group: trustedGroup(), capabilities: supported(alpha, beta), at: AT, actor_id: 9,
});
function resolutionContext(): TemplateResolutionContext {
  const base = trustedContext();
  return { resource: base.resource, group: base.group, capabilities: base.capabilities, at: base.at };
}
const alphaRef = { template_id: 'tpl-one', item_id: 'alpha-item', item_version: 1 };
const betaRef = { template_id: 'tpl-one', item_id: 'beta-item', item_version: 1 };
const legacyBinding = (): ResourceBindingCandidate =>
  ({ resource: { ...RESOURCE }, package: legacyPackage, group_id: 'web', overrides: {}, revision: 4 }) as ResourceBindingCandidate;

async function compileFor(input: unknown) {
  const compiled = await compileBindingCandidate(input, templatePort(), fixtureRegistry());
  if (compiled.kind !== 'template_candidate') throw new Error('fixture candidate must not be legacy');
  return compiled;
}
async function digestFor(input: unknown = candidate()): Promise<HashId> {
  return bindingCandidateDigest(await compileFor(input), 5, DEP);
}
async function identityFor(): Promise<HashId> {
  const outcome = await resolveTemplateBinding(candidate(), resolutionContext(), templatePort(), fixtureRegistry());
  if (outcome.kind !== 'template_resolution') throw new Error('fixture resolution must not be legacy');
  return templateResolutionIdentity(outcome);
}

// --- offline evidence port --------------------------------------------------

type Evidence = {
  template_id: string; item_id: string; item_version: number;
  status: 'qualified' | 'withdrawn' | 'failed'; optional: boolean;
  phases: { read: boolean; transform: boolean; unit: boolean };
};
const qualified = (ref: typeof alphaRef): Evidence => ({
  ...ref, status: 'qualified', optional: false, phases: { read: true, transform: true, unit: true },
});
const partial = (ref: typeof alphaRef, optional = false): Evidence => ({
  ...ref, status: 'qualified', optional, phases: { read: true, transform: true, unit: false },
});
const withdrawn = (ref: typeof alphaRef, status: 'withdrawn' | 'failed'): Evidence => ({
  ...ref, status, optional: false, phases: { read: false, transform: false, unit: false },
});
/** The receipt item shape: the guard's `phases` projection of qualified evidence. */
const receiptItem = (ref: typeof alphaRef) => ({ ...ref, phases: { read: true, transform: true, unit: true } });
const evidencePort = (items: unknown) => ({ read: async () => items });

function issuerOptions(overrides: Partial<TrialReceiptIssuerOptions> = {}): TrialReceiptIssuerOptions {
  return {
    context: resolutionContext(),
    dependencyDigest: DEP,
    templates: templatePort(),
    registry: fixtureRegistry(),
    evidence: evidencePort([qualified(alphaRef), qualified(betaRef)]),
    now: () => NOW,
    ttlMs: TTL,
    ...overrides,
  };
}

// --- in-memory SQL fixture: candidate receipt table + one connection -------

class FakeDatabase {
  receipts = new Map<string, string>();
  writes = { receipt: 0 };
  /** Every SQL statement and transaction boundary, in call order. */
  events: string[] = [];
  connections = 0;
  active = 0;
  maxActive = 0;
  duplicateRows = new Set<string>();
  failReceiptRead = false;
  /** One pool per database, so the store's admission WeakMap is actually shared. */
  readonly pool = new FakePool(this);

  eventNames(): string[] { return this.events.map(sql => sql.replace(/\s+/g, ' ').trim()); }
}

class FakePool {
  constructor(readonly db: FakeDatabase) {}
  async getConnection(): Promise<FakeConnection> {
    const connection = new FakeConnection(this.db, this);
    this.db.connections++;
    this.db.active++;
    this.db.maxActive = Math.max(this.db.maxActive, this.db.active);
    return connection;
  }
  released(): void { this.db.active--; }
}

const duplicateEntry = (): Error => Object.assign(new Error('fixture duplicate entry'), { code: 'ER_DUP_ENTRY' });
const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const INSERT_KEY = normalize(TRIAL_RECEIPT_INSERT_SQL);
const HOST_READ_KEY = normalize(MYSQL_BINDING_HOST_SQL.receiptRead);

class FakeConnection {
  /** Rows this transaction inserted; applied by COMMIT, discarded by ROLLBACK. */
  private pending = new Map<string, string>();
  private open = false;

  constructor(readonly db: FakeDatabase, readonly pool: FakePool) {}

  async beginTransaction(): Promise<void> {
    this.open = true;
    this.db.events.push('BEGIN');
  }
  async commit(): Promise<void> {
    for (const [receiptId, payload] of this.pending) {
      if (this.db.receipts.has(receiptId)) {
        // The real PRIMARY KEY would have refused this INSERT already.
        throw new Error('fixture: duplicate committed row');
      }
      this.db.receipts.set(receiptId, payload);
      this.db.writes.receipt++;
    }
    this.pending.clear();
    this.open = false;
    this.db.events.push('COMMIT');
  }
  async rollback(): Promise<void> {
    this.pending.clear();
    this.open = false;
    this.db.events.push('ROLLBACK');
  }

  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    const key = normalize(sql);
    // Transaction settings are setup, not receipt persistence.
    if (/^SET TRANSACTION ISOLATION LEVEL READ COMMITTED$/i.test(key)) return [{}, []];
    this.db.events.push(sql);
    if (key === INSERT_KEY) {
      const [receiptId, payload] = params as [string, string];
      // A row locked by another transaction is not visible to this one until it
      // commits; the fixture treats a committed row as the duplicate authority.
      if (this.db.receipts.has(receiptId) || this.pending.has(receiptId)) throw duplicateEntry();
      if (!this.open) {
        // Autocommit (the pre-R4 writer): the row is visible without a COMMIT.
        this.db.receipts.set(receiptId, payload);
        this.db.writes.receipt++;
        return [{ affectedRows: 1 }, []];
      }
      this.pending.set(receiptId, payload);
      return [{ affectedRows: 1 }, []];
    }
    if (key === HOST_READ_KEY) {
      if (this.db.failReceiptRead) throw new Error('fixture: receipt read failed');
      const receiptId = params[0] as string;
      const stored = this.db.receipts.get(receiptId) ?? this.pending.get(receiptId);
      if (stored === undefined) return [[], []];
      // Two rows model the broken global-uniqueness invariant the host refuses.
      if (this.db.duplicateRows.has(receiptId)) return [[{ payload: stored }, { payload: stored }], []];
      return [[{ payload: stored }], []];
    }
    throw new Error(`fixture: unexpected SQL ${sql}`);
  }

  release(): void { this.pool.released(); }
  destroy(): void { this.pool.released(); }
}

/** A v2 guard port whose receipt read is exactly the accepted B2E host SELECT. */
function transactionPort(db: FakeDatabase, options: {
  dependencyDigest?: HashId; mandatory?: Array<typeof alphaRef>; consumed?: boolean;
} = {}): BindingTransactionPortV2 & { findOperation(callerKey: string): Promise<unknown> } {
  const pool = new FakePool(db);
  return {
    authorize: async () => allowed(options.dependencyDigest ?? DEP),
    currentBinding: async () => legacyBinding(),
    // The host's read: one exact row, JSON-parsed; two rows is a host failure.
    getTrialReceipt: async (receiptId: string) => {
      const connection = await pool.getConnection();
      try {
        const [rows] = await connection.execute(MYSQL_BINDING_HOST_SQL.receiptRead, [receiptId]);
        if (!Array.isArray(rows)) throw new Error('fixture: receipt rows');
        if (rows.length > 1) throw new Error('fixture: two rows');
        if (rows.length === 0) return null;
        return JSON.parse((rows[0] as { payload: string }).payload) as unknown;
      } finally { connection.release(); }
    },
    mandatoryItems: async () => options.mandatory ?? [alphaRef, betaRef],
    serverNow: () => NOW,
    findOperation: async () => null,
    findOperationExact: async () => ({ complete: true, operation: null }),
    findReceiptConsumption: async () => ({ complete: true, consumed: options.consumed ?? false }),
    // The B2E host adds the stored application state; this row has never applied one.
    applicationContext: async () => ({ ...trustedContext(), application: null }),
  };
}

async function issue(overrides: Partial<TrialReceiptIssuerOptions> = {}, requestOverrides: Record<string, unknown> = {}) {
  return issueTrialReceipt(request(requestOverrides), issuerOptions(overrides));
}

function write(db: FakeDatabase, input: unknown) {
  return writeTrialReceipt(input, { pool: () => db.pool as unknown as Pool });
}

// --- proof -----------------------------------------------------------------

describe('MAX-238 B2G trial-receipt issuer', () => {
  it('compiles a v2 receipt the guard accepts after reading it back with the host SELECT', async () => {
    const db = new FakeDatabase();
    const issued = await issue();

    // The three identities are the exported functions' own results, never a copy.
    expect(issued.payload.receipt_version).toBe(2);
    expect(issued.payload.base_revision).toBe(4);
    expect(issued.payload.target_revision).toBe(5);
    expect(issued.payload.candidate_digest).toBe(await digestFor());
    expect(issued.payload.resolution_identity).toBe(await identityFor());
    expect(issued.payload.dependency_digest).toBe(DEP);
    expect(issued.payload.issued_at).toBe(NOW);
    expect(issued.payload.expires_at).toBe(EXPIRES);
    expect(issued.payload.items).toEqual([receiptItem(alphaRef), receiptItem(betaRef)]);
    expect(issued.payload.optional_exclusions).toEqual([]);

    const before = db.connections;
    const outcome = await write(db, issued);
    expect(outcome).toEqual({ kind: 'inserted', persisted: true, receipt_id: RECEIPT_ID });
    // Writer takes exactly one connection, one short transaction and the two host columns.
    expect(db.connections - before).toBe(1);
    expect(db.eventNames()).toEqual(['BEGIN', INSERT_KEY, 'COMMIT']);
    expect(db.writes.receipt).toBe(1);
    expect(JSON.parse(db.receipts.get(RECEIPT_ID)!) as unknown).toEqual(issued.payload);

    // Read back through the accepted B2D v2 entry, with the host's exact SELECT.
    const prepared = await prepareTemplateBindingMutationV2(
      guardRequest(), transactionPort(db), templatePort(), fixtureRegistry(),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('unreachable');
    expect(prepared.protocol).toBe('max238.template-binding.v2');
    expect(prepared.receipt_version).toBe(2);
    expect(prepared.target_revision).toBe(5);
    expect(prepared.operation.status).toBe('pending');
    expect(db.eventNames()).toContain(HOST_READ_KEY);

    // The v1 entry stays v1: its strict schema rejects a v2 row, never upgrades it.
    await expect(prepareTemplateBindingMutation(
      guardRequest(), transactionPort(db), templatePort(), fixtureRegistry(),
    )).rejects.toMatchObject({ code: 'TRANSACTION_RECEIPT_INVALID' });
  });

  it('keeps the receipt usable only while the trusted dependency identity matches', async () => {
    const db = new FakeDatabase();
    const issued = await issue();
    await write(db, issued);

    const port = transactionPort(db, { dependencyDigest: DEP2 });
    await expect(prepareTemplateBindingMutationV2(
      guardRequest(), port, templatePort(), fixtureRegistry(),
    )).rejects.toMatchObject({ code: 'TRANSACTION_RECEIPT_MISMATCH' });
    // The guard has no write path: a rejected receipt leaves the stored row untouched.
    expect(db.writes.receipt).toBe(1);
  });

  it('replays an identical payload and reports a different payload as a collision with no extra write', async () => {
    const db = new FakeDatabase();
    const issued = await issue();
    expect((await write(db, issued)).kind).toBe('inserted');
    expect((await write(db, issued)).kind).toBe('replay');
    expect(db.writes.receipt).toBe(1);

    const other = { receipt_id: RECEIPT_ID, payload: { ...structuredClone(issued.payload), expires_at: '2026-10-05T00:00:00.000Z' } };
    const collision = await write(db, other);
    expect(collision).toEqual({ kind: 'collision', persisted: false, receipt_id: RECEIPT_ID });
    expect(db.writes.receipt).toBe(1);
    expect(JSON.parse(db.receipts.get(RECEIPT_ID)!) as unknown).toEqual(issued.payload);

    // Its own short transaction per write, never the policy lock: each replay and
    // the collision commit nothing.
    expect(db.eventNames().filter(event => event === 'BEGIN')).toHaveLength(3);
    expect(db.eventNames().every(event => !/metric_policy_lock/i.test(event))).toBe(true);
  });

  it('fails closed when the duplicate read sees two rows or fails', async () => {
    const db = new FakeDatabase();
    const issued = await issue();
    await write(db, issued);

    db.duplicateRows.add(RECEIPT_ID);
    await expect(write(db, issued)).rejects.toMatchObject({ code: 'TRIAL_RECEIPT_STORE_UNAVAILABLE' });
    expect(db.writes.receipt).toBe(1);

    db.duplicateRows.delete(RECEIPT_ID);
    db.failReceiptRead = true;
    await expect(write(db, issued)).rejects.toMatchObject({ code: 'TRIAL_RECEIPT_STORE_UNAVAILABLE' });
    expect(db.writes.receipt).toBe(1);
  });

  it('is unavailable without a pool and takes no connection', async () => {
    const issued = await issue();
    const db = new FakeDatabase();
    await expect(writeTrialReceipt(issued, { pool: () => null }))
      .rejects.toMatchObject({ code: 'TRIAL_RECEIPT_WRITER_UNAVAILABLE' });
    expect(db.connections).toBe(0);
    expect(db.receipts.size).toBe(0);
  });

  it('serializes concurrent writes through the one policy admission gate', async () => {
    const db = new FakeDatabase();
    const first = await issue();
    const second = { receipt_id: 'receipt-2', payload: { ...structuredClone(first.payload), receipt_id: 'receipt-2' } };
    const results = await Promise.all([write(db, first), write(db, second)]);
    expect(results.map(result => result.kind)).toEqual(['inserted', 'inserted']);
    expect(db.writes.receipt).toBe(2);
    expect(db.maxActive).toBe(1);
  });

  /**
   * R4: the writer is the persistence boundary. A grant re-read only before the
   * waits proves nothing; every check after a wait must run, and a refusal after
   * the INSERT must roll it back rather than autocommit and then answer 403.
   */
  describe('persistence boundary authorization', () => {
    const refusal = Object.assign(new Error('grant revoked'), { code: 'TEMPLATE_BINDING_FORBIDDEN' });

    it('re-reads the grant after the connection wait, on the held connection', async () => {
      const db = new FakeDatabase();
      const issued = await issue();
      const seen: Array<unknown> = [];
      let calls = 0;
      const authorize = async (connection?: unknown) => {
        calls += 1;
        seen.push(connection);
        // The first check runs after the admission queue, before the pool wait;
        // the second runs on the connection the wait returned.
        if (calls >= 2) throw refusal;
      };
      await expect(writeTrialReceipt(issued, { pool: () => db.pool as unknown as Pool, authorize }))
        .rejects.toBe(refusal);
      expect(calls).toBe(2);
      expect(seen[0]).toBeUndefined();
      expect(seen[1]).toBeDefined();
      expect(db.receipts.size).toBe(0);
      expect(db.eventNames()).toContain('ROLLBACK');
      expect(db.active).toBe(0);
    });

    it('rolls the INSERT back when the grant is revoked while the row lock waits', async () => {
      const db = new FakeDatabase();
      const issued = await issue();
      let calls = 0;
      const authorize = async () => {
        calls += 1;
        // Post-admission and post-connection hold; the post-INSERT read refuses.
        if (calls >= 3) throw refusal;
      };
      await expect(writeTrialReceipt(issued, { pool: () => db.pool as unknown as Pool, authorize }))
        .rejects.toBe(refusal);
      expect(calls).toBe(3);
      expect(db.receipts.size).toBe(0);
      expect(db.writes.receipt).toBe(0);
      expect(db.eventNames().slice(-2)).toEqual([INSERT_KEY, 'ROLLBACK']);
      expect(db.active).toBe(0);
    });

    it('does not hand a replayed receipt to a caller whose grant was revoked during its INSERT', async () => {
      const db = new FakeDatabase();
      const issued = await issue();
      await write(db, issued);
      let calls = 0;
      const authorize = async () => {
        calls += 1;
        if (calls >= 3) throw refusal;
      };
      await expect(writeTrialReceipt(issued, { pool: () => db.pool as unknown as Pool, authorize }))
        .rejects.toBe(refusal);
      // The duplicate read happened, but no outcome was reported and the one
      // committed row is unchanged.
      expect(db.eventNames().slice(-2)).toEqual([HOST_READ_KEY, 'ROLLBACK']);
      expect(db.receipts.size).toBe(1);
      expect(db.writes.receipt).toBe(1);
    });

    it('keeps the offline writer compatible when no grant source is supplied', async () => {
      const db = new FakeDatabase();
      const issued = await issue();
      expect((await write(db, issued)).kind).toBe('inserted');
      expect(db.receipts.size).toBe(1);
    });
  });

  it('rejects a request that carries any receipt fact, before any write', async () => {
    const db = new FakeDatabase();
    for (const injected of [
      { payload: {} }, { items: [qualified(alphaRef)] }, { candidate_digest: DEP },
      { resolution_identity: DEP }, { issued_at: NOW }, { expires_at: EXPIRES },
    ]) {
      await expect(issue({}, injected)).rejects.toMatchObject({ code: 'TRIAL_RECEIPT_INPUT_INVALID' });
    }
    expect(db.receipts.size).toBe(0);
    expect(db.connections).toBe(0);
  });

  it('refuses a missing mandatory item, a partial mandatory phase and a withdrawn/failed evidence row', async () => {
    const db = new FakeDatabase();
    const cases: Array<[unknown[], string, unknown[]]> = [
      [[qualified(alphaRef)], 'TRIAL_EVIDENCE_INCOMPLETE', [betaRef]],
      [[qualified(alphaRef), partial(betaRef, false)], 'TRIAL_ITEM_UNQUALIFIED', [betaRef]],
      [[qualified(alphaRef), withdrawn(betaRef, 'withdrawn')], 'TRIAL_EVIDENCE_WITHDRAWN', [betaRef]],
      [[qualified(alphaRef), withdrawn(betaRef, 'failed')], 'TRIAL_EVIDENCE_WITHDRAWN', [betaRef]],
    ];
    for (const [evidence, code, items] of cases) {
      await expect(issue({ evidence: evidencePort(evidence) }))
        .rejects.toMatchObject({ code, items });
    }
    // Malformed answers (foreign item, duplicate, non-array) are invalid evidence.
    await expect(issue({ evidence: evidencePort([qualified(alphaRef), qualified({ ...alphaRef, item_id: 'ghost' })]) }))
      .rejects.toMatchObject({ code: 'TRIAL_EVIDENCE_INVALID' });
    await expect(issue({ evidence: evidencePort([qualified(alphaRef), qualified(alphaRef), qualified(betaRef)]) }))
      .rejects.toMatchObject({ code: 'TRIAL_EVIDENCE_INVALID' });
    await expect(issue({ evidence: evidencePort('nope' as unknown) }))
      .rejects.toMatchObject({ code: 'TRIAL_EVIDENCE_INVALID' });
    expect(db.receipts.size).toBe(0);
  });

  it('records an explicitly excluded non-mandatory item as an optional exclusion', async () => {
    const db = new FakeDatabase();
    const issued = await issue({ evidence: evidencePort([qualified(alphaRef), partial(betaRef, true)]) });
    expect(issued.payload.items).toEqual([receiptItem(alphaRef)]);
    expect(issued.payload.optional_exclusions).toEqual([betaRef]);

    await write(db, issued);
    // The trusted mandatory list agrees with the evidence: beta may be excluded.
    const prepared = await prepareTemplateBindingMutationV2(
      guardRequest(), transactionPort(db, { mandatory: [alphaRef] }), templatePort(), fixtureRegistry(),
    );
    expect(prepared.kind).toBe('prepared');
  });

  it('is a stable unavailable when the evidence port is missing or throws', async () => {
    await expect(issue({ evidence: null })).rejects.toMatchObject({ code: 'TRIAL_EVIDENCE_UNAVAILABLE' });
    await expect(issue({ evidence: { read: async () => { throw new Error('fixture: port down'); } } }))
      .rejects.toMatchObject({ code: 'TRIAL_EVIDENCE_UNAVAILABLE' });
    expect(new FakeDatabase().receipts.size).toBe(0);
  });

  it('rejects a legacy candidate, a foreign resource, bad trusted inputs and an unhealthy clock', async () => {
    await expect(issue({}, { candidate: candidate({ package: legacyPackage, template_pins: [] }) }))
      .rejects.toMatchObject({ code: 'TRIAL_RECEIPT_TEMPLATE_REQUIRED' });
    await expect(issue({}, { resource: { type: 'instance', id: 8 } }))
      .rejects.toMatchObject({ code: 'TRIAL_BINDING_IDENTITY' });
    await expect(issue({ dependencyDigest: 'not-a-digest' as HashId }))
      .rejects.toMatchObject({ code: 'TRIAL_TRUSTED_INPUT_INVALID' });
    await expect(issue({ ttlMs: 0 })).rejects.toMatchObject({ code: 'TRIAL_TRUSTED_INPUT_INVALID' });
    await expect(issue({ now: () => Promise.resolve(NOW) }))
      .rejects.toMatchObject({ code: 'TRIAL_TIME_UNAVAILABLE' });
    await expect(issue({ now: () => 'not-a-time' }))
      .rejects.toMatchObject({ code: 'TRIAL_TIME_UNAVAILABLE' });
  });

  it('rejects a writer input that is not the two host columns', async () => {
    const db = new FakeDatabase();
    const issued: IssuedTrialReceipt = await issue();
    await expect(write(db, { ...issued, extra: true }))
      .rejects.toMatchObject({ code: 'TRIAL_RECEIPT_WRITE_INVALID' });
    await expect(write(db, { receipt_id: 'receipt-9', payload: issued.payload }))
      .rejects.toMatchObject({ code: 'TRIAL_RECEIPT_WRITE_INVALID' });
    await expect(write(db, { receipt_id: RECEIPT_ID, payload: 'not-an-object' }))
      .rejects.toMatchObject({ code: 'TRIAL_RECEIPT_WRITE_INVALID' });
    expect(db.receipts.size).toBe(0);
  });

  it('keeps the rejection type stable for callers', () => {
    expect(new TrialReceiptIssueError('TRIAL_EVIDENCE_INVALID').name).toBe('TrialReceiptIssueError');
    expect(new TrialReceiptWriteError('TRIAL_RECEIPT_WRITER_UNAVAILABLE').message)
      .toBe('TRIAL_RECEIPT_WRITER_UNAVAILABLE');
  });
});
