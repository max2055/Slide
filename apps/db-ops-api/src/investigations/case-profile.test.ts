import { describe, expect, it } from 'vitest';
import { INVESTIGATION_PROFILES, investigationProfileHash, resolveInvestigationProfile } from './profiles.js';
describe('versioned case reference capability', () => {
  it('retains both v1 hashes and gives only ops v2 the read-only case tool', () => {
    expect(investigationProfileHash(INVESTIGATION_PROFILES.ops)).toBe('d96e02206b6fc4bc65198fec701fd64a220fcf796edfa3fc1aba6ba45956b2af');
    expect(investigationProfileHash(INVESTIGATION_PROFILES.system)).toBe('54659cfa87ca4ff207844711d4ea6809a5685a22d0f69e271247aea416e65da4');
    const next = resolveInvestigationProfile('ops', 2);
    expect(next.toolAllowlist).toContain('search_case_references');
    expect(next.readonly).toBe(true);
    expect(next.prompt.hash).not.toBe(INVESTIGATION_PROFILES.ops.prompt.hash);
    expect(INVESTIGATION_PROFILES.ops.toolAllowlist).not.toContain('search_case_references');
    expect(() => resolveInvestigationProfile('system', 2)).toThrow();
  });
});
