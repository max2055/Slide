import { describe, expect, it } from 'vitest';
import { parseNetworkDeviceCreateInput, parseNetworkDeviceUpdateInput, validateConfigBackupSize, validateSnmpV3Credential } from './network-device-types.js';

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

// MAX-602 / #365: every public SNMP spelling has identical create/update semantics.
describe('SNMP create/update compatibility', () => {
  const base = { name: 'switch', host: '192.0.2.10' };
  it.each([
    [{ snmpv2c: { community: 'read' } }, 'snmpv2c'],
    [{ snmpv2: { communityString: 'read' } }, 'snmpv2c'],
    [{ snmp: { version: 2, community: 'read' } }, 'snmpv2c'],
    [{ snmp: { communityString: 'read' } }, 'snmpv2c'],
    [{ version: 2, snmp: { community: 'read' } }, 'snmpv2c'],
    [{ snmpv3: snmp }, 'snmpv3'],
    [{ snmp: { version: 3, ...snmp } }, 'snmpv3'],
    [{ version: 3, snmp }, 'snmpv3'],
  ])('normalizes %j consistently', (input, protocol) => {
    const created = parseNetworkDeviceCreateInput({ ...base, ...input });
    const updated = parseNetworkDeviceUpdateInput(input);
    expect(updated[protocol]).toEqual(created[protocol]);
    expect(updated[protocol]?.protocol).toBe(protocol);
  });
  it.each([
    [{ snmpv2c: { community: 'a' }, snmpv3: snmp }, 'SNMP_CREDENTIAL_CONFLICT'],
    [{ snmpv2c: { community: 'a' }, snmpv2: { community: 'b' } }, 'SNMP_CREDENTIAL_CONFLICT'],
    [{ snmpv3: { ...snmp, community: 'a' } }, 'SNMP_CREDENTIAL_CONFLICT'],
    [{ snmp: { version: 3, community: 'a' } }, 'SNMP_CREDENTIAL_CONFLICT'],
    [{ version: 2, snmpv3: snmp }, 'SNMP_CREDENTIAL_CONFLICT'],
    [{ snmpv2c: { version: 3, community: 'a' } }, 'SNMP_CREDENTIAL_CONFLICT'],
    [{ snmp: { community: 'a', communityString: 'b' } }, 'SNMP_CREDENTIAL_CONFLICT'],
    [{ snmp: { version: 1, community: 'a' } }, 'SNMP_UNSUPPORTED_SECURITY'],
    [{ version: '2', snmp: { community: 'a' } }, 'SNMP_UNSUPPORTED_SECURITY'],
    [{ version: 2 }, 'SNMPV2C_CREDENTIAL_REQUIRED'],
    [{ version: 3 }, 'SNMPV3_CREDENTIAL_REQUIRED'],
    [{ snmpv2c: null }, 'SNMPV2C_CREDENTIAL_REQUIRED'],
    [{ snmpv3: {} }, 'SNMP_USERNAME_REQUIRED'],
    [{ snmp: {} }, 'SNMP_USERNAME_REQUIRED'],
  ])('rejects ambiguous or incomplete credentials %j', (input, error) => {
    for (const parse of [parseNetworkDeviceCreateInput, parseNetworkDeviceUpdateInput]) {
      expect(() => parse({ ...base, ...input })).toThrow(error);
    }
  });
  it('permits omitted credentials for inventory-only creation and metadata-only edits', () => {
    expect(parseNetworkDeviceCreateInput(base).snmpv3).toBeUndefined();
    expect(parseNetworkDeviceUpdateInput({ name: 'renamed' }).snmpv2c).toBeUndefined();
  });
});
