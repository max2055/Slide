import { afterEach, describe, expect, it, vi } from 'vitest';
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
  return { execute, getConnection } as any;
}

describe('NetworkDeviceDatabaseService', () => {
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
      .mockResolvedValueOnce([{}, []]);
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

  it('maps duplicate host/port failures to a stable conflict result', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    const execute = vi.fn().mockRejectedValue(duplicate);
    const service = new NetworkDeviceDatabaseService(() => poolFor(execute));
    await expect(service.createDevice({ name: 'edge-1', host: '192.0.2.10', snmpv3: { username: 'm', securityLevel: 'noAuthNoPriv' } }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('已被纳管') });
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
