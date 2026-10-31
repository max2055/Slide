/**
 * MAX-238 / B2F — store-owned template gateway + shared-reader fence, on one SQL
 * fixture. The fixture is an in-memory model of the binding/group/audit/operation
 * tables and of one MySQL connection; it is not MySQL. It proves the wiring, the
 * single lease and the statement order, not real transactions, CAS or permissions.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
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
import { bindingCandidateDigest, type TrustedAuthorization } from '../bindings/transaction-guard.js';
import { resolveTemplateBinding, templateResolutionIdentity, type TemplateResolutionContext } from '../bindings/resolve.js';
import { compileBindingCandidate } from '../bindings/compile.js';
import type { TemplateVersionReadPort } from '../bindings/preflight.js';
import { decodeBindingPayload } from '../bindings/persistence-codec.js';
import {
  MYSQL_BINDING_HOST_SQL, type TrustedBindingInputs,
} from '../bindings/mysql-host.js';
import { readStoredBinding, TEMPLATE_BINDING_UNSUPPORTED, TemplateBindingUnsupportedError } from '../bindings/package-reader.js';
import { MysqlPolicyStore } from './store.js';
import { PolicyService } from './service.js';
import { TEMPLATE_GATEWAY_CONTRACT, TemplateGatewayError, TEMPLATE_GATEWAY_UNAVAILABLE } from './template-gateway.js';
import { admin, resource as policyResource } from './test-support.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MetricScheduler } from '../scheduler/service.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { MysqlRolloutCoordinator } from '../rollout/coordinator.js';
import { MetricFormalization } from '../rollout/formalization.js';
import { MysqlPortfolioInventory, PORTFOLIO_TEMPLATE_BINDING_UNSUPPORTED } from '../rollout/portfolio.js';
import { MetricConfigurationService } from '../config/service.js';
import { MetricConsumerService } from '../consumers/service.js';
import { BulkConfigurationService } from '../bulk/service.js';
import { platformLogs } from '../../platform/structured-log-evidence-adapter.js';

vi.mock('../config/effective-state.js', () => ({ assetCollectionEnabled: async () => true }));

const T0 = '2026-10-01T00:00:00Z';
const T1 = '2026-10-02T00:00:00Z';
const AT = '2026-09-18T00:00:00.000Z';
const NOW = '2026-10-03T00:00:00Z';
const ISSUED = '2026-10-02T12:00:00Z';
const EXPIRES = '2026-10-04T00:00:00Z';
const DEP = `sha256:${'d'.repeat(64)}`;
const RESOURCE = { type: 'instance' as const, id: 7 };
const RESOURCE_KEY = 'instance:7';

// --- template fixtures (same accepted package/template shape as B2E) --------

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
const templateV2 = templateVersion({ items: [item('alpha-item', alpha), item('beta-item', beta)], version: 2, parameters: parameters(60000) });
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
    resource: { ...RESOURCE }, package: null, group_id: 'web',
    overrides: { interval_ms: { mode: 'set', value: 30000 }, template_parameters: { 'tpl-one': { interval_ms: 40000 } } },
    revision: 4, template_pins: [pin(templateV1)],
    ...overrides,
  } as ResourceBindingCandidate;
}
const request = (overrides: Record<string, unknown> = {}) => ({
  resource: { ...RESOURCE }, candidate: candidate(), receipt_id: 'receipt-1', caller_key: 'caller-1', ...overrides,
});
const allowed = (dependency: HashId = DEP): TrustedAuthorization => ({ allowed: true, cancelled: false, dependency_digest: dependency });
const trustedResource = () => ({
  type: 'instance', id: '7',
  attributes: { 'db.engine': { value: 'fixture', observed_at: AT, source: 'fixture' } },
});
const trustedGroup = (overrides: Record<string, unknown> = {}) => ({ id: 'web', revision: 2, policy_revision: 2, overrides });
const supported = (...metrics: ExtensionDefinition[]) => metrics.map(definition => ({
  resource_id: '7', metric: metricRef(definition), method: 'sql' as const, status: 'supported' as const,
  basis: [{ kind: 'permission' as const, evidence: 'fixed_read_succeeded' }],
  evaluated_at: AT, valid_until: '2026-10-05T00:00:00.000Z',
}));
const trustedContext = () => ({
  resource: trustedResource(), group: trustedGroup(), capabilities: supported(alpha, beta), at: AT, actor_id: 9,
});
function resolutionContext(overrides: Record<string, unknown> = {}): TemplateResolutionContext {
  const base = trustedContext();
  return { resource: base.resource, group: base.group, capabilities: base.capabilities, at: base.at, ...overrides };
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
async function identityFor(input: unknown = candidate(), context: TemplateResolutionContext = resolutionContext()): Promise<HashId> {
  const outcome = await resolveTemplateBinding(input, context, templatePort(), fixtureRegistry());
  if (outcome.kind !== 'template_resolution') throw new Error('fixture resolution must not be legacy');
  return templateResolutionIdentity(outcome);
}
async function boundReceipt(overrides: Record<string, unknown> = {}) {
  return {
    receipt_version: 2, receipt_id: 'receipt-1', resource: { ...RESOURCE },
    base_revision: 4, target_revision: 5,
    candidate_digest: await digestFor(), resolution_identity: await identityFor(),
    dependency_digest: DEP, issued_at: ISSUED, expires_at: EXPIRES,
    items: [qualified(alphaRef), qualified(betaRef)], optional_exclusions: [],
    ...overrides,
  };
}

// --- the legacy row the template candidate replaces ------------------------

function legacyResolved() {
  return resolvePolicy(
    fixtureRegistry(),
    { resource: { ...RESOURCE }, package: legacyPackage, group_id: 'web', overrides: {}, revision: 4 },
    trustedGroup(), trustedResource() as never, supported(alpha, beta), AT,
  );
}
function legacyPublished(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    binding: { resource: { ...RESOURCE }, package: legacyPackage, group_id: 'web', overrides: {}, revision: 4 },
    resolved: legacyResolved(),
    published_at: T1,
    application: { applied_revision: 4, reported_at: T1, status: 'applied', error_code: null },
    ...overrides,
  };
}

// --- in-memory SQL fixture: store SQL + host SQL on one connection --------

type SqlKey =
  | 'begin' | 'commit' | 'rollback' | 'release' | 'destroy'
  | 'lock' | 'groups' | 'group' | 'members' | 'bindingRead' | 'bindingLock' | 'capabilities'
  | 'saveCapabilities' | 'saveGroup' | 'saveBinding' | 'auditInsert' | 'auditAll' | 'auditRequest'
  | 'scan' | 'receiptRead' | 'operationRead' | 'consumptionRead' | 'operationInsert' | 'bindingUpdate'
  | 'assets' | 'fingerprint' | 'rolloutSeries' | 'rolloutResources';

interface BindingRow { payload: string; group_id: string | null; capabilities: string }
interface AuditRecord { id: number; target: string; payload: string }
interface OperationRecord {
  caller_key: string; receipt_id: string; resource_type: string; resource_id: number; resource_key: string;
  target_revision: number; candidate_digest: string; resolution_identity: string; dependency_digest: string; status: string;
}
interface State {
  bindings: Map<string, BindingRow>;
  groups: Map<string, string>;
  audits: AuditRecord[];
  operations: OperationRecord[];
  pending: { binding: number; operation: number; audit: number };
}
interface SqlEvent { connection: number; at: SqlKey; sql: string; params: unknown[] }

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const STATEMENTS: Array<[SqlKey, string]> = [
  ['lock', 'SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE'],
  ['groups', 'SELECT payload FROM metric_policy_groups ORDER BY id'],
  ['group', 'SELECT payload FROM metric_policy_groups WHERE id = ?'],
  ['members', 'SELECT payload FROM metric_policy_bindings WHERE group_id = ? ORDER BY resource_key'],
  ['bindingRead', 'SELECT payload FROM metric_policy_bindings WHERE resource_key = ?'],
  ['bindingLock', 'SELECT payload FROM metric_policy_bindings WHERE resource_key = ? FOR UPDATE'],
  ['capabilities', 'SELECT capabilities FROM metric_policy_bindings WHERE resource_key = ?'],
  ['saveCapabilities', 'UPDATE metric_policy_bindings SET capabilities = ? WHERE resource_key = ?'],
  ['saveGroup', 'INSERT INTO metric_policy_groups (id, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)'],
  ['saveBinding', 'INSERT INTO metric_policy_bindings (resource_key, group_id, payload, capabilities) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE group_id = VALUES(group_id), payload = VALUES(payload)'],
  ['auditInsert', 'INSERT INTO metric_policy_audit (target, payload) VALUES (?, ?)'],
  ['auditAll', 'SELECT payload FROM metric_policy_audit WHERE target = ? ORDER BY id DESC LIMIT 100'],
  ['auditRequest', "SELECT payload FROM metric_policy_audit WHERE target = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.request_id')) = ? ORDER BY id DESC LIMIT 1"],
  ['scan', 'SELECT resource_key, payload FROM metric_policy_bindings ORDER BY resource_key'],
  ['receiptRead', MYSQL_BINDING_HOST_SQL.receiptRead],
  ['operationRead', MYSQL_BINDING_HOST_SQL.operationRead],
  ['consumptionRead', MYSQL_BINDING_HOST_SQL.consumptionRead],
  ['operationInsert', MYSQL_BINDING_HOST_SQL.operationInsert],
  ['bindingUpdate', MYSQL_BINDING_HOST_SQL.bindingUpdate],
  ['rolloutSeries', 'SELECT series_hash FROM metric_rollout WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash'],
];
const NORMALIZED = new Map(STATEMENTS.map(([key, statement]) => [normalize(statement), key]));
const keyOf = (sql: string): SqlKey | null => {
  const text = normalize(sql);
  const exact = NORMALIZED.get(text);
  if (exact) return exact;
  if (text.startsWith('SELECT SHA2(CAST(JSON_ARRAY')) return 'fingerprint';
  if (text.includes('FROM database_instances') || text.includes('FROM servers') || text.includes('FROM network_devices')) return 'assets';
  if (text.startsWith('SELECT resources.resource_key')) return 'rolloutResources';
  return null;
};
const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  throw new Error('fixture: expected a string or UTF-8 buffer parameter');
};
const duplicateEntry = (): Error => Object.assign(new Error('fixture duplicate entry'), { code: 'ER_DUP_ENTRY' });
const clone = <T>(value: T): T => structuredClone(value);

class FakeDatabase {
  bindings = new Map<string, BindingRow>();
  groups = new Map<string, string>();
  audits: AuditRecord[] = [];
  operations: OperationRecord[] = [];
  receipts = new Map<string, unknown>();
  writes = { binding: 0, operation: 0, audit: 0 };
  log: SqlEvent[] = [];
  nextAudit = 1;
  connections: FakeConnection[] = [];

  seed(): void {
    this.bindings.set(RESOURCE_KEY, { payload: JSON.stringify(legacyPublished()), group_id: 'web', capabilities: '[]' });
    this.groups.set('web', JSON.stringify(trustedGroup()));
  }
  eventNames(): SqlKey[] { return this.log.map(entry => entry.at); }
  connectionIds(): number[] { return [...new Set(this.log.map(entry => entry.connection))]; }
}

class FakePool {
  active = 0;
  maxActive = 0;
  constructor(readonly db: FakeDatabase) {}
  async getConnection(): Promise<FakeConnection> {
    this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    const connection = new FakeConnection(this.db, this);
    this.db.connections.push(connection);
    return connection;
  }
  released(): void { this.active--; }
  async query(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    return dispatch(this.db, null, sql, params);
  }
  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    return dispatch(this.db, null, sql, params);
  }
}

class FakeConnection {
  readonly id: number;
  state: 'new' | 'open' | 'committed' | 'rolled_back' | 'released' | 'destroyed' = 'new';
  private tx: State | null = null;
  constructor(readonly db: FakeDatabase, readonly pool: FakePool) { this.id = db.connections.length + 1; }

  async beginTransaction(): Promise<void> {
    this.record('begin', [], 'BEGIN');
    if (this.state !== 'new') throw new Error('fixture: transaction already begun');
    this.state = 'open';
    this.tx = {
      bindings: new Map([...this.db.bindings].map(([key, row]) => [key, { ...row }])),
      groups: new Map(this.db.groups), audits: clone(this.db.audits), operations: clone(this.db.operations),
      pending: { binding: 0, operation: 0, audit: 0 },
    };
  }

  record(at: SqlKey, params: unknown[], sql: string): void {
    this.db.log.push({ connection: this.id, at, sql, params });
  }
  private stateFor(read: boolean): State {
    if (this.state === 'open' && this.tx) return this.tx;
    if (read && (this.state === 'new' || this.state === 'rolled_back' || this.state === 'released')) {
      return { bindings: this.db.bindings, groups: this.db.groups, audits: this.db.audits, operations: this.db.operations, pending: { binding: 0, operation: 0, audit: 0 } };
    }
    throw new Error('fixture: statement outside an open transaction');
  }

  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    return dispatch(this.db, this, sql, params);
  }

  async commit(): Promise<void> {
    this.record('commit', [], 'COMMIT');
    const tx = this.stateFor(false);
    this.db.bindings = tx.bindings; this.db.groups = tx.groups; this.db.audits = tx.audits; this.db.operations = tx.operations;
    this.db.writes.binding += tx.pending.binding; this.db.writes.operation += tx.pending.operation; this.db.writes.audit += tx.pending.audit;
    this.tx = null; this.state = 'committed';
  }
  async rollback(): Promise<void> {
    this.record('rollback', [], 'ROLLBACK');
    if (this.state !== 'open') throw new Error('fixture: rollback outside transaction');
    this.tx = null; this.state = 'rolled_back';
  }
  release(): void { this.record('release', [], 'RELEASE'); this.state = 'released'; this.pool.released(); }
  destroy(): void { this.record('destroy', [], 'DESTROY'); this.state = 'destroyed'; this.pool.released(); }
}

function dispatch(db: FakeDatabase, connection: FakeConnection | null, sql: string, params: unknown[]): [unknown, unknown] {
  const key = keyOf(sql);
  if (key === null) throw new Error(`fixture: unexpected SQL ${sql}`);
  if (key === 'begin' || key === 'commit' || key === 'rollback' || key === 'release' || key === 'destroy') throw new Error('fixture: lifecycle through dispatch');
  connection?.record(key, params, sql);
  const read = ['lock', 'groups', 'group', 'members', 'bindingRead', 'bindingLock', 'capabilities', 'auditAll', 'auditRequest',
    'scan', 'receiptRead', 'operationRead', 'consumptionRead', 'assets', 'fingerprint', 'rolloutSeries', 'rolloutResources'].includes(key);
  const state: State = connection === null
    ? { bindings: db.bindings, groups: db.groups, audits: db.audits, operations: db.operations, pending: { binding: 0, operation: 0, audit: 0 } }
    : (connection as unknown as { stateFor(read: boolean): State }).stateFor(read);
  switch (key) {
    case 'lock': return [[{ id: 1 }], []];
    case 'groups': return [[...state.groups.values()].map(payload => ({ payload })), []];
    case 'group': return [state.groups.has(textOf(params[0])) ? [{ payload: state.groups.get(textOf(params[0])) }] : [], []];
    case 'members': return [[...state.bindings].filter(([, row]) => row.group_id === textOf(params[0]))
      .sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => ({ payload: row.payload })), []];
    case 'bindingRead': case 'bindingLock': {
      const row = state.bindings.get(textOf(params[0]));
      return [row === undefined ? [] : [{ payload: row.payload }], []];
    }
    case 'capabilities': {
      const row = state.bindings.get(textOf(params[0]));
      return [row === undefined ? [] : [{ capabilities: row.capabilities }], []];
    }
    case 'saveCapabilities': {
      const row = state.bindings.get(textOf(params[1]));
      if (row) row.capabilities = textOf(params[0]);
      return [{ affectedRows: row ? 1 : 0 }, []];
    }
    case 'saveGroup': {
      state.groups.set(textOf(params[0]), textOf(params[1]));
      return [{ affectedRows: 1 }, []];
    }
    case 'saveBinding': {
      const key = textOf(params[0]);
      const existing = state.bindings.get(key);
      state.bindings.set(key, { payload: textOf(params[2]), group_id: params[1] === null ? null : textOf(params[1]), capabilities: existing?.capabilities ?? textOf(params[3]) });
      state.pending.binding += 1;
      return [{ affectedRows: 1 }, []];
    }
    case 'bindingUpdate': {
      const key = textOf(params[2]);
      const row = state.bindings.get(key);
      const stored = row ? JSON.parse(row.payload) as { binding?: { revision?: unknown } } : null;
      if (!row || stored?.binding?.revision !== Number(params[3])) return [{ affectedRows: 0 }, []];
      row.payload = textOf(params[0]); row.group_id = textOf(params[1]);
      state.pending.binding += 1;
      return [{ affectedRows: 1 }, []];
    }
    case 'auditInsert': {
      state.audits.push({ id: db.nextAudit++, target: textOf(params[0]), payload: textOf(params[1]) });
      state.pending.audit += 1;
      return [{ affectedRows: 1 }, []];
    }
    case 'auditAll': return [state.audits.filter(entry => entry.target === textOf(params[0]))
      .sort((left, right) => right.id - left.id).slice(0, 100).map(entry => ({ payload: entry.payload })), []];
    case 'auditRequest': {
      const request = textOf(params[1]);
      const rows = state.audits.filter(entry => entry.target === textOf(params[0])
        && (JSON.parse(entry.payload) as { request_id?: unknown }).request_id === request)
        .sort((left, right) => right.id - left.id).slice(0, 1).map(entry => ({ payload: entry.payload }));
      return [rows, []];
    }
    case 'scan': return [[...state.bindings].sort(([left], [right]) => left.localeCompare(right))
      .map(([resource_key, row]) => ({ resource_key, payload: row.payload })), []];
    case 'receiptRead': {
      const value = db.receipts.get(textOf(params[0]));
      return [value === undefined ? [] : [{ payload: JSON.stringify(value) }], []];
    }
    case 'operationRead': return [state.operations.filter(entry => entry.caller_key === textOf(params[0])).slice(0, 2), []];
    case 'consumptionRead': return [state.operations.filter(entry => entry.receipt_id === textOf(params[0])).slice(0, 2).map(entry => ({ caller_key: entry.caller_key })), []];
    case 'operationInsert': {
      const record: OperationRecord = {
        caller_key: textOf(params[0]), receipt_id: textOf(params[1]), resource_type: textOf(params[2]),
        resource_id: Number(params[3]), resource_key: textOf(params[4]), target_revision: Number(params[5]),
        candidate_digest: textOf(params[6]), resolution_identity: textOf(params[7]), dependency_digest: textOf(params[8]), status: textOf(params[9]),
      };
      if (state.operations.some(entry => entry.caller_key === record.caller_key || entry.receipt_id === record.receipt_id)) throw duplicateEntry();
      state.operations.push(record); state.pending.operation += 1;
      return [{ affectedRows: 1 }, []];
    }
    case 'assets': return [[], []];
    case 'fingerprint': return [[{ fingerprint: 'fixture-fingerprint' }], []];
    case 'rolloutSeries': return [[], []];
    case 'rolloutResources': return [[], []];
    default: throw new Error(`fixture: no handler for ${key}`);
  }
}

// --- wiring under test ------------------------------------------------------

function makeStore(db: FakeDatabase) {
  const pool = new FakePool(db);
  const factoryConnections: number[] = [];
  const inputs: TrustedBindingInputs = {
    authorize: async () => allowed(),
    applicationContext: async () => trustedContext(),
    mandatoryItems: async () => [],
    templateVersions: () => templatePort(),
  };
  const store = new MysqlPolicyStore(() => pool as unknown as Pool, {
    trustedInputs: connection => { factoryConnections.push((connection as unknown as FakeConnection).id); return inputs; },
    trustedNow: () => NOW,
    registry: fixtureRegistry(),
  });
  return { store, pool, factoryConnections };
}
const asPool = (pool: FakePool): Pool => pool as unknown as Pool;
const policyOf = (store: MysqlPolicyStore) => new PolicyService(store, fixtureRegistry(), {
  exists: async () => true, inventory: async () => trustedResource() as never,
}, () => AT);

async function applied(db: FakeDatabase) {
  const wiring = makeStore(db);
  const outcome = await wiring.store.templateGateway().apply(request());
  if (outcome.kind !== 'committed') throw new Error(`fixture apply did not commit: ${outcome.kind}`);
  return wiring;
}
const templatePayload = (db: FakeDatabase): string => db.bindings.get(RESOURCE_KEY)!.payload;

const rejection = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (error) {
    if (error instanceof TemplateBindingUnsupportedError) return error.code;
    if (error instanceof Error && error.message === TEMPLATE_BINDING_UNSUPPORTED) return error.message;
    if (error instanceof Error && 'code' in error) return String((error as { code: unknown }).code);
    // Plain stable codes used by the non-policy readers.
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) return error.message;
    throw error;
  }
  throw new Error('expected the legacy reader to fail closed');
};

describe('store-owned template gateway (SQL fixture)', () => {
  it('is a stable "unavailable" on the default store and never opens a connection', async () => {
    const db = new FakeDatabase();
    const pool = new FakePool(db);
    const gateway = new MysqlPolicyStore(() => asPool(pool)).templateGateway();
    expect(gateway.available).toBe(false);
    await expect(gateway.apply(request())).rejects.toMatchObject({ code: TEMPLATE_GATEWAY_UNAVAILABLE });
    await expect(gateway.lookupOperation('caller-1')).rejects.toBeInstanceOf(TemplateGatewayError);
    expect(db.connections).toHaveLength(0);
  });

  it('applies the accepted template path on one lease with the host lock order and only pending writes', async () => {
    const db = new FakeDatabase();
    db.seed();
    db.receipts.set('receipt-1', await boundReceipt());
    const { store, pool, factoryConnections } = makeStore(db);
    const outcome = await store.templateGateway().apply(request());

    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') throw new Error('unreachable');
    expect(outcome.revision).toBe(5);
    expect(db.connectionIds()).toEqual([1]);
    expect(factoryConnections).toEqual([1]);
    expect(pool.maxActive).toBe(1);
    expect(db.writes).toEqual({ binding: 1, operation: 1, audit: 1 });
    expect(db.eventNames().indexOf('begin')).toBeLessThan(db.eventNames().indexOf('lock'));
    expect(TEMPLATE_GATEWAY_CONTRACT.lock_order.slice(1, 3)).toEqual(['host BEGIN', 'metric_policy_lock id=1 FOR UPDATE']);

    const stored = decodeBindingPayload(templatePayload(db));
    expect(stored.kind).toBe('template_pending');
    if (stored.kind !== 'template_pending') throw new Error('unreachable');
    expect(stored.pending).toMatchObject({ base_revision: 4, target_revision: 5 });
    // Only the pending candidate is written; the legacy effective value and the
    // applied revision are preserved.
    expect(stored.application.status).toBe('pending');
    expect(stored.application.applied_revision).toBe(4);
    expect(stored.effective).toEqual({ source: 'package', revision: 4, resolution_identity: null, resolved: legacyResolved() });
    // The template row is now identified as such by the shared fence.
    expect(readStoredBinding(templatePayload(db)).source).toBe('template');
  });

  it('replays exactly, looks up unknown operations without resending, and shares the store admission gate', async () => {
    const db = new FakeDatabase();
    db.seed();
    db.receipts.set('receipt-1', await boundReceipt());
    const { store, pool } = makeStore(db);
    await applied(db);

    const before = structuredClone(db.writes);
    const replay = await store.templateGateway().apply(request());
    expect(replay.kind).toBe('replay');
    expect(db.writes).toEqual(before);

    const found = await store.templateGateway().lookupOperation('caller-1');
    expect(found.complete).toBe(true);
    expect(found.operation).toMatchObject({ caller_key: 'caller-1', target_revision: 5, status: 'committed' });
    const missing = await store.templateGateway().lookupOperation('caller-2');
    expect(missing).toEqual({ complete: true, operation: null });

    // A concurrent policy transaction and a gateway call serialize on the same
    // admission queue, so only one connection is ever leased at a time.
    pool.maxActive = 0;
    await Promise.all([
      store.transaction(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }),
      store.templateGateway().lookupOperation('caller-1'),
    ]);
    expect(pool.maxActive).toBe(1);
  });

  it('refuses a missing receipt and a missing trusted factory without writes', async () => {
    const db = new FakeDatabase();
    db.seed();
    const wiring = makeStore(db);
    // A missing receipt is a guard rejection: the host never stages a write.
    expect(await rejection(wiring.store.templateGateway().apply(request()))).toBe('TRANSACTION_RECEIPT_NOT_FOUND');
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });

    const bare = new MysqlPolicyStore(() => asPool(wiring.pool), {
      trustedInputs: undefined as never, trustedNow: () => NOW, registry: fixtureRegistry(),
    });
    await expect(bare.templateGateway().apply(request())).rejects.toMatchObject({ code: 'HOST_INPUTS_UNAVAILABLE' });
    expect(db.writes).toEqual({ binding: 0, operation: 0, audit: 0 });
  });
});

describe('legacy readers refuse a stored template row (shared fence)', () => {
  const seedApplied = async (): Promise<{ db: FakeDatabase; store: MysqlPolicyStore }> => {
    const db = new FakeDatabase();
    db.seed();
    db.receipts.set('receipt-1', await boundReceipt());
    const { store } = await applied(db);
    return { db, store };
  };

  it('fences policy reads, writes, report paths and audits with zero writes', async () => {
    const { db, store } = await seedApplied();
    const policy = policyOf(store);
    const before = structuredClone(db.writes);

    expect(await rejection(policy.binding(admin, RESOURCE))).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(await rejection(policy.effective(admin, RESOURCE))).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(await rejection(policy.audits(admin, RESOURCE))).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(await rejection(policy.changeBinding(admin, RESOURCE, { expected_revision: 5 }, true))).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(await rejection(policy.changeGroup(admin, 'web', { expected_revision: 2, overrides: {} }, true))).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(await rejection(store.reportApplied(RESOURCE, 5, AT, 'applied'))).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(await rejection(store.reportCapabilities(RESOURCE, 5, [], null))).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    // A direct saveBinding cannot bypass the accepted row guard either.
    expect(await rejection(store.transaction(tx => tx.saveBinding(legacyPublished() as never, false)))).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(db.writes).toEqual(before);
    expect(db.groups.get('web')).toBe(JSON.stringify(trustedGroup()));
  });

  it('isolates the scheduler scan, refuses current/list/enqueue before resource IO and never retries', async () => {
    const { db } = await seedApplied();
    const schedulerStore = new MysqlScheduleStore(asPool(new FakePool(db)), fixtureRegistry());
    const scan = await schedulerStore.scan();
    // A template row is its own scan class: it is executed from its pending plan
    // and never enters the legacy `published` list.
    expect(scan.published).toEqual([]);
    expect(scan.rejected).toEqual([]);
    expect(scan.templates.map(entry => entry.resource_key)).toEqual([RESOURCE_KEY]);
    expect(scan.templates[0].decoded.binding.revision).toBe(5);
    expect(await rejection(schedulerStore.list())).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(await rejection(schedulerStore.current(asPool(new FakePool(db)), RESOURCE))).toBe(TEMPLATE_BINDING_UNSUPPORTED);

    // Direct enqueue discerns a non-legacy candidate before instance/resource IO.
    const lifecycle = await import('../../resources/instance-access-lifecycle.js');
    const assertAvailable = vi.spyOn(lifecycle.instanceAccessLifecycle, 'assertAvailable');
    const legacyCandidate = { ...legacyPublished(), binding: { ...(legacyPublished().binding as object), package: null } } as never;
    expect(await rejection(schedulerStore.enqueue(legacyCandidate, 0))).toBe('BINDING_PAYLOAD_MISSING_SOURCE');
    expect(assertAvailable).not.toHaveBeenCalled();

    // tick() isolates the rejected row and a stale enqueue instead of throwing.
    const record = vi.spyOn(platformLogs, 'record');
    const stub = {
      scan: async () => ({ published: [legacyPublished() as never], templates: [],
        rejected: [{ resource_key: RESOURCE_KEY, code: TEMPLATE_BINDING_UNSUPPORTED }] }),
      enqueue: async () => { throw new TemplateBindingUnsupportedError(); },
    } as unknown as MysqlScheduleStore;
    expect(await new MetricScheduler(stub, fixtureRegistry(), {} as never, () => 0).tick()).toBe(0);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ errorCode: TEMPLATE_BINDING_UNSUPPORTED, status: 'failed' }));

    // A job whose row was replaced by a template row ends with one sanitized
    // diagnostic, not a retry loop: the handler returns and records the code.
    const events: string[] = [];
    const jobStore = {
      pool: {},
      reserve: async () => ({ connection: { ping: async () => undefined }, release: async () => undefined }),
      currentTemplate: async () => null,
      current: async () => { throw new TemplateBindingUnsupportedError(); },
      event: async (_ref: unknown, _revision: number, _job: string, code: string) => { events.push(code); },
    } as unknown as MysqlScheduleStore;
    const scheduler = new MetricScheduler(jobStore, fixtureRegistry(), {} as never, () => 0);
    const jobs = new JobRegistry();
    scheduler.register(jobs);
    await jobs.execute({ id: 'job-1', type: 'metrics.collect', payload: { resource: { type: 'server', id: 7 }, revision: 5 },
      attempts: 1, maxAttempts: 3, fencingToken: 1 });
    expect(events).toEqual(['template_binding_unsupported']);
  });

  it('fences the rollout coordinator, formalization cache, portfolio inventory', async () => {
    const { db } = await seedApplied();
    expect(await rejection(new MysqlRolloutCoordinator(asPool(new FakePool(db)))
      .startShadow(RESOURCE, 5, { userId: 1, requestId: 'review' }))).toBe(TEMPLATE_BINDING_UNSUPPORTED);

    const bindingReads = db.log.filter(entry => entry.at === 'bindingRead').length;
    const formalization = new MetricFormalization(asPool(new FakePool(db)), fixtureRegistry());
    await formalization.reconcile(RESOURCE, 4);
    await formalization.reconcile(RESOURCE, 4);
    // The template row is now a formalization candidate (skipped without a
    // committed sample batch) and its fingerprint is cached like the package path.
    expect(db.log.filter(entry => entry.at === 'bindingRead').length - bindingReads).toBe(1);

    expect(await rejection(new MysqlPortfolioInventory(asPool(new FakePool(db)), []).list()))
      .toBe(PORTFOLIO_TEMPLATE_BINDING_UNSUPPORTED);
    expect(db.writes).toEqual({ binding: 1, operation: 1, audit: 1 });
  });

  it('fences config trial/status, consumer discovery and bulk preview before reserve/credential/runner', async () => {
    const { db, store } = await seedApplied();
    const policy = policyOf(store);
    const reserve = vi.fn(async () => ({ release: async () => undefined, connection: { ping: async () => undefined } }));
    const resolve = vi.fn(async () => { throw new Error('must not resolve a credential'); });
    const evidence = vi.fn(async () => { throw new Error('must not read evidence'); });
    const inventory = vi.fn(async () => policyResource(7));
    const config = new MetricConfigurationService(policy, fixtureRegistry(),
      { reserve, attempts: async () => [] }, { resolve } as never, { evidence, inventory } as never);

    expect(await rejection(config.trial(admin, RESOURCE, { expected_revision: 5 }))).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(reserve).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(await rejection(config.status(admin, RESOURCE))).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(evidence).not.toHaveBeenCalled();

    const consumerInventory = vi.fn(async () => { throw new Error('must not read consumer inventory'); });
    const consumer = new MetricConsumerService(policy, fixtureRegistry(), { inventory: consumerInventory } as never);
    expect(await rejection(consumer.discover(admin, RESOURCE))).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(consumerInventory).not.toHaveBeenCalled();

    const saved: unknown[] = [];
    const bulkStore = {
      create: vi.fn(async (job: unknown) => { saved.push(job); return job; }),
      get: vi.fn(), save: vi.fn(), list: vi.fn(), cancel: vi.fn(), cancelled: async () => false,
      exclusive: vi.fn(async (fn: () => Promise<unknown>) => fn()), fence: vi.fn(),
    };
    const bulk = new BulkConfigurationService(policy, config, bulkStore as never,
      async () => admin as never, () => AT);
    const preview = await bulk.preview(admin, { key: 'bulk-proof-1', resources: [RESOURCE] });
    expect((preview as unknown as { items: Array<{ code: string | null }> }).items[0].code).toBe(TEMPLATE_BINDING_UNSUPPORTED);
    expect(reserve).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(evidence).not.toHaveBeenCalled();
    // Reading package recommendations may read inventory; no policy/collection write happens.
    expect(db.writes).toEqual({ binding: 1, operation: 1, audit: 1 });
    expect(saved).toHaveLength(1);
  });
});
