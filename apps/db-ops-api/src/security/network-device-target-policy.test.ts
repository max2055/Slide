import { describe, expect, it } from 'vitest';
import { authorizeNetworkDeviceTarget, NetworkDeviceTargetPolicyError } from './network-device-target-policy.js';

const lookup = async (hostname: string) => {
  const records: Record<string, string[]> = {
    'edge.internal.example': ['10.20.30.40'],
    'mixed.internal.example': ['10.20.30.40', '127.0.0.1'],
    'metadata.example': ['169.254.169.254'],
  };
  if (!records[hostname]) throw new Error('not found');
  return records[hostname].map((address) => ({ address }));
};

describe('network device target policy', () => {
  it('authorizes an explicitly allowed SNMP target and pins its address', async () => {
    await expect(authorizeNetworkDeviceTarget(
      { host: 'edge.internal.example', port: 161 },
      { allowedCidrs: '10.20.0.0/16', allowedPorts: [161, 162], lookup },
    )).resolves.toEqual({ hostname: 'edge.internal.example', address: '10.20.30.40', port: 161 });
  });

  it.each([
    [{ host: 'localhost', port: 161 }, 'SNMP_TARGET_INVALID_HOST'],
    [{ host: '127.0.0.1', port: 161 }, 'SNMP_TARGET_ADDRESS_DENIED'],
    [{ host: '0:0:0:0:0:ffff:c000:201', port: 161 }, 'SNMP_TARGET_ADDRESS_DENIED'],
    [{ host: 'metadata.example', port: 161 }, 'SNMP_TARGET_ADDRESS_DENIED'],
    [{ host: 'mixed.internal.example', port: 161 }, 'SNMP_TARGET_ADDRESS_DENIED'],
    [{ host: 'edge.internal.example', port: 0 }, 'SNMP_TARGET_INVALID_PORT'],
    [{ host: 'missing.example', port: 161 }, 'SNMP_TARGET_DNS_FAILED'],
  ])('rejects unauthorized targets with a stable reason', async (target, reasonCode) => {
    await expect(authorizeNetworkDeviceTarget(target, { allowedCidrs: '10.20.0.0/16', allowedPorts: [161], lookup }))
      .rejects.toMatchObject({ name: NetworkDeviceTargetPolicyError.name, reasonCode });
  });

  it('normalizes malformed runtime input to stable validation errors', async () => {
    await expect(authorizeNetworkDeviceTarget(null as any, { allowedCidrs: '10.20.0.0/16', allowedPorts: [161], lookup }))
      .rejects.toMatchObject({ reasonCode: 'SNMP_TARGET_INVALID_HOST' });
    await expect(authorizeNetworkDeviceTarget({ host: 42 as any, port: 161 }, { allowedCidrs: '10.20.0.0/16', allowedPorts: [161], lookup }))
      .rejects.toMatchObject({ reasonCode: 'SNMP_TARGET_INVALID_HOST' });
  });

  it('keeps both read-only network transports available in non-production defaults', async () => {
    await expect(authorizeNetworkDeviceTarget({ host: '10.20.30.40', port: 161 }, { allowedCidrs: '10.20.0.0/16' }))
      .resolves.toMatchObject({ address: '10.20.30.40', port: 161 });
    await expect(authorizeNetworkDeviceTarget({ host: '10.20.30.40', port: 22 }, { allowedCidrs: '10.20.0.0/16' }))
      .resolves.toMatchObject({ address: '10.20.30.40', port: 22 });
  });

  it('allows a public target when it is not a special or metadata address', async () => {
    await expect(authorizeNetworkDeviceTarget(
      { host: '203.0.113.10', port: 1161 },
      { lookup },
    )).resolves.toMatchObject({ address: '203.0.113.10', port: 1161 });
  });
});
