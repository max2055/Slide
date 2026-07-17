import { describe, expect, it } from 'vitest';
import { authorizeOutboundUrl, OutboundPolicyError } from './outbound-policy.js';

const lookup = async (hostname: string) => {
  const entries: Record<string, string[]> = {
    'hooks.example.com': ['203.0.113.10'],
    'mixed.example.com': ['203.0.113.10', '127.0.0.1'],
    'v6-local.example.com': ['fe80::1'],
  };
  if (!entries[hostname]) throw new Error('not found');
  return entries[hostname].map((address) => ({ address }));
};

describe('outbound policy', () => {
  it('allows only an allowlisted HTTPS public target', async () => {
    await expect(authorizeOutboundUrl('https://hooks.example.com/path', { allowedHosts: ['example.com'], lookup }))
      .resolves.toMatchObject({ hostname: 'hooks.example.com' });
  });

  it.each([
    ['http://hooks.example.com', 'UNSUPPORTED_SCHEME'],
    ['https://hooks.example.com:8443', 'PORT_DENIED'],
    ['https://evil.example.net', 'HOST_DENIED'],
    ['https://missing.example.com', 'DNS_FAILED'],
    ['https://mixed.example.com', 'PRIVATE_ADDRESS'],
    ['https://v6-local.example.com', 'PRIVATE_ADDRESS'],
  ])('rejects %s with %s', async (url, reasonCode) => {
    await expect(authorizeOutboundUrl(url, { allowedHosts: ['example.com'], lookup }))
      .rejects.toMatchObject({ name: OutboundPolicyError.name, reasonCode });
  });
});
