import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOST_KEY_ROTATION_SENTINEL } from '../credential-rotation.js';
import { NetworkDeviceDatabaseService } from './network-device-database-service.js';

const { encryptData, decryptData } = vi.hoisted(() => ({
  encryptData: vi.fn((value: string) => `v2:encrypted:${Buffer.from(value).toString('base64')}`),
  decryptData: vi.fn((value: string) => Buffer.from(value.replace('v2:encrypted:', ''), 'base64').toString()),
}));

vi.mock('../db-connection.js', () => ({
  dbConnection: { getPool: () => null }, encryptData, decryptData, needsEncryptionMigration: () => false,
}));

afterEach(() => vi.clearAllMocks());

function poolFor(execute: ReturnType<typeof vi.fn>, getConnection?: () => any) {
  const connection = { execute, beginTransaction: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
  return { execute, getConnection: getConnection ?? (async () => connection) } as any;
}

describe('NetworkDeviceDatabaseService', () => {
  it.each(['snmpv2c', 'snmpv3', 'ssh'])('MAX-314 refuses a recovered %s credential before protocol use', async (protocol) => {
    const execute = vi.fn().mockResolvedValue([[{ protocol, credential_encrypted: encryptData(LOST_KEY_ROTATION_SENTINEL) }]]);
    const service = new NetworkDeviceDatabaseService(() => poolFor(execute));
    await expect(service.getCredentials(7)).resolves.toBeNull();
  });

  it('uses valid qualified columns for inventory reads', async () => {
    const execute = vi.fn().mockResolvedValueOnce([[
      {
        id: 7,
        name: 'edge-1',
        host: '192.0.2.10',
        vendor: 'huawei',
        snmp_port: 161,
        ssh_port: 22,
        status: 'declared',
        collection_enabled: 1,
        has_snmp_credential: 1,
        has_ssh_credential: 0,
      },
    ], []]);
    const service = new NetworkDeviceDatabaseService(() => poolFor(execute));

    await expect(service.getAllDevices()).resolves.toMatchObject([
      { id: 7, host: '192.0.2.10', vendor: 'huawei', hasSnmpCredential: true },
    ]);
    expect(execute.mock.calls[0][0]).not.toContain('d.d.id');
    expect(execute.mock.calls[0][0]).toContain('SELECT d.id, d.name');
  });

  it('stores SNMPv3 secrets encrypted and returns only a redacted inventory DTO', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{ insertId: 7 }, []])
      .mockResolvedValueOnce([{}, []])
      .mockResolvedValue([{}, []]);
    const service = new NetworkDeviceDatabaseService(() => poolFor(execute));
    const result = await service.createDevice({
      name: 'edge-1', host: '192.0.2.10', vendor: 'huawei',
      snmpv3: { username: 'monitor', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: 'auth-secret', privacyProtocol: 'AES', privacySecret: 'priv-secret' },
    });
    expect(result).toEqual({ success: true, deviceId: 7 });
    expect(encryptData).toHaveBeenCalledWith('auth-secret');
    expect(encryptData).toHaveBeenCalledWith('priv-secret');
    expect(JSON.stringify(execute.mock.calls)).not.toContain('auth-secret');
  });

  it('stores SSH credentials without requiring a host-key fingerprint during enrollment', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{ insertId: 7 }, []])
      .mockResolvedValueOnce([{}, []])
      .mockResolvedValueOnce([{}, []])
      .mockResolvedValue([{}, []]);
    const service = new NetworkDeviceDatabaseService(() => poolFor(execute));

    await expect(service.createDevice({
      name: 'edge-1', host: '192.0.2.10',
      snmpv3: { username: 'monitor', securityLevel: 'noAuthNoPriv' },
      ssh: { credentialType: 'password', username: 'ops', credentialValue: 'secret' },
    })).resolves.toEqual({ success: true, deviceId: 7 });

    const sshInsert = execute.mock.calls.find(([sql]) => String(sql).includes("VALUES (?, 'ssh'"));
    expect(sshInsert?.[1]).toEqual([7, 'password', 'ops', expect.any(String), null, null]);
  });

  it('allows inventory enrollment before SNMP credentials are available', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ insertId: 8 }, []]);
    const service = new NetworkDeviceDatabaseService(() => poolFor(execute));

    await expect(service.createDevice({ name: 'edge-2', host: '192.0.2.11' }))
      .resolves.toEqual({ success: true, deviceId: 8 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('maps duplicate host/port failures to a stable conflict result', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    const execute = vi.fn().mockRejectedValue(duplicate);
    const service = new NetworkDeviceDatabaseService(() => poolFor(execute));
    await expect(service.createDevice({ name: 'edge-1', host: '192.0.2.10', snmpv3: { username: 'm', securityLevel: 'noAuthNoPriv' } }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('已被纳管'), errorCode: 'NETWORK_DEVICE_EXISTS' });
  });

  it('refuses deleting devices that still have active resource relations', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([[{ id: 8 }], []]);
    const rollback = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn();
    const service = new NetworkDeviceDatabaseService(() => poolFor(vi.fn(), () => ({ execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback, release })));
    await expect(service.deleteDevice(7)).resolves.toEqual({ success: false, error: 'NETWORK_DEVICE_HAS_RELATIONS' });
    expect(rollback).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });
});

