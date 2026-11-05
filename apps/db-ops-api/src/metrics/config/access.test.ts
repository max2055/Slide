import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ exists: vi.fn(), inventory: vi.fn(), connection: vi.fn(), instance: vi.fn(), password: vi.fn(), transport: vi.fn(), assetEnabled: vi.fn(), server: vi.fn(), credentials: vi.fn(), sshConnect: vi.fn(), sshExec: vi.fn(), sshRelease: vi.fn(), sshClose: vi.fn() }));
vi.mock('../../db-connection.js', () => ({ dbConnection: { getPool: () => ({execute: mock.assetEnabled}) } }));
vi.mock('../../database-service.js', () => ({ databaseService: { getConnection: mock.connection } }));
vi.mock('../../instance-database-service.js', () => ({ instanceDatabaseService: { getInstanceById: mock.instance, getInstancePassword: mock.password } }));
vi.mock('../../server-database-service.js', () => ({ serverDatabaseService: { getServerById: mock.server, getDecryptedCredentials: mock.credentials } }));
vi.mock('../../ssh-session-pool.js', () => ({ default: { getConnection: mock.sshConnect, execCommands: mock.sshExec, releaseConnection: mock.sshRelease, closeConnection: mock.sshClose } }));
vi.mock('../../network-devices/network-device-collector.js', () => ({ MysqlNetworkDeviceCollectionStore: class {}, toSnmpConfig: vi.fn() }));
vi.mock('../../resources/resource-service.js', () => ({ MysqlResourceRelationStore: class { exists = mock.exists; } }));
vi.mock('./inventory.js', () => ({ configurationInventory: mock.inventory }));
vi.mock('./database-transport.js', () => ({ trialDatabaseTransport: mock.transport }));
import { createAssetCollectorAccess } from './access.js';
import type { Transport } from '../packages/adapters.js';

