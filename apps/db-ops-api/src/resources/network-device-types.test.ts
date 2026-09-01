import { describe, expect, it } from 'vitest';
import { parseNetworkDeviceCreateInput, validateConfigBackupSize, validateSnmpV3Credential } from './network-device-types.js';

const snmp = { username: 'monitor', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: 'auth-secret', privacyProtocol: 'AES', privacySecret: 'priv-secret' };

describe('network device input contracts', () => {
  it('accepts a Huawei SNMPv3 device without exposing secret fields in the inventory shape', () => {
    const value = parseNetworkDeviceCreateInput({ name: 'edge-1', host: '192.0.2.10', vendor: 'huawei', snmpv3: snmp });
    expect(value).toMatchObject({ name: 'edge-1', host: '192.0.2.10', snmpPort: 161, sshPort: 22 });
    expect(value.snmpv3.authSecret).toBe('auth-secret');
  });

  it('rejects unsupported vendors and weak SNMPv3 credentials', () => {
    expect(() => parseNetworkDeviceCreateInput({ name: 'x', host: '192.0.2.10', vendor: 'juniper', snmpv3: snmp })).toThrow('NETWORK_DEVICE_VENDOR_UNSUPPORTED');
    expect(() => validateSnmpV3Credential({ username: 'm', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: 'short', privacyProtocol: 'AES', privacySecret: 'long-enough' })).toThrow('SNMPV3_AUTH_SECRET_INVALID');
  });

  it('accepts Cisco devices with SNMPv2c community credentials', () => {
    const value = parseNetworkDeviceCreateInput({ name: 'cisco-edge', host: '192.0.2.11', vendor: 'cisco', snmpv2c: { community: 'readonly' } });
    expect(value.vendor).toBe('cisco');
    expect(value.snmpv2c).toMatchObject({ protocol: 'snmpv2c', community: 'readonly' });
  });

  it.each([
    ['SHA-256', 'AES'],
    ['SHA-512', 'AES'],
    ['SHA', 'AES-192'],
    ['SHA', 'AES-256'],
  ])('rejects SNMP algorithms not supported by the production client (%s/%s)', (authProtocol, privacyProtocol) => {
    expect(() => validateSnmpV3Credential({
      username: 'monitor', securityLevel: 'authPriv', authProtocol, authSecret: 'auth-secret', privacyProtocol, privacySecret: 'privacy-secret',
    } as any)).toThrow(/SNMPV3_(AUTH|PRIVACY)_PROTOCOL_INVALID/);
  });

  it('enforces the 2 MiB backup limit', () => {
    expect(() => validateConfigBackupSize(2 * 1024 * 1024)).not.toThrow();
    expect(() => validateConfigBackupSize(2 * 1024 * 1024 + 1)).toThrow('CONFIG_BACKUP_TOO_LARGE');
  });
});
