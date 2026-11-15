import { describe, expect, it, vi } from 'vitest';
import { isPublicIp, resolveOutboundTarget } from './outbound-policy.js';
import { authorizeServerTarget } from './server-target-policy.js';
import { authorizeNetworkDeviceTarget } from './network-device-target-policy.js';
import { authorizeDatabaseTarget } from './database-target-policy.js';

vi.mock('./security-event-service.js', () => ({
  securityEventService: { record: vi.fn().mockResolvedValue(undefined) },
}));

// GitHub #295: equivalent spellings must receive the same classification.
const nonPublicAddresses = [
  '127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1',
  '::ffff:a9fe:a9fe', '0:0:0:0:0:FFFF:7F00:0001',
  '0:0:0:0:0:ffff:169.254.169.254',
  '::', '0:0:0:0:0:0:0:1', 'fe80::1', 'fe90::1', 'febf::1',
  'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fe90::1%en0',
  'fc00::1', 'fd00::1', 'ff02::1', 'invalid',
];

describe('GitHub #295 outbound IPv6 classification', () => {
  it.each(nonPublicAddresses)('rejects %s alone and in mixed DNS results', async (address) => {
    expect(isPublicIp(address)).toBe(false);
    for (const addresses of [[address], ['8.8.8.8', address], [address, '2606:4700:4700::1111']]) {
      await expect(resolveOutboundTarget('https://hooks.example.invalid/report', {
        allowedHosts: ['example.invalid'],
        lookup: async () => addresses.map((value) => ({ address: value })),
      })).rejects.toMatchObject({ reasonCode: 'PRIVATE_ADDRESS' });
    }
  });

  it.each(['8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808', '0:0:0:0:0:ffff:8.8.8.8', 'fec0::1'])
    ('preserves allowed address %s and its pinned representation', async (address) => {
      expect(isPublicIp(address)).toBe(true);
      await expect(resolveOutboundTarget('https://hooks.example.invalid/report', {
        allowedHosts: ['example.invalid'], lookup: async () => [{ address }],
      })).resolves.toMatchObject({ addresses: [address] });
    });
});

const policies = [
  { name: 'server', reasonCode: 'SERVER_TARGET_ADDRESS_DENIED', authorize: authorizeServerTarget },
  { name: 'network', reasonCode: 'SNMP_TARGET_ADDRESS_DENIED', authorize: authorizeNetworkDeviceTarget },
  { name: 'database', reasonCode: 'DB_TARGET_ADDRESS_DENIED', authorize: authorizeDatabaseTarget },
];

// GitHub #585: block these transition mechanisms rather than depending on the
// deployment's NAT64/6to4 routes. Native public IPv6 remains supported.
const deniedTargets = [
  '127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1',
  '0:0:0:0:0:ffff:7f00:1',
  '64:ff9b::127.0.0.1', '64:ff9b::7f00:1',
  '0064:FF9B:0000:0000:0000:0000:7F00:0001',
  '64:ff9b::a9fe:a9fe', '64:ff9b::808:808',
  '2002:7f00:1::', '2002:7fff:ffff:ffff:ffff:ffff:ffff:ffff',
  '2002:a9fe:a9fe::', '2002:808:808::',
];

describe.each(policies)('GitHub #585 $name policy', ({ authorize, reasonCode }) => {
  it.each(deniedTargets)('rejects literal and DNS target %s', async (address) => {
    const literalTarget = { host: address, port: 12345, dbType: 'mysql' };
    const dnsTarget = { ...literalTarget, host: 'target.example.invalid' };
    await expect(authorize(literalTarget))
      .rejects.toMatchObject({ reasonCode });
    for (const addresses of [[address], ['8.8.8.8', address], [address, '8.8.8.8']]) {
      await expect(authorize(dnsTarget, {
        lookup: async () => addresses.map((value) => ({ address: value })),
      })).rejects.toMatchObject({ reasonCode });
    }
  });

  it.each(['8.8.8.8', '2606:4700:4700::1111', '10.20.30.40'])
    ('preserves native target %s and returns the resolved address', async (address) => {
      const target = { host: 'target.example.invalid', port: 12345, dbType: 'mysql' };
      await expect(authorize(target, {
        lookup: async () => [{ address }],
      })).resolves.toMatchObject({ address, port: 12345 });
    });
});

it('does not extend managed database loopback exceptions to transition addresses (#585)', async () => {
  for (const host of deniedTargets.filter((address) => /^(64:|0064:|2002:)/i.test(address))) {
    await expect(authorizeDatabaseTarget({ host, port: 3306, dbType: 'mysql' }, {
      allowManagedLoopback: true, production: false,
    })).rejects.toMatchObject({ reasonCode: 'DB_TARGET_ADDRESS_DENIED' });
  }
});
