import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { llmDatabaseService } from '../llm-database-service.js';
import { resolveSceneModel } from '../llm/scene-routing.js';
import { configuredModelCapabilities } from '../adapter/llm-provider-factory.js';
import type { ModelCapabilities } from '@slide/agent-core';
import { InvestigationAdmissionPolicySchema, InvestigationProfileLimitsSchema, InvestigationRuntimeAllocationSchema,
  type InvestigationAdmissionPolicy, type InvestigationProfileLimits, type InvestigationRuntimeAllocation } from './effective-budget-contracts.js';
import { investigationBudgetConfiguration, type InvestigationBudgetConfiguration } from './budget-configuration.js';
import type { BudgetPolicy } from './budget-ledger.js';
export { INVESTIGATION_EFFECTIVE_BUDGET_LIMITS, InvestigationAdmissionPolicySchema, InvestigationProfileLimitsSchema,
  InvestigationRuntimeAllocationSchema } from './effective-budget-contracts.js';
export type { InvestigationAdmissionPolicy, InvestigationProfileLimits, InvestigationRuntimeAllocation } from './effective-budget-contracts.js';

const strict = { additionalProperties: false } as const;
const at = () => Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' });
const integer = (min: number, max: number) => Type.Integer({ minimum: min, maximum: max });

export const INVESTIGATION_EFFECTIVE_BUDGET_KEY = 'investigation.effective_budget.v1';
/** Admission quota plus its monotonic ledger-domain revision. The revision only
 * advances when the policy changes, so a quota edit can never rewrite an
 * existing domain snapshot or its historical ledger. */
export const InvestigationEffectiveAdmissionSchema = Type.Object({
  revision: integer(1, Number.MAX_SAFE_INTEGER),
  policy: InvestigationAdmissionPolicySchema,
}, strict);
export const InvestigationEffectiveBudgetSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  version: integer(1, Number.MAX_SAFE_INTEGER),
  runtime: InvestigationRuntimeAllocationSchema,
  profileLimits: InvestigationProfileLimitsSchema,
  // Absent only in documents written before admission settings existed.
  admission: Type.Optional(InvestigationEffectiveAdmissionSchema),
  updatedAt: at(),
  updatedBy: Type.Optional(integer(1, Number.MAX_SAFE_INTEGER)),
}, strict);
export const InvestigationEffectiveBudgetInputSchema = Type.Object({
  expectedVersion: integer(0, Number.MAX_SAFE_INTEGER),
  runtime: InvestigationRuntimeAllocationSchema,
  profileLimits: InvestigationProfileLimitsSchema,
  admissionPolicy: InvestigationAdmissionPolicySchema,
}, strict);

export type InvestigationEffectiveAdmission = Static<typeof InvestigationEffectiveAdmissionSchema>;
export type InvestigationEffectiveBudget = Static<typeof InvestigationEffectiveBudgetSchema>;
export type InvestigationEffectiveBudgetInput = Static<typeof InvestigationEffectiveBudgetInputSchema>;
export interface InvestigationProviderCapacity {
  model: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  preferredOutputTokens?: number;
  source: ModelCapabilities['source'];
}
export interface InvestigationEffectiveBudgetView {
  schemaVersion: 1;
  source: 'settings' | 'defaults';
  effective: InvestigationEffectiveBudget;
  defaults: InvestigationEffectiveBudget;
  provider: InvestigationProviderCapacity | null;
  capabilityVerified: boolean;
  /** Domain new admissions currently target; derived from the policy revision. */
  admission: { domain: string; revision: number; source: 'settings' | 'defaults' };
}
export interface InvestigationAdmissionConfiguration {
  domain: string;
  policy: BudgetPolicy;
  revision: number;
  source: 'settings' | 'defaults';
}
export interface EffectiveBudgetAuditContext {
  clientIp?: string;
  userAgent?: string;
}
export type EffectiveBudgetErrorCode =
  | 'INVESTIGATION_BUDGET_CONFIGURATION_INVALID'
  | 'INVESTIGATION_BUDGET_POLICY_INVALID'
  | 'INVESTIGATION_BUDGET_CAPABILITY_UNAVAILABLE'
  | 'INVESTIGATION_BUDGET_CAPABILITY_EXCEEDED'
  | 'INVESTIGATION_BUDGET_CONFLICT'
  | 'INVESTIGATION_BUDGET_UNAVAILABLE';

export class InvestigationEffectiveBudgetError extends Error {
  constructor(readonly code: EffectiveBudgetErrorCode) { super(code); this.name = 'InvestigationEffectiveBudgetError'; }
}

