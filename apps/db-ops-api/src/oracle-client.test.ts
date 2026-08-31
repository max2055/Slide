import { describe, expect, it } from 'vitest';
import { formatOracleConnectionError } from './oracle-client.js';

describe('Oracle client compatibility diagnostics', () => {
  it('explains that Oracle 11g requires Thick mode', () => {
    expect(formatOracleConnectionError(new Error('NJS-138: connections to this database server version are not supported by node-oracledb in Thin mode')))
      .toContain('ORACLE_LEGACY_SERVER_REQUIRES_THICK_MODE');
  });

  it('explains how to resolve a missing Thick mode client', () => {
    expect(formatOracleConnectionError(new Error('DPI-1047: Cannot locate a 64-bit Oracle Client library')))
      .toContain('ORACLE_THICK_MODE_UNAVAILABLE');
  });
});
