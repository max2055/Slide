import type { BudgetPolicy } from './budget-ledger.js';

/** Relaxed server defaults. The effective-budget setting may rotate past these
 * values into a new domain revision, but the env fallback stays operative when
 * no durable setting exists. */
export const DEFAULT_MAX_TOTAL_TOKENS_PER_DAY = 5_000_000;
export const DEFAULT_MAX_AUTOMATIC_TOKENS_PER_DAY = 5_000_000;
export const DEFAULT_MAX_COST_MICROS_PER_DAY = 10_000_000;

export interface InvestigationBudgetConfiguration {
  maxExecutionTokens?: number;
  domain: string;
  reserveCostMicros: number;
  policy: BudgetPolicy;
}

/** One trusted configuration for HTTP cancellation and Workflow execution. */
export function investigationBudgetConfiguration(env: NodeJS.ProcessEnv = process.env): InvestigationBudgetConfiguration {
  const configured = env.INVESTIGATION_MAX_TOKENS;
  const maxExecutionTokens = configured === undefined ? undefined : Number(configured);
  if (configured !== undefined && (!configured.trim() || !Number.isSafeInteger(maxExecutionTokens)
    || maxExecutionTokens! < 1 || maxExecutionTokens! > 1_000_000)) throw new Error('INVESTIGATION_MAX_TOKENS');
  const automaticDaily = env.INVESTIGATION_AUTOMATIC_DAILY_TOKENS;
  const maxAutomaticTokensPerDay = automaticDaily === undefined ? DEFAULT_MAX_AUTOMATIC_TOKENS_PER_DAY : Number(automaticDaily);
  if (automaticDaily !== undefined && (!automaticDaily.trim() || !Number.isSafeInteger(maxAutomaticTokensPerDay)
    || maxAutomaticTokensPerDay < 1 || maxAutomaticTokensPerDay > DEFAULT_MAX_TOTAL_TOKENS_PER_DAY))
    throw new Error('INVESTIGATION_AUTOMATIC_DAILY_TOKENS');
  // A separately named, server-owned domain permits isolated policy changes;
  // existing domain snapshots/charges are never rewritten or silently migrated.
  const domain = env.INVESTIGATION_BUDGET_DOMAIN ?? 'investigation-v1';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(domain)) throw new Error('INVESTIGATION_BUDGET_DOMAIN');
  return { ...(maxExecutionTokens === undefined ? {} : { maxExecutionTokens }), domain,
    reserveCostMicros: Number(env.INVESTIGATION_RESERVED_COST_MICROS ?? 1_000_000),
    policy: { currency: 'USD', maxConcurrent: 4, manualReserved: 1, maxPerResourceConcurrent: 2,
      maxAutomaticRequestsPerHour: 20, maxAutomaticTokensPerDay,
      maxTotalTokensPerDay: DEFAULT_MAX_TOTAL_TOKENS_PER_DAY,
      maxCostMicrosPerDay: Number(env.INVESTIGATION_DAILY_COST_MICROS ?? DEFAULT_MAX_COST_MICROS_PER_DAY) } };
}