const invalid = () => new InvestigationEffectiveBudgetError('INVESTIGATION_BUDGET_CONFIGURATION_INVALID');
const unavailable = () => new InvestigationEffectiveBudgetError('INVESTIGATION_BUDGET_UNAVAILABLE');
const capabilitiesUnavailable = () => new InvestigationEffectiveBudgetError('INVESTIGATION_BUDGET_CAPABILITY_UNAVAILABLE');

/** Conservative values when the configured model has no verified capacity.
 * They match the previous defaults and never widen an unknown model. */
const CONSERVATIVE_RUNTIME: InvestigationRuntimeAllocation = Object.freeze({
  contextWindowTokens: 8192, outputTokens: 4096, summaryOutputTokens: 4096, maxExecutionTokens: 1_000_000,
});
export const CONSERVATIVE_PROFILE_LIMITS: InvestigationProfileLimits = Object.freeze({
  deadlineMs: 600_000, maxToolCalls: 36, maxProviderAttempts: 8, maxRows: 200, maxBytes: 128_000, maxWindowMs: 3_600_000,
});

function defaultRuntime(capability?: InvestigationProviderCapacity): InvestigationRuntimeAllocation {
  if (!capability || capability.source === 'conservative-fallback' || capability.maxOutputTokens === undefined) return { ...CONSERVATIVE_RUNTIME };
  const window = Math.min(capability.contextWindowTokens, 1_000_000);
  const output = Math.max(1, Math.min(capability.maxOutputTokens, 1_000_000, window - 1025));
  return { contextWindowTokens: window, outputTokens: output, summaryOutputTokens: output,
    maxExecutionTokens: 1_000_000 };
}
function admissionPolicyFrom(policy: BudgetPolicy): InvestigationAdmissionPolicy {
  return { maxConcurrent: policy.maxConcurrent, manualReserved: policy.manualReserved,
    maxPerResourceConcurrent: policy.maxPerResourceConcurrent, maxAutomaticRequestsPerHour: policy.maxAutomaticRequestsPerHour,
    maxAutomaticTokensPerDay: policy.maxAutomaticTokensPerDay, maxTotalTokensPerDay: policy.maxTotalTokensPerDay,
    maxCostMicrosPerDay: policy.maxCostMicrosPerDay };
}
function defaultAdmission(policy: BudgetPolicy): InvestigationEffectiveAdmission {
  return { revision: 1, policy: admissionPolicyFrom(policy) };
}
/** Revision 1 keeps the deployment's existing domain. Every changed policy
 * opens a new sibling domain, so older snapshots and charges stay untouched. */
export function admissionDomain(base: string, revision: number): string {
  const domain = revision <= 1 ? base : `${base}:v${revision}`;
  // Never truncate a domain key: an over-long base fails explicitly.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(domain)) throw invalid();
  return domain;
}
/** Effective admission for new work: the persisted setting when present, else
 * the deployment loader. A stored receipt is never passed through this. */
export function resolveAdmissionConfiguration(stored: InvestigationEffectiveBudget | undefined,
  base: InvestigationBudgetConfiguration = investigationBudgetConfiguration()): InvestigationAdmissionConfiguration {
  const admission = stored?.admission;
  if (!admission) return { domain: base.domain, policy: { ...base.policy }, revision: 1, source: 'defaults' };
  return { domain: admissionDomain(base.domain, admission.revision),
    policy: { currency: base.policy.currency, ...admission.policy }, revision: admission.revision, source: 'settings' };
}
function withAdmission(budget: InvestigationEffectiveBudget, base: BudgetPolicy): InvestigationEffectiveBudget {
  return budget.admission ? budget : { ...budget, admission: defaultAdmission(base) };
}
export function defaultEffectiveBudget(capability?: InvestigationProviderCapacity,
  now = new Date().toISOString(), base: BudgetPolicy = investigationBudgetConfiguration().policy): InvestigationEffectiveBudget {
  return { schemaVersion: 1, version: 0, runtime: defaultRuntime(capability), profileLimits: { ...CONSERVATIVE_PROFILE_LIMITS },
    admission: defaultAdmission(base), updatedAt: now };
}

