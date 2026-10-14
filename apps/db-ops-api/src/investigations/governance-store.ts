import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { Value } from '@sinclair/typebox/value';
import { ActorContextService, ActorAuthenticationError, type ActorContext } from '../auth/actor-context.js';
import { hasPermission } from '../auth/require-permission.js';
import { freezeInvestigationCaller } from './authorization.js';
import { MysqlInvestigationBudgetLedger, type BudgetPolicy } from './budget-ledger.js';
import { investigationBudgetConfiguration } from './session-bridge.js';
import { InvestigationBudgetPolicySchema, type InvestigationBudgetResponse, type InvestigationUsageResponse } from './governance-contracts.js';
import { databaseAlertPilotConfiguration, investigationBridgeFlags } from './bridge-flags.js';

export class GovernanceReadError extends Error {
  constructor(readonly code: 'GOVERNANCE_FORBIDDEN' | 'GOVERNANCE_UNAVAILABLE') { super(code); }
}
const unavailable = () => new GovernanceReadError('GOVERNANCE_UNAVAILABLE');
const number = (value: unknown): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw unavailable();
  return result;
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

/** Global governance is deliberately management-only, not ai:view resource
 * access. The same SQL connection reloads live identity before ANY ledger read.
 * No write-side ledger method or implicit domain registration is used. */
export class InvestigationGovernanceStore {
  constructor(private readonly poolProvider: () => Pool | null,
    private readonly configuration = investigationBudgetConfiguration,
    private readonly contexts = new ActorContextService()) {}

  private async read<T>(caller: ActorContext, management: boolean, work: (c: PoolConnection) => Promise<T>): Promise<T> {
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
      const result = await work(c);
      await c.commit();
      return result;
    } catch (error) {
      await c.rollback();
      if (error instanceof ActorAuthenticationError || error instanceof GovernanceReadError) throw error;
      throw unavailable();
    } finally { c.release(); }
  }

  policies(caller: ActorContext) {
    return this.read(caller, false, async () => {
      const configured = databaseAlertPilotConfiguration().configured, enabled = investigationBridgeFlags().opsAuto;
      return { schemaVersion: 1 as const, configurationStatus: configured ? 'configured' as const : 'not_configured' as const,
        integrationStatus: configured && enabled ? 'connected' as const : 'not_connected' as const,
        source: 'production_composition' as const,
        items: configured ? [{ id: 'database-alert-pilot' as const, version: 1 as const, profileId: 'ops' as const,
          source: 'database-alert-engine' as const, enabled, readonly: true as const }] : [], originBoundary: 'investigation_engine_persist_only' as const };
    });
  }

  budget(caller: ActorContext): Promise<InvestigationBudgetResponse> {
    return this.read(caller, true, async c => {
      const config = this.configuration();
      // Constructor validates the same effective configuration as execution;
      // it does not initialize a domain or perform any SQL.
      new MysqlInvestigationBudgetLedger(this.poolProvider, config.policy);
      if (!Number.isSafeInteger(config.reserveCostMicros) || config.reserveCostMicros < 1) throw unavailable();
      const configured = policy(config.policy);
      const [domain] = await rows(c, 'SELECT policy_snapshot, policy_hash FROM investigation_budget_domains WHERE domain_key = ?', [config.domain]);
      const persisted = domain ? policy(json(domain.policy_snapshot)) : null;
      return { schemaVersion: 1, source: 'investigationBudgetConfiguration', policy: configured,
        reserveCostMicros: number(config.reserveCostMicros), persistedPolicy: persisted,
        admissionStatus: persisted === null ? 'uninitialized' : isDeepStrictEqual(persisted, configured) && domain.policy_hash === createHash('sha256').update(JSON.stringify(configured)).digest('hex') ? 'matching' : 'conflict',
        automaticTriggerStatus: databaseAlertPilotConfiguration().configured && investigationBridgeFlags().opsAuto ? 'connected' : 'not_connected',
        window: 'UTC_admission_day_and_hour', profileLimitsSource: '/api/investigation-profiles' };
    });
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
