import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ exists: vi.fn(), inventory: vi.fn(), connection: vi.fn(), instance: vi.fn(), password: vi.fn(), transport: vi.fn(), server: vi.fn(), credentials: vi.fn() }));
vi.mock('../../db-connection.js', () => ({ dbConnection: { getPool: () => ({}) } }));
vi.mock('../../database-service.js', () => ({ databaseService: { getConnection: mock.connection } }));
vi.mock('../../instance-database-service.js', () => ({ instanceDatabaseService: { getInstanceById: mock.instance, getInstancePassword: mock.password } }));
vi.mock('../../server-database-service.js', () => ({ serverDatabaseService: { getServerById: mock.server, getDecryptedCredentials: mock.credentials } }));
vi.mock('../../ssh-session-pool.js', () => ({ default: {} }));
vi.mock('../../network-devices/network-device-collector.js', () => ({ MysqlNetworkDeviceCollectionStore: class {}, toSnmpConfig: vi.fn() }));
vi.mock('../../resources/resource-service.js', () => ({ MysqlResourceRelationStore: class { exists = mock.exists; } }));
vi.mock('./inventory.js', () => ({ configurationInventory: mock.inventory }));
vi.mock('./database-transport.js', () => ({ trialDatabaseTransport: mock.transport }));
import { createAssetCollectorAccess } from './access.js';

const ref = { type: 'instance' as const, id: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  mock.exists.mockResolvedValue(true);
  mock.inventory.mockResolvedValue({ type: 'instance', id: '1', attributes: {} });
  mock.instance.mockResolvedValue({ host: 'managed', port: 3306, username: 'reader', db_type: 'mysql', database_name: 'metrics' });
  mock.password.mockResolvedValue('fixture-only');
  mock.connection.mockReturnValue({ connected: true, db_type: 'mysql', config: { host: 'managed', port: 3306, user: 'reader', password: 'fixture-only', database: 'metrics' } });
  mock.transport.mockReturnValue({ method: 'sql', pool: {} });
});
describe('server-owned collector identity', () => {
  it('refuses deleted inventory before resolving a target or credential', async () => {
    mock.exists.mockResolvedValue(false);
    await expect(createAssetCollectorAccess(true).resolve(ref)).rejects.toThrow('permission_denied');
    expect(mock.inventory).not.toHaveBeenCalled(); expect(mock.connection).not.toHaveBeenCalled();
  });
  it('binds transport resolution to exactly the authorized resource and reference', async () => {
    const access = await createAssetCollectorAccess(true).resolve(ref);
    await expect(access.resolve('credential:other', access.resource, 'sql')).rejects.toThrow('COLLECTOR_IDENTITY');
    await expect(access.resolve(access.credential_ref, { ...access.resource, id: '2' }, 'sql')).rejects.toThrow('COLLECTOR_IDENTITY');
    expect(mock.connection).not.toHaveBeenCalled();
    expect(await access.resolve(access.credential_ref, access.resource, 'sql')).toMatchObject({ method: 'sql' });
  });
  it.each(['host', 'password', 'database'])('rejects stale shared connection after %s changes', async field => {
    const access = await createAssetCollectorAccess(true).resolve(ref);
    if (field === 'password') mock.password.mockResolvedValue('rotated-fixture');
    else mock.instance.mockResolvedValue({ host: field === 'host' ? 'other' : 'managed', port: 3306, username: 'reader', db_type: 'mysql', database_name: field === 'database' ? 'other' : 'metrics' });
    await expect(access.resolve(access.credential_ref, access.resource, 'sql')).rejects.toThrow('permission_denied');
    expect(mock.transport).not.toHaveBeenCalled();
  });
  it('rechecks live membership at each transport acquisition', async () => {
    const access = await createAssetCollectorAccess(true).resolve(ref);
    mock.exists.mockResolvedValue(false);
    await expect(access.resolve(access.credential_ref, access.resource, 'sql')).rejects.toThrow('permission_denied');
    expect(mock.transport).not.toHaveBeenCalled();
  });
  it('detects credential rotation after remote IO, before persistence', async () => {
    const access = await createAssetCollectorAccess(true).resolve(ref);
    await access.resolve(access.credential_ref, access.resource, 'sql');
    mock.password.mockResolvedValue('rotated-fixture');
    await expect(access.assertCurrent!()).rejects.toThrow('permission_denied');
  });
});

describe('host production discovery ownership', () => {
  it('retains block continuity only for the same server identity and credential snapshot', async () => {
    mock.inventory.mockResolvedValue({ type: 'server', id: '1', attributes: {} });
    mock.server.mockResolvedValue({ host: 'managed-host', port: 22, credential_type: 'password', host_key_fingerprint: 'fingerprint' });
    mock.credentials.mockResolvedValue({ username: 'reader', password: 'fixture-only' });
    const access = createAssetCollectorAccess(true), server = { type: 'server' as const, id: 1 };
    const first = await access.resolve(server), second = await access.resolve(server);
    expect(first.evidence.host_blocks).toBeDefined();
    expect(second.evidence.host_blocks).toBe(first.evidence.host_blocks);
    mock.credentials.mockResolvedValue({ username: 'reader', password: 'rotated-fixture' });
    expect((await access.resolve(server)).evidence.host_blocks).not.toBe(first.evidence.host_blocks);
    await expect(first.assertCurrent!()).rejects.toThrow('permission_denied');
  });
});
