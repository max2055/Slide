import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { Value } from '@sinclair/typebox/value';
import { ActorContextService, ActorAuthenticationError, type ActorContext } from '../auth/actor-context.js';
import { isValidInvestigationServiceIdentity } from '../auth/investigation-service-identity.js';
import { hasPermission } from '../auth/require-permission.js';
import { DEFAULT_CONFIG } from '../ai-analysis-config-service.js';
import { freezeInvestigationCaller } from './authorization.js';
import { MysqlInvestigationBudgetLedger, AUTOMATIC_ALERT_RESERVE_TOKENS, type BudgetPolicy } from './budget-ledger.js';
import { investigationBudgetConfiguration } from './session-bridge.js';
import { InvestigationBudgetPolicySchema, type InvestigationPoliciesResponse, type InvestigationBudgetResponse,
  type InvestigationUsageResponse } from './governance-contracts.js';
import { databaseAlertPilotConfiguration, investigationBridgeFlags } from './bridge-flags.js';
import { deriveAutomaticAnalysisFacts, type ScopeStatus } from './automatic-analysis-status.js';
import { InvestigationEffectiveBudgetError, InvestigationEffectiveBudgetService, resolveAdmissionConfiguration,
  type EffectiveBudgetAuditContext } from './effective-budget.js';

export class GovernanceReadError extends Error {
  constructor(readonly code: 'GOVERNANCE_FORBIDDEN' | 'GOVERNANCE_UNAVAILABLE') { super(code); }
}
const unavailable = () => new GovernanceReadError('GOVERNANCE_UNAVAILABLE');
const number = (value: unknown): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw unavailable();
  return result;
};
const bigint = (value: unknown): bigint => {
  try {
    const result = BigInt(typeof value === 'bigint' ? value : String(value ?? 0));
    if (result < 0n) throw new Error('negative');
    return result;
  } catch { throw unavailable(); }
};
const json = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
const policy = (value: unknown): BudgetPolicy => {
  if (!Value.Check(InvestigationBudgetPolicySchema, value)) throw unavailable();
  const p = value as BudgetPolicy;
  return { currency: p.currency, maxConcurrent: p.maxConcurrent, manualReserved: p.manualReserved,
    maxPerResourceConcurrent: p.maxPerResourceConcurrent, maxAutomaticRequestsPerHour: p.maxAutomaticRequestsPerHour,
    maxAutomaticTokensPerDay: p.maxAutomaticTokensPerDay, maxTotalTokensPerDay: p.maxTotalTokensPerDay,
    maxCostMicrosPerDay: p.maxCostMicrosPerDay };
};
async function rows(c: PoolConnection, sql: string, values: unknown[] = []) {
  return (await c.execute<RowDataPacket[]>(sql, values as never))[0];
}
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
const PILOT_MAX_RESOURCES = 20;
const RESOURCE_PERMISSION = { database: 'instance:view', server: 'servers:view', network_device: 'network_devices:view' } as const;
const RESOURCE_TABLE = { database: 'database_instances', server: 'servers', network_device: 'network_devices' } as const;
/** Alert column and ledger resource-key prefix per configured resource type.
 * A fixed pilot policy id never implies coverage of another type. */
const ALERT_COLUMN = { database: 'instance_id', server: 'server_id', network_device: 'network_device_id' } as const;
const RESOURCE_KEY_PREFIX = { database: 'instance', server: 'server', network_device: 'network_device' } as const;
type ResourceType = keyof typeof RESOURCE_PERMISSION;
type ResourceIds = Record<ResourceType, number[]>;
const QUOTA_REASONS = ['AUTOMATIC_FREQUENCY', 'AUTOMATIC_DAILY_TOKENS', 'TOTAL_DAILY_TOKENS', 'DAILY_COST'] as const;
const CAPACITY_REASONS = ['GLOBAL_CONCURRENCY', 'MANUAL_CAPACITY_RESERVED', 'RESOURCE_CONCURRENCY'] as const;
/** Only alerts whose resource is in the currently configured scope can say
 * anything about that scope; global history never stands in for it. */
function scopePredicate(ids: ResourceIds): { sql: string; values: unknown[] } | null {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const type of Object.keys(ALERT_COLUMN) as ResourceType[]) {
    if (!ids[type].length) continue;
    parts.push(`a.${ALERT_COLUMN[type]} IN (${ids[type].map(() => '?').join(',')})`);
    values.push(...ids[type]);
  }
  return parts.length ? { sql: `(${parts.join(' OR ')})`, values } : null;
}
/** SQL CASE mapping an alert row to the configured type it belongs to. */
function resourceTypeCase(ids: ResourceIds): { sql: string; values: unknown[] } {
  const branches: string[] = [];
  const values: unknown[] = [];
  for (const type of Object.keys(ALERT_COLUMN) as ResourceType[]) {
    if (!ids[type].length) continue;
    branches.push(`WHEN a.${ALERT_COLUMN[type]} IN (${ids[type].map(() => '?').join(',')}) THEN '${type}'`);
    values.push(...ids[type]);
  }
  return { sql: `CASE ${branches.join(' ')} ELSE NULL END`, values };
}
type ExecutionOutcome = NonNullable<InvestigationPoliciesResponse['execution']['lastStatus']>;
/** Durable state mapping: owners without an investigation were suppressed at
 * admission; otherwise the workflow job carries the real terminal outcome. */