export function assertEffectiveBudget(value: unknown): InvestigationEffectiveBudget {
  if (!Value.Check(InvestigationEffectiveBudgetSchema, value)) throw invalid();
  const budget = value as InvestigationEffectiveBudget;
  assertRelations(budget.runtime, budget.admission);
  return budget;
}
export function assertEffectiveBudgetInput(value: unknown): InvestigationEffectiveBudgetInput {
  if (!Value.Check(InvestigationEffectiveBudgetInputSchema, value)) throw invalid();
  const input = value as InvestigationEffectiveBudgetInput;
  assertRelations(input.runtime, { revision: 1, policy: input.admissionPolicy });
  return input;
}
function assertRelations(runtime: InvestigationRuntimeAllocation, admission?: InvestigationEffectiveAdmission) {
  if (runtime.contextWindowTokens < Math.max(runtime.outputTokens, runtime.summaryOutputTokens) + 1024
    || runtime.maxExecutionTokens < runtime.contextWindowTokens) throw invalid();
  if (!admission) return;
  const policy = admission.policy;
  // Cross-field quota conflicts fail explicitly at save AND on read; they are
  // never clamped to a smaller value.
  if (policy.manualReserved > policy.maxConcurrent || policy.maxAutomaticTokensPerDay > policy.maxTotalTokensPerDay)
    throw new InvestigationEffectiveBudgetError('INVESTIGATION_BUDGET_POLICY_INVALID');
  if (runtime.maxExecutionTokens > policy.maxTotalTokensPerDay)
    throw new InvestigationEffectiveBudgetError('INVESTIGATION_BUDGET_POLICY_INVALID');
}
function assertCapability(runtime: InvestigationRuntimeAllocation, capability?: InvestigationProviderCapacity) {
  if (!capability || capability.source === 'conservative-fallback' || capability.maxOutputTokens === undefined) throw capabilitiesUnavailable();
  if (runtime.contextWindowTokens > capability.contextWindowTokens
    || runtime.outputTokens > capability.maxOutputTokens
    || runtime.summaryOutputTokens > capability.maxOutputTokens) throw new InvestigationEffectiveBudgetError('INVESTIGATION_BUDGET_CAPABILITY_EXCEEDED');
}

async function resolveProviderCapacity(): Promise<InvestigationProviderCapacity | undefined> {
  const { provider, model } = await resolveSceneModel(llmDatabaseService, 'fault_diagnosis', { requiresFunctionCall: true });
  const capabilities = configuredModelCapabilities(provider, model);
  return { model, contextWindowTokens: capabilities.contextWindowTokens, maxOutputTokens: capabilities.maxOutputTokens,
    preferredOutputTokens: capabilities.preferredOutputTokens, source: capabilities.source };
}

function parseStored(value: unknown): InvestigationEffectiveBudget {
  try {
    return assertEffectiveBudget(typeof value === 'string' ? JSON.parse(value) : value);
  } catch { throw invalid(); }
}

/** Persistent effective budget for Investigation runtime allocation and profile
 * limits. The row is one server-owned document; writes are versioned and
 * audited, and an in-flight run keeps the allocation persisted in its state. */
export class InvestigationEffectiveBudgetService {
  constructor(private readonly poolProvider: () => Pool | null = () => dbConnection.getPool(),
    private readonly capabilityResolver: () => Promise<InvestigationProviderCapacity | undefined> = resolveProviderCapacity,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly baseConfiguration: () => InvestigationBudgetConfiguration = investigationBudgetConfiguration) {}

  private async capability(safe: boolean): Promise<InvestigationProviderCapacity | undefined> {
    try { return await this.capabilityResolver(); } catch (error) { if (safe) return undefined; throw error; }
  }

  async defaults(): Promise<InvestigationEffectiveBudget> {
    return defaultEffectiveBudget(await this.capability(true), this.now(), this.baseConfiguration().policy);
  }

  /** Durable settings only. Execution uses this to distinguish an operator
   * setting from the env/bootstrap fallback without resolving the provider on
   * every job. A corrupt row fails explicitly; it never silently relaxes. */
  async readStored(): Promise<InvestigationEffectiveBudget | undefined> {
    const pool = this.poolProvider();
    return pool ? this.readStoredFrom(pool) : undefined;
  }

  /** Same read on a caller-owned transaction connection (admission). */
  async readStoredFrom(connection: { execute: (sql: string, values?: any) => Promise<any> }): Promise<InvestigationEffectiveBudget | undefined> {
    const [rows] = await connection.execute('SELECT config_value FROM system_config WHERE config_key = ?', [INVESTIGATION_EFFECTIVE_BUDGET_KEY]);
    return rows.length ? parseStored(rows[0].config_value) : undefined;
  }

  async get(): Promise<{ budget: InvestigationEffectiveBudget; source: 'settings' | 'defaults' }> {
    const stored = await this.readStored();
    const base = this.baseConfiguration();
    return stored ? { budget: withAdmission(stored, base.policy), source: 'settings' }
      : { budget: await this.defaults(), source: 'defaults' };
  }

