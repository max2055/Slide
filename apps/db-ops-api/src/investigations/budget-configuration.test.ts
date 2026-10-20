import { afterEach, describe, expect, it, vi } from 'vitest';
import { investigationBudgetConfiguration } from './session-bridge.js';
import { INVESTIGATION_PROFILES, investigationProfileHash } from './profiles.js';

afterEach(() => vi.unstubAllEnvs());
describe('trusted investigation cumulative allocation configuration', () => {
  it('keeps the default profile allocation and authority hash', () => {
    vi.stubEnv('INVESTIGATION_MAX_TOKENS', undefined);
    expect(investigationBudgetConfiguration().maxExecutionTokens).toBeUndefined();
    expect(INVESTIGATION_PROFILES.ops.budget.maxTokens).toBe(32000);
  });
  it('configures new allocations without changing frozen profile authority', () => {
    const before = investigationProfileHash(INVESTIGATION_PROFILES.ops);
    vi.stubEnv('INVESTIGATION_MAX_TOKENS', '1000000');
    expect(investigationBudgetConfiguration().maxExecutionTokens).toBe(1000000);
    expect(investigationProfileHash(INVESTIGATION_PROFILES.ops)).toBe(before);
    expect(INVESTIGATION_PROFILES.ops.budget).toMatchObject({ maxProviderAttempts:8,maxToolCalls:20,deadlineMs:120000 });
  });
  it.each(['0','-1','1000001','1.5','Infinity',''])('rejects invalid configured allocation %s', value => {
    vi.stubEnv('INVESTIGATION_MAX_TOKENS', value);
    expect(() => investigationBudgetConfiguration()).toThrow('INVESTIGATION_MAX_TOKENS');
  });
  it('configures an isolated automatic daily quota without changing total quota or frozen authority', () => {
    const before = investigationProfileHash(INVESTIGATION_PROFILES.ops);
    vi.stubEnv('INVESTIGATION_MAX_TOKENS', '1000000');
    vi.stubEnv('INVESTIGATION_AUTOMATIC_DAILY_TOKENS', '1000000');
    vi.stubEnv('INVESTIGATION_BUDGET_DOMAIN', 'max207-investigation-1m-v1');
    expect(investigationBudgetConfiguration()).toMatchObject({ domain:'max207-investigation-1m-v1',maxExecutionTokens:1000000,
      policy:{maxAutomaticTokensPerDay:1000000,maxTotalTokensPerDay:1000000,maxConcurrent:4,manualReserved:1} });
    expect(investigationProfileHash(INVESTIGATION_PROFILES.ops)).toBe(before);
  });
  it('keeps the default automatic daily policy and domain', () => {
    vi.stubEnv('INVESTIGATION_AUTOMATIC_DAILY_TOKENS', undefined);
    vi.stubEnv('INVESTIGATION_BUDGET_DOMAIN', undefined);
    expect(investigationBudgetConfiguration()).toMatchObject({domain:'investigation-v1',policy:{maxAutomaticTokensPerDay:256000,maxTotalTokensPerDay:1000000}});
  });
  it.each(['0','-1','1000001','1.5','Infinity',''])('rejects invalid automatic daily quota %s', value => {
    vi.stubEnv('INVESTIGATION_AUTOMATIC_DAILY_TOKENS', value);
    expect(() => investigationBudgetConfiguration()).toThrow('INVESTIGATION_AUTOMATIC_DAILY_TOKENS');
  });
  it.each(['',' ','x'.repeat(129),'bad/domain'])('rejects invalid configured budget domain %s', value => {
    vi.stubEnv('INVESTIGATION_BUDGET_DOMAIN', value);
    expect(() => investigationBudgetConfiguration()).toThrow('INVESTIGATION_BUDGET_DOMAIN');
  });

});