function executionStatus(investigationId: unknown, jobState: unknown): ExecutionOutcome {
  if (investigationId == null) return 'suppressed';
  const job = typeof jobState === 'string' ? jobState : null;
  return job === 'queued' ? 'accepted'
    : job === 'running' || job === 'retry' ? 'running'
      : job === 'completed' ? 'completed'
        : job === 'dead_letter' ? 'failed'
          : job === 'cancelled' ? 'cancelled' : 'unknown';
}
const masterDefaults = (): InvestigationPoliciesResponse['masterSwitch'] => ({
  source: 'defaults', status: 'defaulted', enabled: DEFAULT_CONFIG.enabled,
  severityLevels: [...DEFAULT_CONFIG.severityLevels] as InvestigationPoliciesResponse['masterSwitch']['severityLevels'],
  timeWindowStart: DEFAULT_CONFIG.timeWindowStart, timeWindowEnd: DEFAULT_CONFIG.timeWindowEnd, instanceWhitelistCount: 0,
});
const masterInvalid = (): InvestigationPoliciesResponse['masterSwitch'] => ({
  source: 'system_config', status: 'invalid', enabled: false, severityLevels: [],
  timeWindowStart: '00:00', timeWindowEnd: '23:59', instanceWhitelistCount: 0,
});

/** The persisted master switch is the single total-switch source. Absence
 * means the loader defaults; a present but malformed value cannot enable
 * automatic analysis. Reading never repairs or rewrites it. */
async function masterSwitchFacts(c: PoolConnection): Promise<InvestigationPoliciesResponse['masterSwitch']> {
  const [row] = await rows(c, "SELECT config_value FROM system_config WHERE config_key = 'auto_analysis_config'");
  if (!row || row.config_value == null) return masterDefaults();
  let value: any;
  try { value = json(row.config_value); } catch { return masterInvalid(); }
  if (value == null) return masterDefaults();
  if (typeof value !== 'object' || Array.isArray(value)) return masterInvalid();
  const merged: Record<string, any> = { ...DEFAULT_CONFIG, ...value };
  const valid = typeof merged.enabled === 'boolean'
    && Array.isArray(merged.severityLevels) && merged.severityLevels.length > 0
    && merged.severityLevels.every((level: unknown) => typeof level === 'string' && (SEVERITIES as readonly string[]).includes(level))
    && Array.isArray(merged.instanceWhitelist)
    && merged.instanceWhitelist.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0)
    && typeof merged.timeWindowStart === 'string' && HHMM.test(merged.timeWindowStart)
    && typeof merged.timeWindowEnd === 'string' && HHMM.test(merged.timeWindowEnd);
  if (!valid) return masterInvalid();
  return { source: 'system_config', status: 'persisted', enabled: merged.enabled,
    severityLevels: [...merged.severityLevels] as InvestigationPoliciesResponse['masterSwitch']['severityLevels'],
    timeWindowStart: merged.timeWindowStart, timeWindowEnd: merged.timeWindowEnd,
    instanceWhitelistCount: merged.instanceWhitelist.length };
}

interface PilotEnvironment {
  serviceUserId: number; identityConfigured: boolean;
  ids: Record<keyof typeof RESOURCE_PERMISSION, number[]>;
  configuredCount: number; scopeStatus: ScopeStatus;
}
/** Operator environment only. Format validity is separate from whether the
 * referenced principal/resources still exist (checked live below). */
function pilotEnvironment(): PilotEnvironment {
  const pilot = databaseAlertPilotConfiguration();
  const raw = { database: pilot.instanceIds, server: pilot.serverIds ?? [], network_device: pilot.networkDeviceIds ?? [] };
  const ids = {} as Record<keyof typeof RESOURCE_PERMISSION, number[]>;
  let malformed = false;
  for (const type of Object.keys(raw) as Array<keyof typeof RESOURCE_PERMISSION>) {
    ids[type] = raw[type].filter(id => Number.isSafeInteger(id) && id > 0 && id <= 4_294_967_295);
    if (ids[type].length !== raw[type].length || new Set(raw[type]).size !== raw[type].length) malformed = true;
  }
  const configuredCount = Object.values(raw).reduce((sum, values) => sum + values.length, 0);
  const scopeStatus: ScopeStatus = configuredCount === 0 ? 'not_configured'
    : malformed || configuredCount > PILOT_MAX_RESOURCES ? 'invalid' : 'configured';
  return { serviceUserId: pilot.serviceUserId,
    identityConfigured: Number.isSafeInteger(pilot.serviceUserId) && pilot.serviceUserId > 0,
    ids, configuredCount, scopeStatus };
}

