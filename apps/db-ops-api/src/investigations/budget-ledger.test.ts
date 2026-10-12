import { describe, expect, it } from 'vitest';
import { measuredBudget, MysqlInvestigationBudgetLedger, type BudgetPolicy } from './budget-ledger.js';

const testBudgetPolicy: BudgetPolicy = { currency: 'USD', maxConcurrent: 4, manualReserved: 1, maxPerResourceConcurrent: 2,
  maxAutomaticRequestsPerHour: 20, maxAutomaticTokensPerDay: 1_000_000, maxTotalTokensPerDay: 2_000_000,
  maxCostMicrosPerDay: 1_000_000 };

describe('budget usage and integer monetary accounting', () => {
  it('counts cached input as an input subset and prices each class once', () => {
    expect(measuredBudget({ inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 200 },
      { input: 2_000_000, cachedInput: 500_000, output: 8_000_000 })).toEqual({ tokens: 1_200, costMicros: 3_000 });
  });
  it('rounds a fractional micro-unit up without floating point multiplication', () => {
    expect(measuredBudget({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 },
      { input: 1, cachedInput: 0, output: 0 })).toEqual({ tokens: 1, costMicros: 1 });
  });
  it('missing prices are explicitly unknown; actual zero usage is distinct', () => {
    expect(measuredBudget({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 })).toEqual({ tokens: 1, costMicros: null });
    expect(measuredBudget({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      { input: 1, cachedInput: 1, output: 1 })).toEqual({ tokens: 0, costMicros: 0 });
  });
  it.each([
    { inputTokens: -1, cachedInputTokens: 0, outputTokens: 1 },
    { inputTokens: 1, cachedInputTokens: 2, outputTokens: 1 },
    { inputTokens: 1.5, cachedInputTokens: 0, outputTokens: 1 },
    { inputTokens: NaN, cachedInputTokens: 0, outputTokens: 1 },
    { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 1 },
  ])('rejects invalid or unmeasurable usage %j', usage => {
    expect(() => measuredBudget(usage)).toThrow('BUDGET_INPUT_INVALID');
  });
  it('rejects unsafe monetary totals and negative prices', () => {
    const usage = { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 0 };
    expect(() => measuredBudget(usage, { input: Number.MAX_SAFE_INTEGER, cachedInput: 0, output: 0 })).toThrow('BUDGET_INPUT_INVALID');
    expect(() => measuredBudget(usage, { input: -1, cachedInput: 0, output: 0 })).toThrow('BUDGET_INPUT_INVALID');
  });
  it.each([{ maxConcurrent: 0 }, { manualReserved: 5 }, { maxCostMicrosPerDay: Infinity },
    { maxTotalTokensPerDay: 100 }, { maxAutomaticRequestsPerHour: 0 }])('fails closed for invalid policy %j', change => {
    expect(() => new MysqlInvestigationBudgetLedger(() => null, { ...testBudgetPolicy, ...change })).toThrow('BUDGET_INPUT_INVALID');
  });
  it('does not silently operate without durable storage', async () => {
    await expect(new MysqlInvestigationBudgetLedger(() => null, testBudgetPolicy).read('00000000-0000-0000-0000-000000000001'))
      .rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
  });
});
