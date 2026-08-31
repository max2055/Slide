import { describe, expect, it } from 'vitest';
import { buildDatabaseScanJob, parseDatabaseScanRequest } from './network-scan.js';

describe('database scan controller profile', () => {
  it('builds a fixed Nmap command and logical execution profile', () => {
    expect(buildDatabaseScanJob({ cidr: '10.17.12.0/24', profile: 'common_databases' })).toEqual({
      runtime: 'shell', networkMode: 'restricted', executionProfile: 'database-network-scan',
      command: ['nmap', '-n', '-Pn', '-sT', '--open', '--max-retries', '1', '--host-timeout', '15s', '-p', '1433,1521,27017,3306,5236,5432,6379,9200', '10.17.12.0/24', '-oG', '-'],
    });
  });

  it.each([
    [{ cidr: '10.17.12.1/24', profile: 'common_databases' }, 'CIDR_NOT_NETWORK'],
    [{ cidr: '10.17.12.0/24', profile: 'custom' }, 'SCAN_PROFILE_INVALID'],
  ])('rejects uncontrolled request %j', (input, reasonCode) => {
    expect(() => parseDatabaseScanRequest(input)).toThrow(reasonCode);
  });
});
