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
    expect(() => parseNetworkDeviceCreateInput({ name: 'x', host: '192.0.2.10', vendor: 'cisco', snmpv3: snmp })).toThrow('NETWORK_DEVICE_VENDOR_UNSUPPORTED');
    expect(() => validateSnmpV3Credential({ username: 'm', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: 'short', privacyProtocol: 'AES', privacySecret: 'long-enough' })).toThrow('SNMPV3_AUTH_SECRET_INVALID');
  });

  it('enforces the 2 MiB backup limit', () => {
    expect(() => validateConfigBackupSize(2 * 1024 * 1024)).not.toThrow();
    expect(() => validateConfigBackupSize(2 * 1024 * 1024 + 1)).toThrow('CONFIG_BACKUP_TOO_LARGE');
  });
});

