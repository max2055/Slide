import { describe, expect, it, vi } from 'vitest';

import {
  SnmpClient,
  SnmpClientError,
  type SnmpSession,
} from './snmp-client.js';
import type { SnmpV3Config } from './snmp-types.js';

const baseConfig: SnmpV3Config = {
  host: '192.0.2.10',
  port: 161,
  username: 'monitor',
  securityLevel: 'authPriv',
  authProtocol: 'SHA',
  authSecret: 'auth-secret-123',
  privacyProtocol: 'AES',
  privacySecret: 'privacy-secret-123',
};

function session(overrides: Partial<SnmpSession> = {}): SnmpSession {
  return {
    get: vi.fn(async () => [{ oid: '1.3.6.1.2.1.1.3.0', type: 'TimeTicks', value: 42 }]),
    table: vi.fn(async () => []),
    close: vi.fn(),
    ...overrides,
  };
}

describe('SnmpClient', () => {
  it('maps an authPriv v3 config and closes the session after a GET', async () => {
    const active = session();
    const factory = vi.fn(async (config: SnmpV3Config) => {
      expect(config.securityLevel).toBe('authPriv');
      expect(config.authProtocol).toBe('SHA');
      expect(config.privacyProtocol).toBe('AES');
      return active;
    });
    const client = new SnmpClient(factory);

    await expect(client.get(baseConfig, ['1.3.6.1.2.1.1.3.0'])).resolves.toEqual([
      { oid: '1.3.6.1.2.1.1.3.0', type: 'TimeTicks', value: 42 },
    ]);
    expect(active.get).toHaveBeenCalledWith(['1.3.6.1.2.1.1.3.0']);
    expect(active.close).toHaveBeenCalledTimes(1);
  });

  it('rejects v1/v2c-shaped configs before opening a session', async () => {
    const factory = vi.fn();
    const client = new SnmpClient(factory);

    await expect(client.get({ ...baseConfig, version: 2 } as any, ['1.3.6.1.2.1.1.3.0']))
      .rejects.toMatchObject({ code: 'SNMP_UNSUPPORTED_SECURITY' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects OIDs outside the configured read allowlist', async () => {
    const factory = vi.fn(async () => session());
    const client = new SnmpClient(factory, {
      allowedOidRoots: ['1.3.6.1.2.1.1'],
    });

    await expect(client.get(baseConfig, ['1.3.6.1.2.1.2.2.1.10.1']))
      .rejects.toMatchObject({ code: 'SNMP_OID_DENIED' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('normalizes session errors and still closes the session', async () => {
    const active = session({ get: vi.fn(async () => { throw new Error('Request timed out'); }) });
    const client = new SnmpClient(async () => active);

    await expect(client.get(baseConfig, ['1.3.6.1.2.1.1.3.0']))
      .rejects.toMatchObject({ code: 'SNMP_TIMEOUT' });
    expect(active.close).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized or malformed varbind responses', async () => {
    const malformed = session({ get: vi.fn(async () => [{ oid: 'not-an-oid', value: 'x' }]) });
    const client = new SnmpClient(async () => malformed);
    await expect(client.get(baseConfig, ['1.3.6.1.2.1.1.3.0']))
      .rejects.toMatchObject({ code: 'SNMP_RESPONSE_INVALID' });
    expect(malformed.close).toHaveBeenCalledTimes(1);

    const huge = session({ get: vi.fn(async () => [{ oid: '1.3.6.1.2.1.1.3.0', value: 'x'.repeat(100) }]) });
    const bounded = new SnmpClient(async () => huge, { maxResponseBytes: 32 });
    await expect(bounded.get(baseConfig, ['1.3.6.1.2.1.1.3.0']))
      .rejects.toMatchObject({ code: 'SNMP_RESPONSE_LIMIT' });
    expect(huge.close).toHaveBeenCalledTimes(1);
  });

  it('does not expose a write operation', () => {
    expect('set' in SnmpClient.prototype).toBe(false);
  });

  it('preserves stable error instances for callers', () => {
    const error = new SnmpClientError('SNMP_TARGET_DENIED', 'target policy denied');
    expect(error.code).toBe('SNMP_TARGET_DENIED');
    expect(error.name).toBe('SnmpClientError');
  });
});