  async view(): Promise<InvestigationEffectiveBudgetView> {
    const base = this.baseConfiguration();
    const [stored, capability] = await Promise.all([this.readStored(), this.capability(true)]);
    const defaults = defaultEffectiveBudget(capability, this.now(), base.policy);
    const effective = stored ? withAdmission(stored, base.policy) : defaults;
    const active = resolveAdmissionConfiguration(stored, base);
    return { schemaVersion: 1, source: stored ? 'settings' : 'defaults', effective, defaults, provider: capability ?? null,
      capabilityVerified: !!capability && capability.source !== 'conservative-fallback' && capability.maxOutputTokens !== undefined,
      admission: { domain: active.domain, revision: active.revision, source: active.source } };
  }

  async save(actor: ActorContext, input: unknown, context: EffectiveBudgetAuditContext = {}): Promise<InvestigationEffectiveBudget> {
    const parsed = assertEffectiveBudgetInput(input);
    const pool = this.poolProvider();
    if (!pool) throw unavailable();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const saved = await this.saveInTransaction(connection, actor, parsed, context);
      await connection.commit();
      return saved;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  /** Called by the governance route inside its same-connection live identity
   * transaction; the audit entry commits with the settings row. */
  async saveInTransaction(connection: PoolConnection, actor: ActorContext, input: unknown,
    context: EffectiveBudgetAuditContext = {}, capability?: InvestigationProviderCapacity): Promise<InvestigationEffectiveBudget> {
    const parsed = assertEffectiveBudgetInput(input);
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT config_value FROM system_config WHERE config_key = ? FOR UPDATE', [INVESTIGATION_EFFECTIVE_BUDGET_KEY]);
    const previous = rows.length ? parseStored(rows[0].config_value) : undefined;
    if (parsed.expectedVersion !== (previous?.version ?? 0)) throw new InvestigationEffectiveBudgetError('INVESTIGATION_BUDGET_CONFLICT');
    // Provider capacity gates the runtime allocation only. A policy-only edit
    // stays possible when the model has no verified capacity; the unchanged
    // runtime was already validated when it was written.
    const runtimeChanged = !previous || !isDeepStrictEqual(previous.runtime, parsed.runtime);
    const verified = runtimeChanged ? capability ?? await this.capability(false) : undefined;
    if (runtimeChanged) assertCapability(parsed.runtime, verified);
    // A policy edit opens the next domain revision. Runtime/Profile edits do
    // not rotate: they are frozen per Run and never rewrite a domain snapshot.
    const base = this.baseConfiguration();
    const previousAdmission = previous?.admission ?? defaultAdmission(base.policy);
    const rotated = !isDeepStrictEqual(previousAdmission.policy, parsed.admissionPolicy);
    const admission: InvestigationEffectiveAdmission = { revision: rotated ? previousAdmission.revision + 1 : previousAdmission.revision,
      policy: { ...parsed.admissionPolicy } };
    const budget: InvestigationEffectiveBudget = { schemaVersion: 1, version: (previous?.version ?? 0) + 1,
      runtime: { ...parsed.runtime }, profileLimits: { ...parsed.profileLimits }, admission,
      updatedAt: this.now(), updatedBy: actor.userId };
    await connection.execute(`REPLACE INTO system_config (config_key, config_value, value_type, updated_by)
      VALUES (?, ?, 'json', ?)`, [INVESTIGATION_EFFECTIVE_BUDGET_KEY, JSON.stringify(budget), actor.userId]);
    const auditedProvider = capability ?? verified ?? await this.capability(true);
    await connection.execute(`INSERT INTO audit_log_entries
      (id, event_type, level, user_id, username, user_role, action, resource_type, resource_id,
       details_json, client_ip, user_agent, result, timestamp_ms)
      VALUES (?, 'config_change', 'info', ?, ?, ?, 'investigation.effective_budget.update',
        'investigation_budget', 'effective_budget_v1', ?, ?, ?, 'success', ?)`,
      [randomUUID(), String(actor.userId), actor.username, actor.roles[0] ?? null, JSON.stringify({
        previousVersion: previous?.version ?? 0, version: budget.version,
        previous: previous ? { runtime: previous.runtime, profileLimits: previous.profileLimits,
          admission: previous.admission ?? null } : null,
        next: { runtime: budget.runtime, profileLimits: budget.profileLimits, admission: budget.admission },
        rotation: rotated ? { previousRevision: previousAdmission.revision, revision: admission.revision,
          previousDomain: admissionDomain(base.domain, previousAdmission.revision),
          domain: admissionDomain(base.domain, admission.revision) } : null,
        provider: auditedProvider ? { model: auditedProvider.model, contextWindowTokens: auditedProvider.contextWindowTokens,
          maxOutputTokens: auditedProvider.maxOutputTokens, source: auditedProvider.source } : null,
      }), context.clientIp ?? null, context.userAgent ?? null, Date.now()]);
    return budget;
  }
}

export const investigationEffectiveBudget = new InvestigationEffectiveBudgetService();
