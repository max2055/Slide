import { describe, expect, it } from 'vitest';
import { authorizeDatabaseScanTarget, databaseScanProfiles } from './database-network-scan-policy.js';

describe('database network scan policy', () => {
  it('accepts an aligned /24 target without an environment CIDR allowlist', () => {
    expect(authorizeDatabaseScanTarget({ cidr: '10.17.12.0/24', profile: 'common_databases' }, {
      production: true,
    })).toEqual({ cidr: '10.17.12.0/24', profile: 'common_databases', ports: databaseScanProfiles.common_databases });
  });

  it.each([
    ['10.17.12.1/24', 'CIDR_NOT_NETWORK'],
    ['10.17.12.0/16', 'CIDR_TOO_LARGE'],
    ['10.17.12.0/24', 'SCAN_PROFILE_INVALID'],
  ])('rejects unsafe scan request %s', (cidr, reasonCode) => {
    expect(() => authorizeDatabaseScanTarget({ cidr, profile: reasonCode === 'SCAN_PROFILE_INVALID' ? 'custom' : 'common_databases' }, {
      allowedCidrs: ['10.17.12.0/24'],
      production: true,
    })).toThrow(reasonCode);
  });

  it('accepts any aligned private /24 when no CIDR allowlist is configured', () => {
    expect(authorizeDatabaseScanTarget({ cidr: '10.18.12.0/24', profile: 'common_databases' }, {
      allowedCidrs: ['10.17.12.0/24'],
      production: true,
    })).toEqual({ cidr: '10.18.12.0/24', profile: 'common_databases', ports: databaseScanProfiles.common_databases });
  });

});