const ref = { type: 'instance' as const, id: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  mock.assetEnabled.mockResolvedValue([[{enabled:1}],[]]);
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

describe('trial host discovery ownership', () => {
  it('supplies host lifecycle evidence from its own cache without the production enable check', async () => {
    mock.inventory.mockResolvedValue({ type: 'server', id: '1', attributes: {} });
    mock.server.mockResolvedValue({ host: 'managed-host', port: 22, credential_type: 'password', host_key_fingerprint: 'fingerprint' });
    mock.credentials.mockResolvedValue({ username: 'reader', password: 'fixture-only' });
    const trial = createAssetCollectorAccess(), production = createAssetCollectorAccess(true), server = { type: 'server' as const, id: 1 };
    const first = await trial.resolve(server), second = await trial.resolve(server), collected = await production.resolve(server);
    expect(first.evidence.host_blocks).toBeDefined();
    expect(first.evidence.host_interfaces).toBeDefined();
    expect(second.evidence.host_blocks).toBe(first.evidence.host_blocks);
    expect(first.evidence.host_blocks).not.toBe(collected.evidence.host_blocks);
    expect(first.evidence.host_interfaces).not.toBe(collected.evidence.host_interfaces);
    expect(mock.assetEnabled).toHaveBeenCalledTimes(1);
  });
});

describe('SSH collector identity snapshot', () => {
  const serverRef = { type: 'server' as const, id: 1 };
  type FixtureServer = { host: string; port: number; credential_type: string; host_key_fingerprint: string; credential_encrypted: string };
  type FixtureSecret = { username: string; password?: string; privateKey?: string };
  const approvedServer: FixtureServer = { host: '192.0.2.1', port: 22, credential_type: 'password', host_key_fingerprint: 'SHA256:approved', credential_encrypted: 'blob-approved' };
  const approvedSecret: FixtureSecret = { username: 'reader', password: 'fixture-only' };
  const client = () => ({ once: vi.fn(), removeListener: vi.fn(), destroy: vi.fn() });
  function stage(server: FixtureServer, secret: FixtureSecret) {
    mock.inventory.mockResolvedValue({ type: 'server', id: '1', attributes: {} });
    mock.server.mockResolvedValue(server);
    mock.credentials.mockResolvedValue(secret);
    mock.sshConnect.mockResolvedValue(client());
    mock.sshExec.mockResolvedValue([{ stdout: '', stderr: '', exitCode: 0, truncated: false }]);
  }
  function sshTransport(transport: Transport): Extract<Transport, { method: 'ssh' }> {
    if (transport.method !== 'ssh') throw new Error('expected ssh transport');
    return transport;
  }
  async function run(transport: Transport) {
    const ssh = sshTransport(transport);
    return ssh.pool.execCommands(ssh.client, ['true'], { timeoutMs: 1000 });
  }
  async function open(server: FixtureServer = approvedServer, secret: FixtureSecret = approvedSecret) {
    stage(server, secret);
    const factory = createAssetCollectorAccess(true);
    const access = await factory.resolve(serverRef);
    const transport = sshTransport(await access.resolve(access.credential_ref, access.resource, 'ssh'));
    return { factory, access, transport };
  }
  it('connects with the validated host, port, account, credential type, fingerprint, and credential', async () => {
    const { access, transport } = await open();
    await run(transport);
    expect(mock.sshConnect).toHaveBeenCalledTimes(1);
    expect(mock.sshConnect).toHaveBeenCalledWith('192.0.2.1', 22, 'reader', 'password', 'fixture-only', 'SHA256:approved');
    expect(mock.sshRelease).toHaveBeenCalledTimes(1);
    expect(access.evidence.host_blocks).toBeDefined();
  });
  it('uses the private key from the same snapshot when the credential type is key', async () => {
    const { transport } = await open(
      { host: '192.0.2.1', port: 22, credential_type: 'key', host_key_fingerprint: 'SHA256:approved', credential_encrypted: 'blob-key' },
      { username: 'reader', privateKey: 'fixture-key' },
    );
    await run(transport);
    expect(mock.sshConnect).toHaveBeenCalledWith('192.0.2.1', 22, 'reader', 'key', 'fixture-key', 'SHA256:approved');
  });
  const changes: Array<[string, FixtureServer, FixtureSecret]> = [
    ['target', { host: '192.0.2.2', port: 2222, credential_type: 'password', host_key_fingerprint: 'SHA256:approved', credential_encrypted: 'blob-next' }, approvedSecret],
    ['fingerprint', { ...approvedServer, host_key_fingerprint: 'SHA256:replaced', credential_encrypted: 'blob-next' }, approvedSecret],
    ['credential', approvedServer, { username: 'reader', password: 'rotated-fixture' }],
    ['account', { ...approvedServer, credential_encrypted: 'blob-next' }, { username: 'other', password: 'fixture-only' }],
    ['credential type', { ...approvedServer, credential_type: 'key', credential_encrypted: 'blob-next' }, { username: 'reader', privateKey: 'fixture-key' }],
  ];
  it.each(changes)('rejects a %s change after validation and does not connect', async (_label, server, secret) => {
    const { factory, access, transport } = await open();
    const baseline = access.evidence.host_blocks;
    mock.server.mockResolvedValue(server);
    mock.credentials.mockResolvedValue(secret);
    await expect(run(transport)).rejects.toThrow('permission_denied');
    expect(mock.sshConnect).not.toHaveBeenCalled();
    const fresh = await factory.resolve(serverRef);
    expect(fresh.evidence.host_blocks).not.toBe(baseline);
    await run(await fresh.resolve(fresh.credential_ref, fresh.resource, 'ssh'));
    expect(mock.sshConnect).toHaveBeenCalledTimes(1);
    expect(mock.sshConnect).toHaveBeenCalledWith(server.host, server.port, secret.username, server.credential_type, secret.password ?? secret.privateKey, server.host_key_fingerprint);
  });
  it('rejects a reproducible race that changes the target between the two reads used to connect', async () => {
    const { factory, access, transport } = await open();
    const baseline = access.evidence.host_blocks;
    let serverReads = 0;
    mock.server.mockImplementation(async () => {
      serverReads += 1;
      return serverReads === 1 ? approvedServer : { host: '192.0.2.2', port: 2222, credential_type: 'password', host_key_fingerprint: 'SHA256:approved', credential_encrypted: 'blob-next' };
    });
    mock.credentials.mockResolvedValue({ username: 'reader', password: 'other-fixture' });
    await expect(run(transport)).rejects.toThrow('permission_denied');
    expect(mock.sshConnect).not.toHaveBeenCalled();
    expect(serverReads).toBeGreaterThanOrEqual(2);
    mock.server.mockResolvedValue({ host: '192.0.2.2', port: 2222, credential_type: 'password', host_key_fingerprint: 'SHA256:approved', credential_encrypted: 'blob-next' });
    const fresh = await factory.resolve(serverRef);
    expect(fresh.evidence.host_blocks).not.toBe(baseline);
    await run(await fresh.resolve(fresh.credential_ref, fresh.resource, 'ssh'));
    expect(mock.sshConnect).toHaveBeenCalledWith('192.0.2.2', 2222, 'reader', 'password', 'other-fixture', 'SHA256:approved');
  });
});
