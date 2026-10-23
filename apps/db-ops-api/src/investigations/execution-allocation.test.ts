import { describe, expect, it } from 'vitest';
import { MAX222_OFFLINE_EXECUTION, freezeExecutionAllocation, readExecutionAllocation, taskExecutionConfiguration } from './execution-allocation.js';
import { investigationBudgetConfiguration } from './session-bridge.js';
import { INVESTIGATION_PROFILES, investigationProfileHash } from './profiles.js';
import { MysqlInvestigationBudgetLedger } from './budget-ledger.js';
const policy = { ...investigationBudgetConfiguration().policy, maxAutomaticTokensPerDay: 1200000, maxTotalTokensPerDay: 1200000 };
const binding = { requestId: '00000000-0000-0000-0000-000000000001', investigationId: '00000000-0000-0000-0000-000000000002',
  profile: INVESTIGATION_PROFILES.ops, domain: 'qualification.max222.test', mode: 'manual' as const };
describe('dormant task allocation identity', () => {
  it('round trips SQL key ordering without changing permission profile or defaults', () => {
    const before = investigationProfileHash(binding.profile);
    const frozen = freezeExecutionAllocation(MAX222_OFFLINE_EXECUTION, binding, policy);
    // SQL JSON changes nested key order too.
    const reverse = (v: any): any => v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k,x]) => [k,reverse(x)])) : v;
    expect(readExecutionAllocation(reverse(frozen), binding, policy)).toEqual(frozen);
    expect(investigationProfileHash(binding.profile)).toBe(before);
    expect(binding.profile.budget).toMatchObject({ maxToolCalls:20, maxProviderAttempts:8, deadlineMs:120000 });
    expect(readExecutionAllocation(undefined, binding, policy)).toBeUndefined();
    expect(() => new MysqlInvestigationBudgetLedger(() => null, policy, 1200000)).toThrow('BUDGET_INPUT_INVALID');
  });
  it.each(['requestId','investigationId','domain','mode','profileHash','policyHash','hash'])('rejects altered frozen %s', key => {
    const frozen = freezeExecutionAllocation(MAX222_OFFLINE_EXECUTION, binding, policy);
    expect(() => readExecutionAllocation({ ...frozen, [key]:'changed' }, binding, policy)).toThrow('INVESTIGATION_ALLOCATION_INVALID');
  });
  it('rejects a recomputed larger configuration and unknown fields', () => {
    for (const change of [{maxToolCalls:37}, {maxTotalTokens:1200001}, {deadlineMs:120001}, {maxProviderAttempts:9}, {extra:1}])
      expect(() => taskExecutionConfiguration({ ...MAX222_OFFLINE_EXECUTION, ...change } as any, binding.domain, policy)).toThrow('INVESTIGATION_ALLOCATION_INVALID');
    const frozen = freezeExecutionAllocation(MAX222_OFFLINE_EXECUTION, binding, policy);
    expect(() => readExecutionAllocation({...frozen, extra:1}, binding, policy)).toThrow();
  });
  it('cannot enable a shared domain, insufficient daily policy, or a different profile', () => {
    for (const domain of ['investigation-v1', 'other', 'qualification.max222.'])
      expect(() => taskExecutionConfiguration(MAX222_OFFLINE_EXECUTION, domain, policy)).toThrow();
    expect(() => freezeExecutionAllocation(MAX222_OFFLINE_EXECUTION, binding, investigationBudgetConfiguration().policy)).toThrow();
    expect(() => freezeExecutionAllocation(MAX222_OFFLINE_EXECUTION, {...binding, profile:INVESTIGATION_PROFILES.system}, policy)).toThrow();
  });
});
