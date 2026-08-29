import { describe, expect, it } from 'vitest';
import { authorizeDatabaseTarget, DatabaseTargetPolicyError } from './database-target-policy.js';

const lookup = async (hostname: string) => {
  const entries: Record<string, string[]> = {
    'db.internal.example': ['10.20.30.40'],
    'mixed.internal.example': ['10.20.30.40', '127.0.0.1'],
    'public.example': ['203.0.113.10'],
    'metadata.example': ['169.254.169.254'],
  };
  if (!entries[hostname]) throw new Error('not found');
  return entries[hostname].map((address) => ({ address }));
};

describe('database target policy', () => {
  it('authorizes an explicitly allowed private database and returns its pinned address', async () => {
    await expect(authorizeDatabaseTarget(
      { host: 'db.internal.example', port: 3306, dbType: 'mysql' },
      { allowedCidrs: '10.20.0.0/16', lookup },
    )).resolves.toEqual({ hostname: 'db.internal.example', address: '10.20.30.40', port: 3306 });
  });

  it.each([
    [{ host: 'localhost', port: 3306, dbType: 'mysql' }, 'DB_TARGET_INVALID_HOST'],
    [{ host: '127.0.0.1', port: 3306, dbType: 'mysql' }, 'DB_TARGET_ADDRESS_DENIED'],
    [{ host: '169.254.169.254', port: 3306, dbType: 'mysql' }, 'DB_TARGET_ADDRESS_DENIED'],
    [{ host: 'db.internal.example', port: 0, dbType: 'mysql' }, 'DB_TARGET_INVALID_PORT'],
    [{ host: 'mixed.internal.example', port: 3306, dbType: 'mysql' }, 'DB_TARGET_ADDRESS_DENIED'],
    [{ host: 'missing.example', port: 3306, dbType: 'mysql' }, 'DB_TARGET_DNS_FAILED'],
  ])('rejects an unauthorized target with a stable reason code', async (target, reasonCode) => {
    await expect(authorizeDatabaseTarget(target, { allowedCidrs: '10.20.0.0/16', lookup }))
      .rejects.toMatchObject({ name: DatabaseTargetPolicyError.name, reasonCode });
  });

  it('allows a public target when it is not a special or metadata address', async () => {
    await expect(authorizeDatabaseTarget(
      { host: 'public.example', port: 3306, dbType: 'mysql' },
      { lookup },
    )).resolves.toMatchObject({ address: '203.0.113.10', port: 3306 });
  });

  it('allows a persisted loopback target only for non-production managed reconnects', async () => {
    await expect(authorizeDatabaseTarget(
      { host: 'localhost', port: 3306, dbType: 'mysql' },
      {
        allowedCidrs: '10.20.0.0/16',
        allowManagedLoopback: true,
        production: false,
        lookup: async () => [{ address: '::1' }, { address: '127.0.0.1' }],
      },
    )).resolves.toMatchObject({ address: '127.0.0.1' });

    await expect(authorizeDatabaseTarget(
      { host: '127.0.0.1', port: 3306, dbType: 'mysql' },
      { allowedCidrs: '127.0.0.0/8', allowedPorts: [3306], allowManagedLoopback: true, production: true },
    )).rejects.toMatchObject({ reasonCode: 'DB_TARGET_ADDRESS_DENIED' });
  });

  it('allows a persisted non-standard port in an allowed network', async () => {
    await expect(authorizeDatabaseTarget(
      { host: '10.20.30.40', port: 3308, dbType: 'mysql' },
      { allowedCidrs: '10.20.0.0/16', production: false },
    )).resolves.toMatchObject({ port: 3308 });

    await expect(authorizeDatabaseTarget(
      { host: '10.20.30.40', port: 3308, dbType: 'mysql' },
      { allowedCidrs: '10.20.0.0/16', production: true },
    )).resolves.toMatchObject({ port: 3308 });
  });
});
