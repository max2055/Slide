import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeDatabaseScanTarget, databaseScanProfiles } from './database-network-scan-policy.js';

describe('database network scan policy', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts an aligned /24 inside an explicit allowlist', () => {
    expect(authorizeDatabaseScanTarget({ cidr: '10.17.12.0/24', profile: 'common_databases' }, {
      allowedCidrs: ['10.17.0.0/16'], production: true,
    })).toEqual({ cidr: '10.17.12.0/24', profile: 'common_databases', ports: databaseScanProfiles.common_databases });
  });

  it.each([
    ['10.17.12.1/24', 'CIDR_NOT_NETWORK'],
    ['10.17.12.0/16', 'CIDR_TOO_LARGE'],
    ['10.17.12.0/23', 'CIDR_TOO_LARGE'],
    ['256.17.12.0/24', 'CIDR_INVALID'],
    ['::1/32', 'CIDR_INVALID'],
    ['10.17.12.0/24 ', 'CIDR_INVALID'],
    ['10.17.12.0/24', 'SCAN_PROFILE_INVALID'],
  ])('rejects unsafe scan request %s', (cidr, reasonCode) => {
    expect(() => authorizeDatabaseScanTarget({ cidr, profile: reasonCode === 'SCAN_PROFILE_INVALID' ? 'custom' : 'common_databases' }, {
      allowedCidrs: ['10.17.12.0/24'],
      production: true,
    })).toThrow(reasonCode);
  });

  // Regression for #280 / OCR-0016: explicit policy must constrain the full range.
  it.each([
    ['192.0.2.0/24', ['10.0.0.0/24']],
    ['10.17.12.0/24', ['10.17.12.0/25']],
    ['10.17.12.128/25', ['10.17.12.0/25']],
    ['10.17.12.0/24', ['10.17.12.0/25', '10.17.12.128/25']],
    ['255.255.255.255/32', ['0.0.0.0/1']],
  ])('rejects out-of-list or boundary-crossing target %s', (cidr, allowedCidrs) => {
    for (const production of [false, true]) {
      expect(() => authorizeDatabaseScanTarget({ cidr, profile: 'common_databases' }, {
        allowedCidrs, production,
      })).toThrow('SCAN_CIDR_DENIED');
    }
  });

  it.each([
    ['10.17.12.128/25', ['10.17.12.0/24']],
    ['10.17.12.255/32', ['10.17.12.0/24']],
    ['10.17.12.0/24', ['192.0.2.0/24', '10.17.12.0/24']],
    ['255.255.255.255/32', ['128.0.0.0/1']],
    ['192.0.2.0/24', ['0.0.0.0/0']],
  ])('accepts wholly contained target %s', (cidr, allowedCidrs) => {
    expect(authorizeDatabaseScanTarget({ cidr, profile: 'common_databases' }, {
      allowedCidrs, production: true,
    }).cidr).toBe(cidr);
  });

  it.each([false, true])('denies an explicit empty list (production=%s)', (production) => {
    expect(() => authorizeDatabaseScanTarget({ cidr: '10.17.12.0/24', profile: 'common_databases' }, {
      allowedCidrs: [], production,
    })).toThrow('SCAN_CIDR_DENIED');
  });

  it.each(['bad', '10.0.0.1/8', '10.0.0.0/33', '256.0.0.0/8', '::/0', '10.0.0.0/8 ', '10.0.0.0/-1'])('fails closed on malformed policy %s', (entry) => {
    expect(() => authorizeDatabaseScanTarget({ cidr: '10.17.12.0/24', profile: 'common_databases' }, {
      allowedCidrs: ['10.17.12.0/24', entry], production: false,
    })).toThrow('SCAN_POLICY_NOT_CONFIGURED');
  });

  it('requires policy in production, including when inferred from NODE_ENV', () => {
    const input = { cidr: '10.17.12.0/24', profile: 'common_databases' };
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => authorizeDatabaseScanTarget(input)).toThrow('SCAN_POLICY_NOT_CONFIGURED');
    expect(() => authorizeDatabaseScanTarget(input, { production: true })).toThrow('SCAN_POLICY_NOT_CONFIGURED');
    expect(authorizeDatabaseScanTarget(input, { production: false }).cidr).toBe(input.cidr);
    vi.stubEnv('NODE_ENV', 'test');
    expect(authorizeDatabaseScanTarget(input).cidr).toBe(input.cidr);
  });
});
