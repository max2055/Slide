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
});