// MAX-601 / #341: transaction ownership and inactive protocol replacement.
describe('SNMP replacement transaction', () => {
  it.each([
    ['snmpv2c', { community: 'new-community' }, 'snmpv3'],
    ['snmpv3', { username: 'monitor', securityLevel: 'noAuthNoPriv' }, 'snmpv2c'],
  ])('locks the device and replaces only the opposite SNMP protocol for %s', async (key, credential, opposite) => {
    const execute = vi.fn().mockResolvedValue([[{ id: 7 }]]);
    const connection = { execute, beginTransaction: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
    const outside = vi.fn();
    const service = new NetworkDeviceDatabaseService(() => poolFor(outside, async () => connection));
    await expect(service.updateDevice(7, { [key]: credential })).resolves.toEqual({ success: true });
    expect(execute.mock.calls[0][0]).toContain('FOR UPDATE');
    const deletes = execute.mock.calls.filter(([sql]) => String(sql).startsWith('DELETE'));
    expect(deletes).toEqual([[`DELETE FROM network_device_credentials WHERE device_id = ? AND protocol = '${opposite}'`, [7]]]);
    expect(connection.commit).toHaveBeenCalledOnce(); expect(outside).not.toHaveBeenCalled();
  });
  it('rolls back and releases when replacing the inactive protocol fails', async () => {
    const execute = vi.fn().mockResolvedValueOnce([[{ id: 7 }]]).mockResolvedValueOnce([{}]).mockRejectedValueOnce(new Error('injected SQL failure'));
    const connection = { execute, beginTransaction: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
    const service = new NetworkDeviceDatabaseService(() => poolFor(vi.fn(), async () => connection));
    await expect(service.updateDevice(7, { snmpv2c: { community: 'new-community' } })).resolves.toEqual({ success: false, error: 'NETWORK_DEVICE_OPERATION_FAILED' });
    expect(connection.commit).not.toHaveBeenCalled(); expect(connection.rollback).toHaveBeenCalledOnce(); expect(connection.release).toHaveBeenCalledOnce();
  });
  it('default collector lookup excludes SSH credentials', async () => {
    const execute = vi.fn().mockResolvedValue([[]]);
    await new NetworkDeviceDatabaseService(() => poolFor(execute)).getCredentials(7);
    expect(execute.mock.calls[0][0]).toContain("AND protocol IN ('snmpv2c','snmpv3')");
  });
});

// MAX-609 / #552: assert generated SQL preserves null, including snake_case.
describe('nullable network device metadata SQL', () => {
  it.each([{ osVersion: null, serialNumber: null }, { os_version: null, serial_number: null }])('clears both columns for %j', async input => {
    const execute = vi.fn().mockResolvedValue([[{ id: 7 }]]);
    const service = new NetworkDeviceDatabaseService(() => poolFor(execute));
    expect(await service.updateDevice(7, input)).toEqual({ success: true });
    expect(execute.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE network_devices'))).toEqual([
      'UPDATE network_devices SET os_version = ?, serial_number = ? WHERE id = ?', [null, null, 7],
    ]);
  });
});