interface IdentityFacts {
  status: InvestigationPoliciesResponse['serviceIdentity']['status'];
  permissionsSufficient: boolean;
  missingPermissions: string[];
  instanceScopeSufficient: boolean;
  permissions: readonly string[];
  instanceScopes: Readonly<Record<number, unknown>>;
}
const identityUnready = (status: IdentityFacts['status']): IdentityFacts => ({
  status, permissionsSufficient: false, missingPermissions: [], instanceScopeSufficient: true,
  permissions: [], instanceScopes: {},
});
/** The dedicated service principal is resolved live on this connection; an
 * interactive admin is never substituted for it. */
async function serviceIdentityFacts(c: PoolConnection, contexts: ActorContextService,
  environment: PilotEnvironment, required: string[]): Promise<IdentityFacts> {
  if (!environment.identityConfigured) return identityUnready('not_configured');
  const [user] = await rows(c, 'SELECT username, status, password_hash FROM users WHERE id = ?', [environment.serviceUserId]);
  if (!user) return identityUnready('not_found');
  if (!isValidInvestigationServiceIdentity(String(user.username), String(user.password_hash ?? '')))
    return identityUnready('invalid');
  if (String(user.status) !== 'active') return identityUnready('disabled');
  let actor: ActorContext;
  try { actor = await contexts.loadInvestigationActorFrom(c as never, environment.serviceUserId, 'service'); }
  catch (error) { if (error instanceof ActorAuthenticationError) return identityUnready('invalid'); throw error; }
  const permissions = new Set(actor.permissions);
  const missingPermissions = required.filter(code => !hasPermission(permissions, code));
  return { status: 'ready', permissionsSufficient: missingPermissions.length === 0, missingPermissions,
    instanceScopeSufficient: true, permissions: actor.permissions, instanceScopes: actor.instanceScopes };
}

/** Three resource types are reported independently: the fixed pilot policy id
 * never expands database coverage to servers or network devices. */
async function resourceCoverageFacts(c: PoolConnection, ids: Record<keyof typeof RESOURCE_PERMISSION, number[]>,
  identity: IdentityFacts): Promise<InvestigationPoliciesResponse['resourceCoverage']> {
  const result: InvestigationPoliciesResponse['resourceCoverage'] = [];
  let instanceScopeSufficient = true;
  for (const type of Object.keys(RESOURCE_PERMISSION) as Array<keyof typeof RESOURCE_PERMISSION>) {
    const configured = ids[type];
    const existing = new Set<number>();
    if (configured.length) {
      const found = await rows(c, `SELECT id FROM ${RESOURCE_TABLE[type]} WHERE id IN (${configured.map(() => '?').join(',')})`
        + (type === 'database' ? " AND lifecycle_state = 'available'" : ''), configured);
      for (const row of found) existing.add(Number(row.id));
    }
    const typePermission = identity.status === 'ready' && hasPermission(new Set(identity.permissions), RESOURCE_PERMISSION[type]);
    let permitted = 0;
    for (const id of existing) {
      if (!typePermission) continue;
      if (type === 'database' && identity.instanceScopes[id] === undefined) { instanceScopeSufficient = false; continue; }
      permitted++;
    }
    result.push({ type, status: configured.length === 0 ? 'not_configured'
      : existing.size === 0 ? 'unavailable' : permitted === configured.length ? 'covered' : 'partial',
    configuredCount: configured.length, existingCount: existing.size, permittedCount: permitted, typePermission });
  }
  identity.instanceScopeSufficient = instanceScopeSufficient;
  return result;
}

/** Global governance is deliberately management-only, not ai:view resource
 * access. The same SQL connection reloads live identity before ANY ledger read.
 * No write-side ledger method or implicit domain registration is used. */
export class InvestigationGovernanceStore {
  private readonly effectiveBudget: InvestigationEffectiveBudgetService;
  constructor(private readonly poolProvider: () => Pool | null,
    private readonly configuration = investigationBudgetConfiguration,
    private readonly contexts = new ActorContextService(),
    effectiveBudget?: InvestigationEffectiveBudgetService) {
    // The effective-budget service shares this store's trusted loader so the
    // defaults it reports are exactly the ones execution would fall back to.
    this.effectiveBudget = effectiveBudget ?? new InvestigationEffectiveBudgetService(poolProvider,
      undefined, undefined, () => this.configuration());
  }

