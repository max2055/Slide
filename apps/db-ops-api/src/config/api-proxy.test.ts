import { describe, expect, it } from 'vitest';
import { resolveApiProxyTrust } from './api-proxy.js';

describe('API proxy trust', () => {
  it('uses direct mode when the list is absent or blank', () => {
    expect(resolveApiProxyTrust({})).toBe(false);
    expect(resolveApiProxyTrust({ API_TRUSTED_PROXY_IPS: ' ' })).toBe(false);
  });

  it.each(['true', '2', 'loopback', '192.0.2.0/24', '192.0.2.2,', 'fe80::1%eth0', '0.0.0.0', '0:0:0:0:0:0:0:0'])(
    'rejects invalid proxy configuration %s at startup', (configured) => {
      expect(() => resolveApiProxyTrust({ API_TRUSTED_PROXY_IPS: configured })).toThrow('API_TRUSTED_PROXY_IPS');
    },
  );

  it('trusts exact addresses only at their designated hop', () => {
    const trust = resolveApiProxyTrust({ API_TRUSTED_PROXY_IPS: ' 192.0.2.2 , 2001:db8::3 ' });
    expect(trust).toBeTypeOf('function');
    if (!trust) throw new Error('expected configured proxy trust');
    expect(trust('::ffff:192.0.2.2', 0)).toBe(true);
    expect(trust('2001:0db8:0:0:0:0:0:3', 1)).toBe(true);
    expect(trust('192.0.2.20', 0)).toBe(false);
    expect(trust('2001:db8::3', 0)).toBe(false);
    expect(trust('192.0.2.2', 1)).toBe(false);
    expect(trust('2001:db8::3', 2)).toBe(false);
  });
});
