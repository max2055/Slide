import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe('trusted investigation cumulative token configuration', () => {
  it('keeps the default whole-execution allocation at 32000', async () => {
    vi.stubEnv('INVESTIGATION_MAX_TOKENS', undefined); vi.resetModules();
    const { INVESTIGATION_PROFILES } = await import('./profiles.js');
    expect(INVESTIGATION_PROFILES.ops.budget.maxTokens).toBe(32000);
  });
  it('uses the authorized million in both admission and execution profile identity', async () => {
    vi.stubEnv('INVESTIGATION_MAX_TOKENS', '1000000'); vi.resetModules();
    const { INVESTIGATION_PROFILES, resolveInvestigationProfile, investigationProfileHash } = await import('./profiles.js');
    const profile = resolveInvestigationProfile('ops', 1);
    expect(profile.budget.maxTokens).toBe(1000000);
    expect(profile).toBe(INVESTIGATION_PROFILES.ops);
    expect(investigationProfileHash(profile)).not.toBe(investigationProfileHash({ ...profile,
      budget: { ...profile.budget, maxTokens: 32000 } }));
    expect(profile.budget).toMatchObject({ maxProviderAttempts: 8, maxToolCalls: 20, deadlineMs: 120000 });
  });
  it.each(['0', '-1', '1000001', '1.5', 'Infinity', ''])('rejects invalid configured allocation %s', async value => {
    vi.stubEnv('INVESTIGATION_MAX_TOKENS', value); vi.resetModules();
    await expect(import('./profiles.js')).rejects.toThrow('INVESTIGATION_MAX_TOKENS');
  });
});