  private async read<T>(caller: ActorContext, management: boolean,
    work: (c: PoolConnection, current: ActorContext) => Promise<T>): Promise<T> {
    const ceiling = freezeInvestigationCaller(caller);
    if (ceiling.principalKind === 'service' || ceiling.resourceBoundary) throw new GovernanceReadError('GOVERNANCE_FORBIDDEN');
    const pool = this.poolProvider();
    if (!pool) throw unavailable();
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const current = await this.contexts.loadInvestigationActorFrom(c as never, ceiling.userId, 'user', ceiling.sessionVersion, ceiling.requestId);
      const required = ['ai:view', ...(management ? ['config:manage'] : [])];
      if (required.some(code => !hasPermission(new Set(current.permissions), code) || !hasPermission(new Set(ceiling.permissions), code)))
        throw new GovernanceReadError('GOVERNANCE_FORBIDDEN');
      const result = await work(c, current);
      await c.commit();
      return result;
    } catch (error) {
      await c.rollback();
      if (error instanceof ActorAuthenticationError || error instanceof GovernanceReadError
        || error instanceof InvestigationEffectiveBudgetError) throw error;
      throw unavailable();
    } finally { c.release(); }
  }

  policies(caller: ActorContext): Promise<InvestigationPoliciesResponse> {
    return this.read(caller, false, async c => {
      const masterSwitch = await masterSwitchFacts(c);
      const flags = investigationBridgeFlags();
      const investigationSwitch: InvestigationPoliciesResponse['investigationSwitch'] = {
        enabled: flags.opsAuto, manualEnabled: flags.manual, legacyEnabled: flags.legacy, source: 'environment' };
      const environment = pilotEnvironment();
      const required = ['chat:view', ...(Object.keys(RESOURCE_PERMISSION) as Array<keyof typeof RESOURCE_PERMISSION>)
        .filter(type => environment.ids[type].length > 0).map(type => RESOURCE_PERMISSION[type])];
      const serviceIdentity = await serviceIdentityFacts(c, this.contexts, environment, required);
      const resourceCoverage = await resourceCoverageFacts(c, environment.ids, serviceIdentity);
      const budget = await this.budgetFacts(c, environment.ids);
      const observed = await this.entryFacts(c, masterSwitch, investigationSwitch.enabled, environment.ids);
      const { configurationStatus, automaticAnalysisStatus, blockers } = deriveAutomaticAnalysisFacts({
        masterSwitch, investigationSwitch, scopeStatus: environment.scopeStatus, serviceIdentity, resourceCoverage, budget,
        entry: observed.entry });
      return { schemaVersion: 3 as const, source: 'production_composition' as const,
        originBoundary: 'investigation_engine_persist_only' as const,
        policy: { id: 'database-alert-pilot' as const, version: 1 as const, profileId: 'ops' as const,
          source: 'database-alert-engine' as const, readonly: true as const },
        configurationStatus, masterSwitch, investigationSwitch,
        serviceIdentity: { status: serviceIdentity.status, permissionsSufficient: serviceIdentity.permissionsSufficient,
          missingPermissions: serviceIdentity.missingPermissions,
          instanceScopeSufficient: serviceIdentity.instanceScopeSufficient },
        resourceCoverage, entry: observed.entry, receipts: observed.receipts, execution: observed.execution, budget,
        automaticAnalysisStatus, blockers };
    });
  }

  /** Entry wiring, historical receipts and durable execution outcomes are three
   * separate observations. Only durable automatic ownership on a currently
   * configured resource proves the entrance is wired; tag history alone never
   * does, and neither substitutes for an execution outcome. */
  private async entryFacts(c: PoolConnection, masterSwitch: InvestigationPoliciesResponse['masterSwitch'],
    automaticEnabled: boolean, ids: ResourceIds): Promise<{
      entry: InvestigationPoliciesResponse['entry'];
      receipts: InvestigationPoliciesResponse['receipts'];
      execution: InvestigationPoliciesResponse['execution'];
    }> {
    const receipts = await this.receiptFacts(c);
    const scoped = await this.scopedReceiptFacts(c, ids);
    const execution = await this.executionFacts(c, ids);
    const wiringPossible = masterSwitch.status !== 'invalid' && masterSwitch.enabled && automaticEnabled;
    return {
      entry: { status: !wiringPossible ? 'not_connected' : execution.facts.observed > 0 ? 'connected' : 'unverified',
        observedReceiptCount: scoped.count, lastObservedAt: scoped.lastAttemptAt,
        witnessTypes: execution.witnessTypes },
      receipts, execution: execution.facts };
  }

  /** Global receipt history from alert tags. These are observations of the
   * entrance, never evidence that a model ran or that the current scope works. */
  private async receiptFacts(c: PoolConnection): Promise<InvestigationPoliciesResponse['receipts']> {
    const groups = await rows(c, `SELECT JSON_UNQUOTE(JSON_EXTRACT(a.tags, '$.auto_analysis.status')) AS status, COUNT(*) AS n
      FROM alerts a WHERE JSON_TYPE(JSON_EXTRACT(a.tags, '$.auto_analysis')) = 'OBJECT'
      GROUP BY JSON_UNQUOTE(JSON_EXTRACT(a.tags, '$.auto_analysis.status'))`);
    const result: InvestigationPoliciesResponse['receipts'] = { total: 0, accepted: 0, suppressed: 0, pending: 0, unknown: 0,
      lastStatus: null, lastReason: null, lastAttemptAt: null };
    for (const group of groups) {
      const n = number(group.n); result.total = number(result.total + n);
      const status = String(group.status ?? '').toLowerCase();
      if (status === 'accepted') result.accepted = number(result.accepted + n);
      else if (status === 'suppressed') result.suppressed = number(result.suppressed + n);
      else if (status === 'pending') result.pending = number(result.pending + n);
      else result.unknown = number(result.unknown + n);
    }
    const [last] = await rows(c, `SELECT JSON_UNQUOTE(JSON_EXTRACT(a.tags, '$.auto_analysis.status')) AS status,
      JSON_UNQUOTE(JSON_EXTRACT(a.tags, '$.auto_analysis.reason')) AS reason,
      JSON_UNQUOTE(JSON_EXTRACT(a.tags, '$.auto_analysis.attemptedAt')) AS attempted_at
      FROM alerts a WHERE JSON_TYPE(JSON_EXTRACT(a.tags, '$.auto_analysis')) = 'OBJECT' ORDER BY a.id DESC LIMIT 1`);
    const status = String(last?.status ?? '').toLowerCase();
    result.lastStatus = status === 'accepted' || status === 'suppressed' || status === 'pending' || status === 'unknown'
      ? status : null;
    result.lastReason = typeof last?.reason === 'string' && REASON_CODE.test(last.reason) ? last.reason : null;
    result.lastAttemptAt = typeof last?.attempted_at === 'string' && ISO_INSTANT.test(last.attempted_at) ? last.attempted_at : null;
    return result;
  }

  /** Receipts whose alert belongs to the currently configured resources. This
   * scopes the observation; it still does not prove durable execution. */
  private async scopedReceiptFacts(c: PoolConnection, ids: ResourceIds): Promise<{ count: number; lastAttemptAt: string | null }> {
    const scope = scopePredicate(ids);
    if (!scope) return { count: 0, lastAttemptAt: null };
    const [row] = await rows(c, `SELECT COUNT(*) AS n,
      MAX(JSON_UNQUOTE(JSON_EXTRACT(a.tags, '$.auto_analysis.attemptedAt'))) AS attempted_at
      FROM alerts a WHERE JSON_TYPE(JSON_EXTRACT(a.tags, '$.auto_analysis')) = 'OBJECT' AND ${scope.sql}`, scope.values);
    return { count: number(row?.n),
      lastAttemptAt: typeof row?.attempted_at === 'string' && ISO_INSTANT.test(row.attempted_at) ? row.attempted_at : null };
  }

  /** Durable automatic executions: the owner row froze the lane before any
   * admission, the investigation request accepted the work, and the workflow
   * job carries the real terminal state. Reads never create any of them. */
  private async executionFacts(c: PoolConnection, ids: ResourceIds): Promise<{
    facts: InvestigationPoliciesResponse['execution']; witnessTypes: ResourceType[];
  }> {
    const result: InvestigationPoliciesResponse['execution'] = { observed: 0, accepted: 0, running: 0, completed: 0,
      failed: 0, cancelled: 0, suppressed: 0, unknown: 0, lastStatus: null, lastAt: null };
    const scope = scopePredicate(ids);
    if (!scope) return { facts: result, witnessTypes: [] };
    const typeCase = resourceTypeCase(ids);
    const joins = `FROM investigation_alert_owners o
      JOIN alerts a ON a.id = o.alert_id
      LEFT JOIN investigations i ON i.id = o.investigation_id
      LEFT JOIN investigation_requests r ON r.id = i.active_request_id
      LEFT JOIN workflow_jobs j ON j.id COLLATE utf8mb4_unicode_ci = r.job_id
      WHERE o.lane = 'investigation' AND JSON_UNQUOTE(JSON_EXTRACT(o.command_snapshot, '$.trigger')) = 'auto'
        AND ${scope.sql}`;
    // Aggregate in SQL so a long history cannot silently undercount behind a
    // JS row cap; the latest row is read separately for the most recent state.
    const groups = await rows(c, `SELECT ${typeCase.sql} AS resource_type, COUNT(*) AS observed,
      SUM(o.investigation_id IS NULL) AS suppressed,
      SUM(o.investigation_id IS NOT NULL AND j.id IS NULL) AS unknown,
      SUM(o.investigation_id IS NOT NULL AND j.state = 'queued') AS accepted,
      SUM(o.investigation_id IS NOT NULL AND j.state IN ('running','retry')) AS running,
      SUM(o.investigation_id IS NOT NULL AND j.state = 'completed') AS completed,
      SUM(o.investigation_id IS NOT NULL AND j.state = 'dead_letter') AS failed,
      SUM(o.investigation_id IS NOT NULL AND j.state = 'cancelled') AS cancelled
      ${joins} GROUP BY resource_type`, [...typeCase.values, ...scope.values]);
    const witness = new Set<ResourceType>();
    for (const group of groups) {
      const type = String(group.resource_type ?? '') as ResourceType;
      if (type in ALERT_COLUMN) witness.add(type);
      for (const key of ['observed', 'suppressed', 'unknown', 'accepted', 'running', 'completed', 'failed', 'cancelled'] as const)
        result[key] = number(result[key] + number(group[key]));
    }
    const [last] = await rows(c, `SELECT o.investigation_id, j.state AS job_state,
      DATE_FORMAT(o.created_at, '%Y-%m-%dT%H:%i:%s.000Z') AS owned_at
      ${joins} ORDER BY o.created_at DESC, o.alert_id DESC LIMIT 1`, scope.values);
    if (last) {
      result.lastStatus = executionStatus(last.investigation_id, last.job_state);
      result.lastAt = typeof last.owned_at === 'string' && ISO_INSTANT.test(last.owned_at) ? last.owned_at : null;
    }
    return { facts: result, witnessTypes: [...witness] };
  }

  /** Budget readiness mirrors the real automatic admission snapshot without
   * creating a domain or reserving anything. It evaluates the SAME reserve an
   * automatic alert uses, so "available" cannot coexist with a reserve that no
   * longer fits. Concurrency reasons are an instantaneous observation. */
  private async budgetFacts(c: PoolConnection, ids: ResourceIds): Promise<InvestigationPoliciesResponse['budget']> {
    const base = { quotaReached: false, capacityReached: false, reserveTokens: AUTOMATIC_ALERT_RESERVE_TOKENS,
      reserveCostMicros: 0, admissionReasons: [] as InvestigationPoliciesResponse['budget']['admissionReasons'] };
    try {
      const config = this.configuration();
      if (!Number.isSafeInteger(config.reserveCostMicros) || config.reserveCostMicros < 1)
        return { status: 'unavailable', ...base, reserveCostMicros: 0 };
      base.reserveCostMicros = config.reserveCostMicros;
      const admission = resolveAdmissionConfiguration(await this.effectiveBudget.readStoredFrom(c), config);
      const [domain] = await rows(c, 'SELECT policy_snapshot, policy_hash FROM investigation_budget_domains WHERE domain_key = ?',
        [admission.domain]);
      if (!domain) return { status: 'uninitialized', ...base };
      const persisted = policy(json(domain.policy_snapshot));
      const matching = isDeepStrictEqual(persisted, admission.policy)
        && domain.policy_hash === createHash('sha256').update(JSON.stringify(admission.policy)).digest('hex');
      if (!matching) return { status: 'conflict', ...base };
      const admissionReasons = await this.admissionReasons(c, admission.domain, admission.policy, config.reserveCostMicros, ids);
      return { status: 'matching', reserveTokens: base.reserveTokens, reserveCostMicros: base.reserveCostMicros,
        quotaReached: admissionReasons.some(reason => (QUOTA_REASONS as readonly string[]).includes(reason)),
        capacityReached: admissionReasons.some(reason => (CAPACITY_REASONS as readonly string[]).includes(reason)),
        admissionReasons };
    } catch (error) {
      if (error instanceof InvestigationEffectiveBudgetError) return { status: 'unavailable', ...base };
      throw error;
    }
  }

  /** Same comparisons as MysqlInvestigationBudgetLedger.reserve for one
   * automatic request on a configured resource. No row is written. */
  private async admissionReasons(c: PoolConnection, domain: string, admission: BudgetPolicy, reserveCostMicros: number,
    ids: ResourceIds): Promise<InvestigationPoliciesResponse['budget']['admissionReasons']> {
    const [usage] = await rows(c, `SELECT
      COUNT(DISTINCT CASE WHEN mode = 'automatic' AND budget_hour = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%d %H:00:00') THEN request_id END) AS auto_hour,
      COUNT(DISTINCT CASE WHEN state IN ('reserved','sent','unknown') THEN id END) AS running,
      COUNT(DISTINCT CASE WHEN state IN ('reserved','sent','unknown') AND mode = 'automatic' THEN id END) AS running_auto,
      COALESCE(SUM(CASE WHEN mode = 'automatic' AND (budget_day = UTC_DATE() OR state IN ('reserved','sent','unknown')) THEN charged_tokens ELSE 0 END), 0) AS auto_tokens,
      COALESCE(SUM(CASE WHEN budget_day = UTC_DATE() OR state IN ('reserved','sent','unknown') THEN charged_tokens ELSE 0 END), 0) AS total_tokens,
      COALESCE(SUM(CASE WHEN budget_day = UTC_DATE() OR state IN ('reserved','sent') OR cost_status = 'unknown' THEN charged_cost_micros ELSE 0 END), 0) AS total_cost
      FROM investigation_budget_ledger WHERE domain_key = ?`, [domain]);
    const reserve = BigInt(AUTOMATIC_ALERT_RESERVE_TOKENS);
    const reasons: InvestigationPoliciesResponse['budget']['admissionReasons'] = [];
    const push = (reason: InvestigationPoliciesResponse['budget']['admissionReasons'][number]) => {
      if (!reasons.includes(reason)) reasons.push(reason);
    };
    if (bigint(usage?.auto_hour) >= BigInt(admission.maxAutomaticRequestsPerHour)) push('AUTOMATIC_FREQUENCY');
    if (bigint(usage?.auto_tokens) + reserve > BigInt(admission.maxAutomaticTokensPerDay)) push('AUTOMATIC_DAILY_TOKENS');
    if (bigint(usage?.total_tokens) + reserve > BigInt(admission.maxTotalTokensPerDay)) push('TOTAL_DAILY_TOKENS');
    if (bigint(usage?.total_cost) + BigInt(reserveCostMicros) > BigInt(admission.maxCostMicrosPerDay)) push('DAILY_COST');
    if (bigint(usage?.running) >= BigInt(admission.maxConcurrent)) push('GLOBAL_CONCURRENCY');
    if (bigint(usage?.running_auto) >= BigInt(Math.max(0, admission.maxConcurrent - admission.manualReserved)))
      push('MANUAL_CAPACITY_RESERVED');
    if (await this.allResourcesSaturated(c, domain, admission, ids)) push('RESOURCE_CONCURRENCY');
    return reasons;
  }

  /** A new automatic request targets one alert resource, so the type is only
   * saturated when every configured resource still present has no free slot. */
  private async allResourcesSaturated(c: PoolConnection, domain: string, admission: BudgetPolicy, ids: ResourceIds): Promise<boolean> {
    const keys: string[] = [];
    for (const type of Object.keys(RESOURCE_TABLE) as ResourceType[]) {
      if (!ids[type].length) continue;
      const existing = await rows(c, `SELECT id FROM ${RESOURCE_TABLE[type]} WHERE id IN (${ids[type].map(() => '?').join(',')})`
        + (type === 'database' ? " AND lifecycle_state = 'available'" : ''), ids[type]);
      for (const row of existing) keys.push(`${RESOURCE_KEY_PREFIX[type]}:${Number(row.id)}`);
    }
    if (!keys.length) return false;
    const occupied = await rows(c, `SELECT r.resource_key AS resource_key, COUNT(*) AS n
      FROM investigation_budget_resources r
      JOIN investigation_budget_ledger l ON l.id = r.reservation_id
      WHERE l.domain_key = ? AND l.state IN ('reserved','sent','unknown') GROUP BY r.resource_key`, [domain]);
    const counts = new Map(occupied.map(row => [String(row.resource_key), number(row.n)]));
    return keys.every(key => (counts.get(key) ?? 0) >= admission.maxPerResourceConcurrent);
  }

  budget(caller: ActorContext): Promise<InvestigationBudgetResponse> {
    return this.read(caller, true, async c => {
      const config = this.configuration();
      // Constructor validates the same effective configuration as execution;
      // it does not initialize a domain or perform any SQL.
      new MysqlInvestigationBudgetLedger(this.poolProvider, config.policy);
      if (!Number.isSafeInteger(config.reserveCostMicros) || config.reserveCostMicros < 1) throw unavailable();
      // The durable setting wins, and its revision names the domain new
      // admissions target. Reading never creates that domain.
      const admission = resolveAdmissionConfiguration(await this.effectiveBudget.readStoredFrom(c), config);
      const configured = policy(admission.policy);
      const [domain] = await rows(c, 'SELECT policy_snapshot, policy_hash FROM investigation_budget_domains WHERE domain_key = ?', [admission.domain]);
      const persisted = domain ? policy(json(domain.policy_snapshot)) : null;
      // Same entry fact as the policies page: the switches must both be on AND
      // durable automatic ownership must exist for a currently configured
      // resource. Receipt tags alone never claim a connected entry.
      const masterSwitch = await masterSwitchFacts(c);
      const flags = investigationBridgeFlags();
      const entry = await this.entryFacts(c, masterSwitch, flags.opsAuto, pilotEnvironment().ids);
      const automaticTriggerStatus = entry.entry.status === 'connected' ? 'connected' as const : 'not_connected' as const;
      return { schemaVersion: 1, source: 'investigationBudgetConfiguration', policy: configured,
        reserveCostMicros: number(config.reserveCostMicros), persistedPolicy: persisted,
        admissionStatus: persisted === null ? 'uninitialized' : isDeepStrictEqual(persisted, configured) && domain.policy_hash === createHash('sha256').update(JSON.stringify(configured)).digest('hex') ? 'matching' : 'conflict',
        automaticTriggerStatus,
        window: 'UTC_admission_day_and_hour', profileLimitsSource: '/api/investigation-profiles',
        domain: admission.domain, admissionRevision: admission.revision,
        policySource: admission.source === 'settings' ? 'settings' : 'configuration' };
    });
  }

  effectiveBudgetFacts(caller: ActorContext) {
    return this.read(caller, true, async () => this.effectiveBudget.view());
  }

  saveEffectiveBudget(caller: ActorContext, input: unknown, context: EffectiveBudgetAuditContext = {}) {
    return this.read(caller, true, async (c, current) =>
      this.effectiveBudget.saveInTransaction(c, current, input, context));
  }

  usage(caller: ActorContext, limit = 20, offset = 0): Promise<InvestigationUsageResponse> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 200_000)
      throw new GovernanceReadError('GOVERNANCE_FORBIDDEN');
    return this.read(caller, true, async c => {
      const groups = await rows(c, `SELECT JSON_UNQUOTE(JSON_EXTRACT(d.policy_snapshot, '$.currency')) AS currency, l.state, l.mode,
        COUNT(*) AS n, SUM(l.usage_snapshot IS NOT NULL) AS known_usage,
        SUM(l.usage_snapshot IS NULL AND l.state IN ('unknown','settled')) AS unknown_usage,
        SUM(l.usage_snapshot IS NULL AND l.state = 'sent') AS pending_usage,
        SUM(l.cost_status = 'unknown') AS unknown_cost,
        SUM(COALESCE(JSON_EXTRACT(l.usage_snapshot, '$.inputTokens'), 0)) AS known_input,
        SUM(COALESCE(JSON_EXTRACT(l.usage_snapshot, '$.cachedInputTokens'), 0)) AS known_cached_input,
        SUM(COALESCE(JSON_EXTRACT(l.usage_snapshot, '$.outputTokens'), 0)) AS known_output,
        SUM(l.reserved_tokens) AS reserved_tokens,
        SUM(IF(l.state IN ('reserved','sent','unknown'), l.charged_tokens, 0)) AS outstanding_tokens,
        SUM(IF(l.state = 'settled', l.charged_tokens, 0)) AS settled_tokens,
        SUM(l.reserved_cost_micros) AS reserved_cost,
        SUM(IF(l.state IN ('reserved','sent','unknown') OR l.state = 'settled' AND l.cost_status = 'unknown', l.charged_cost_micros, 0)) AS outstanding_cost,
        SUM(IF(l.state = 'settled' AND l.cost_status = 'known', l.charged_cost_micros, 0)) AS estimated_cost
        FROM investigation_budget_ledger l JOIN investigation_budget_domains d ON d.domain_key = l.domain_key
        GROUP BY currency, l.state, l.mode ORDER BY currency, l.state, l.mode`);
      const result: InvestigationUsageResponse = { schemaVersion: 1, accessScope: 'global_config_management', window: 'all_history',
        costSemantics: 'rate_estimate_not_provider_invoice', tokenSemantics: 'input_includes_cached_input',
        total: 0, counts: { reserved: 0, sent: 0, settled: 0, unknown: 0, cancelled: 0 },
        knownUsageCount: 0, unknownUsageCount: 0, pendingUsageCount: 0, reservedTokens: 0, outstandingTokens: 0, settledTokens: 0,
        costs: [], items: [], groupCount: groups.length, nextOffset: null };
      for (const g of groups) {
        if (!/^[A-Z]{3}$/.test(g.currency) || !Object.hasOwn(result.counts, g.state)) throw unavailable();
        const n = number(g.n);
        result.total = number(result.total + n);
        result.counts[g.state as keyof typeof result.counts] = number(result.counts[g.state as keyof typeof result.counts] + n);
        for (const [property, column] of [['knownUsageCount', 'known_usage'], ['unknownUsageCount', 'unknown_usage'],
          ['pendingUsageCount', 'pending_usage'], ['reservedTokens', 'reserved_tokens'], ['outstandingTokens', 'outstanding_tokens'],
          ['settledTokens', 'settled_tokens']] as const) result[property] = number(result[property] + number(g[column]));
        let cost = result.costs.find(cost => cost.currency === g.currency);
        if (!cost) { cost = { currency: g.currency, reservedCostMicros: 0, outstandingCostMicros: 0, estimatedSettledCostMicros: 0 }; result.costs.push(cost); }
        cost.reservedCostMicros = number(cost.reservedCostMicros + number(g.reserved_cost));
        cost.outstandingCostMicros = number(cost.outstandingCostMicros + number(g.outstanding_cost));
        cost.estimatedSettledCostMicros = number(cost.estimatedSettledCostMicros + number(g.estimated_cost));
      }
      // Management authorizes GLOBAL AGGREGATES only. No investigation,
      // actor, resource, request or individual reservation identifiers escape.
      // Each SQL group retains unknown/pending counts alongside known subtotals;
      // COALESCE computes the known subtotal, never substitutes unknown usage.
      result.items = groups.slice(offset, offset + limit).map(g => ({
        state: g.state, mode: g.mode, currency: g.currency, count: number(g.n),
        knownUsageCount: number(g.known_usage), unknownUsageCount: number(g.unknown_usage), pendingUsageCount: number(g.pending_usage),
        knownInputTokens: number(g.known_input), knownCachedInputTokens: number(g.known_cached_input), knownOutputTokens: number(g.known_output),
        reservedTokens: number(g.reserved_tokens), outstandingTokens: number(g.outstanding_tokens), settledTokens: number(g.settled_tokens),
        reservedCostMicros: number(g.reserved_cost), outstandingCostMicros: number(g.outstanding_cost),
        estimatedSettledCostMicros: number(g.estimated_cost), unknownCostCount: number(g.unknown_cost),
      }));
      result.nextOffset = offset + result.items.length < groups.length ? offset + result.items.length : null;
      return result;
    });
  }
}
