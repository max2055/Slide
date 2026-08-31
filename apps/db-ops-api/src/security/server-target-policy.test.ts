import { describe, expect, it } from 'vitest';
import { authorizeServerTarget, ServerTargetPolicyError } from './server-target-policy.js';

const lookup = async (hostname: string) => {
  const entries: Record<string, string[]> = {
    'ssh.internal.example': ['10.20.30.40'],
    'mixed.internal.example': ['10.20.30.40', '127.0.0.1'],
    'metadata.example': ['169.254.169.254'],
    'public.example': ['203.0.113.10'],
  };
  if (!entries[hostname]) throw new Error('not found');
  return entries[hostname].map((address) => ({ address }));
};

describe('server target policy', () => {
  it('authorizes an explicitly allowed SSH target and pins its address', async () => {
    await expect(authorizeServerTarget(
      { host: 'ssh.internal.example', port: 2222 },
      { allowedCidrs: '10.20.0.0/16', allowedPorts: [22, 2222], lookup },
    )).resolves.toEqual({ hostname: 'ssh.internal.example', address: '10.20.30.40', port: 2222 });
  });

  it.each([
    [{ host: 'localhost', port: 22 }, 'SERVER_TARGET_INVALID_HOST'],
    [{ host: '127.0.0.1', port: 22 }, 'SERVER_TARGET_ADDRESS_DENIED'],
    [{ host: '169.254.169.254', port: 22 }, 'SERVER_TARGET_ADDRESS_DENIED'],
    [{ host: 'metadata.example', port: 22 }, 'SERVER_TARGET_ADDRESS_DENIED'],
    [{ host: 'mixed.internal.example', port: 22 }, 'SERVER_TARGET_ADDRESS_DENIED'],
    [{ host: 'ssh.internal.example', port: 0 }, 'SERVER_TARGET_INVALID_PORT'],
    [{ host: 'missing.example', port: 22 }, 'SERVER_TARGET_DNS_FAILED'],
  ])('rejects unauthorized server targets with a stable reason', async (target, reasonCode) => {
    await expect(authorizeServerTarget(target, { allowedCidrs: '10.20.0.0/16', lookup }))
      .rejects.toMatchObject({ name: ServerTargetPolicyError.name, reasonCode });
  });

  it('allows a public target when it is not a special or metadata address', async () => {
    await expect(authorizeServerTarget(
      { host: 'public.example', port: 3306 },
      { lookup },
    )).resolves.toMatchObject({ address: '203.0.113.10', port: 3306 });
  });
});
