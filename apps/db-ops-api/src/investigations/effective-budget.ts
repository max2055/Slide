import { randomUUID } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { llmDatabaseService } from '../llm-database-service.js';
import { resolveSceneModel } from '../llm/scene-routing.js';
import { configuredModelCapabilities } from '../adapter/llm-provider-factory.js';
import type { ModelCapabilities } from '@slide/agent-core';
import { InvestigationProfileLimitsSchema, InvestigationRuntimeAllocationSchema,
  type InvestigationProfileLimits, type InvestigationRuntimeAllocation } from './effective-budget-contracts.js';
export { INVESTIGATION_EFFECTIVE_BUDGET_LIMITS, InvestigationProfileLimitsSchema, InvestigationRuntimeAllocationSchema } from './effective-budget-contracts.js';
export type { InvestigationProfileLimits, InvestigationRuntimeAllocation } from './effective-budget-contracts.js';

const strict = { additionalProperties: false } as const;
const at = () => Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' });
const integer = (min: number, max: number) => Type.Integer({ minimum: min, maximum: max });

export const INVESTIGATION_EFFECTIVE_BUDGET_KEY = 'investigation.effective_budget.v1';
export const InvestigationEffectiveBudgetSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  version: integer(1, Number.MAX_SAFE_INTEGER),
  runtime: InvestigationRuntimeAllocationSchema,
  profileLimits: InvestigationProfileLimitsSchema,
  updatedAt: at(),
  updatedBy: Type.Optional(integer(1, Number.MAX_SAFE_INTEGER)),
}, strict);
export const InvestigationEffectiveBudgetInputSchema = Type.Object({
  expectedVersion: integer(0, Number.MAX_SAFE_INTEGER),
  runtime: InvestigationRuntimeAllocationSchema,
  profileLimits: InvestigationProfileLimitsSchema,
}, strict);

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
}
export interface EffectiveBudgetAuditContext {
  clientIp?: string;
  userAgent?: string;
}
export type EffectiveBudgetErrorCode =
  | 'INVESTIGATION_BUDGET_CONFIGURATION_INVALID'
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
export function defaultEffectiveBudget(capability?: InvestigationProviderCapacity, now = new Date().toISOString()): InvestigationEffectiveBudget {
  return { schemaVersion: 1, version: 0, runtime: defaultRuntime(capability), profileLimits: { ...CONSERVATIVE_PROFILE_LIMITS }, updatedAt: now };
}

export function assertEffectiveBudget(value: unknown): InvestigationEffectiveBudget {
  if (!Value.Check(InvestigationEffectiveBudgetSchema, value)) throw invalid();
  const budget = value as InvestigationEffectiveBudget;
  assertRelations(budget.runtime);
  return budget;
}
export function assertEffectiveBudgetInput(value: unknown): InvestigationEffectiveBudgetInput {
  if (!Value.Check(InvestigationEffectiveBudgetInputSchema, value)) throw invalid();
  assertRelations(value.runtime);
  return value as InvestigationEffectiveBudgetInput;
}
function assertRelations(runtime: InvestigationRuntimeAllocation) {
  if (runtime.contextWindowTokens < Math.max(runtime.outputTokens, runtime.summaryOutputTokens) + 1024
    || runtime.maxExecutionTokens < runtime.contextWindowTokens) throw invalid();
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
    private readonly now: () => string = () => new Date().toISOString()) {}

  private async capability(safe: boolean): Promise<InvestigationProviderCapacity | undefined> {
    try { return await this.capabilityResolver(); } catch (error) { if (safe) return undefined; throw error; }
  }

  async defaults(): Promise<InvestigationEffectiveBudget> {
    return defaultEffectiveBudget(await this.capability(true), this.now());
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
    return stored ? { budget: stored, source: 'settings' } : { budget: await this.defaults(), source: 'defaults' };
  }

  async view(): Promise<InvestigationEffectiveBudgetView> {
    const [stored, defaults, capability] = await Promise.all([this.get(), this.defaults(), this.capability(true)]);
    return { schemaVersion: 1, source: stored.source, effective: stored.budget, defaults, provider: capability ?? null,
      capabilityVerified: !!capability && capability.source !== 'conservative-fallback' && capability.maxOutputTokens !== undefined };
  }

  async save(actor: ActorContext, input: unknown, context: EffectiveBudgetAuditContext = {}): Promise<InvestigationEffectiveBudget> {
    const parsed = assertEffectiveBudgetInput(input);
    const capability = await this.capability(false);
    assertCapability(parsed.runtime, capability);
    const pool = this.poolProvider();
    if (!pool) throw unavailable();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const saved = await this.saveInTransaction(connection, actor, parsed, context, capability);
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
    const verified = capability ?? await this.capability(false);
    assertCapability(parsed.runtime, verified);
    const budget: InvestigationEffectiveBudget = { schemaVersion: 1, version: (previous?.version ?? 0) + 1,
      runtime: { ...parsed.runtime }, profileLimits: { ...parsed.profileLimits }, updatedAt: this.now(), updatedBy: actor.userId };
    await connection.execute(`REPLACE INTO system_config (config_key, config_value, value_type, updated_by)
      VALUES (?, ?, 'json', ?)`, [INVESTIGATION_EFFECTIVE_BUDGET_KEY, JSON.stringify(budget), actor.userId]);
    await connection.execute(`INSERT INTO audit_log_entries
      (id, event_type, level, user_id, username, user_role, action, resource_type, resource_id,
       details_json, client_ip, user_agent, result, timestamp_ms)
      VALUES (?, 'config_change', 'info', ?, ?, ?, 'investigation.effective_budget.update',
        'investigation_budget', 'effective_budget_v1', ?, ?, ?, 'success', ?)`,
      [randomUUID(), String(actor.userId), actor.username, actor.roles[0] ?? null, JSON.stringify({
        previousVersion: previous?.version ?? 0, version: budget.version,
        previous: previous ? { runtime: previous.runtime, profileLimits: previous.profileLimits } : null,
        next: { runtime: budget.runtime, profileLimits: budget.profileLimits },
        provider: verified ? { model: verified.model, contextWindowTokens: verified.contextWindowTokens, maxOutputTokens: verified.maxOutputTokens, source: verified.source } : null,
      }), context.clientIp ?? null, context.userAgent ?? null, Date.now()]);
    return budget;
  }
}

export const investigationEffectiveBudget = new InvestigationEffectiveBudgetService();
