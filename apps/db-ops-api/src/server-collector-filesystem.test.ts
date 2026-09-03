import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getServerById: vi.fn(),
  getCollectionEnabledServers: vi.fn(),
  getDecryptedCredentials: vi.fn(),
  updateServerStatus: vi.fn(),
  getConnection: vi.fn(),
  execCommands: vi.fn(),
  releaseConnection: vi.fn(),
  closeConnection: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('./server-database-service', () => ({
  serverDatabaseService: {
    getServerById: mocks.getServerById,
    getCollectionEnabledServers: mocks.getCollectionEnabledServers,
    getDecryptedCredentials: mocks.getDecryptedCredentials,
    updateServerStatus: mocks.updateServerStatus,
  },
}));

vi.mock('./ssh-session-pool', () => ({
  default: {
    getConnection: mocks.getConnection,
    execCommands: mocks.execCommands,
    releaseConnection: mocks.releaseConnection,
    closeConnection: mocks.closeConnection,
    closeAll: vi.fn(),
  },
}));

vi.mock('./db-connection', () => ({
  dbConnection: { getPool: () => ({ execute: mocks.execute }) },
}));

import { buildFilesystemMetricRows, ServerCollector } from './server-collector.js';
import { ServerMetricProvider, isSupportedLinuxOsType } from './server-metric-provider.js';
import { metricRegistry } from './metric-registry.js';

describe('server collector schedule', () => {
  afterEach(() => vi.useRealTimers());

  it('re-arms a running collector when its persisted interval changes', () => {
    vi.useFakeTimers();
    mocks.getCollectionEnabledServers.mockResolvedValue([]);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const collector = new ServerCollector({ collectionIntervalMs: 300_000 });
    collector.start();
    collector.setCollectionIntervalMs(120_000);

    expect(interval).toHaveBeenLastCalledWith(expect.any(Function), 120_000);
    collector.stop();
  });
});

describe('server collector filesystem rows', () => {
  it('persists legacy usage plus byte and inode metrics with filesystem dimensions', () => {
    const rows = buildFilesystemMetricRows(
      `Filesystem 1-blocks Used Available Capacity Mounted on
/dev/mapper/rhel-data 100000 60000 40000 60% /var/lib/mysql`,
      `Filesystem Inodes IUsed IFree IUse% Mounted on
/dev/mapper/rhel-data 1000 250 750 25% /var/lib/mysql`,
      '/dev/mapper/rhel-data /var/lib/mysql xfs',
    );

    expect(rows).toEqual([
      { metricName: 'disk_usage', dimensions: { mount: '/var/lib/mysql', device: '/dev/mapper/rhel-data', fs_type: 'xfs' }, value: 60 },
      { metricName: 'filesystem_size_bytes', dimensions: { mount: '/var/lib/mysql', device: '/dev/mapper/rhel-data', fs_type: 'xfs' }, value: 100000 },
      { metricName: 'filesystem_used_bytes', dimensions: { mount: '/var/lib/mysql', device: '/dev/mapper/rhel-data', fs_type: 'xfs' }, value: 60000 },
      { metricName: 'filesystem_available_bytes', dimensions: { mount: '/var/lib/mysql', device: '/dev/mapper/rhel-data', fs_type: 'xfs' }, value: 40000 },
      { metricName: 'filesystem_inode_usage', dimensions: { mount: '/var/lib/mysql', device: '/dev/mapper/rhel-data', fs_type: 'xfs' }, value: 25 },
    ]);
  });
});

describe('server collector Linux lifecycle', () => {
  const client = {} as any;
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, signal: null, truncated: false });
  const failed = () => ({ stdout: '', stderr: 'unavailable', exitCode: 1, signal: null, truncated: false });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerById.mockResolvedValue({
      id: 9, host: 'db.internal', port: 22, credential_type: 'password',
      host_key_fingerprint: 'SHA256:test', os_type: 'RHEL 8',
    });
    mocks.getDecryptedCredentials.mockResolvedValue({ username: 'ops', password: 'secret' });
    mocks.getConnection.mockResolvedValue(client);
    mocks.updateServerStatus.mockResolvedValue(undefined);
    mocks.execute.mockResolvedValue([{}]);
  });

  it('persists byte and legacy disk rows without an inode row when df -Pi fails', async () => {
    mocks.execCommands.mockImplementation(async (_client: unknown, commands: string[]) => {
      if (commands.length === 1 && commands[0] === 'LC_ALL=C LANG=C uname -s') return [ok('Linux\n')];
      if (commands[0] === 'LC_ALL=C LANG=C df -Pi') {
        return [failed(), ok('/dev/sda1 /var/lib/mysql xfs\n')];
      }
      return commands.map((command) => command === 'LC_ALL=C LANG=C df -P -B1'
        ? ok('Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /var/lib/mysql\n')
        : ok('1\n'));
    });
    const collector = new ServerCollector();

    await expect(collector.collectServer(9)).resolves.toMatchObject({ success: true });

    expect(mocks.execCommands.mock.calls[0][1]).toEqual(['LC_ALL=C LANG=C uname -s']);
    const values = mocks.execute.mock.calls[0][1] as unknown[];
    const metricNames = values.filter((_value, index) => index % 5 === 1);
    expect(metricNames).toEqual(expect.arrayContaining([
      'disk_usage',
      'filesystem_size_bytes',
      'filesystem_used_bytes',
      'filesystem_available_bytes',
    ]));
    expect(metricNames).not.toContain('filesystem_inode_usage');
    const diskIndex = metricNames.indexOf('disk_usage');
    expect(JSON.parse(String(values[diskIndex * 5 + 2]))).toEqual({
      mount: '/var/lib/mysql', device: '/dev/sda1', fs_type: 'xfs',
    });
  });

  it('re-reads stored credentials and recovers on the next collection', async () => {
    mocks.getDecryptedCredentials
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ username: 'ops', password: 'secret' });
    mocks.execCommands.mockImplementation(async (_client: unknown, commands: string[]) => {
      if (commands.length === 1 && commands[0] === 'LC_ALL=C LANG=C uname -s') return [ok('Linux\n')];
      if (commands[0] === 'LC_ALL=C LANG=C df -Pi') {
        return [failed(), ok('/dev/sda1 /var/lib/mysql xfs\n')];
      }
      return commands.map((command) => command === 'LC_ALL=C LANG=C df -P -B1'
        ? ok('Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /var/lib/mysql\n')
        : ok('1\n'));
    });
    const collector = new ServerCollector();

    await expect(collector.collectServer(9)).resolves.toEqual({
      success: false, error: 'SERVER_CREDENTIALS_UNAVAILABLE',
    });
    await expect(collector.collectServer(9)).resolves.toMatchObject({ success: true });

    expect(mocks.getDecryptedCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.getConnection).toHaveBeenCalledTimes(1);
    expect(mocks.updateServerStatus).toHaveBeenLastCalledWith(9, 'online');
  });

  it('serializes concurrent collections for the same server', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.getServerById.mockImplementationOnce(async () => {
      await gate;
      return {
        id: 9, host: 'db.internal', port: 22, credential_type: 'password',
        host_key_fingerprint: 'SHA256:test', os_type: 'RHEL 8',
      };
    });
    mocks.execCommands.mockRejectedValue(new Error('SSH_COMMAND_FAILED'));
    const collector = new ServerCollector();

    const first = collector.collectServer(9);
    await expect(collector.collectServer(9)).resolves.toEqual({ success: false, error: 'COLLECTION_IN_PROGRESS' });
    release();
    await first;

    expect(mocks.getServerById).toHaveBeenCalledTimes(1);
  });

  it.each([
    'SSH_COMMAND_TIMEOUT',
    'SSH_COMMAND_OUTPUT_LIMIT',
    'SSH_COMMAND_PROTOCOL_ERROR',
  ])('closes the SSH connection after fatal error %s', async (code) => {
    mocks.execCommands.mockRejectedValue(new Error(code));
    const collector = new ServerCollector();

    await expect(collector.collectServer(9)).resolves.toEqual({ success: false, error: code });

    expect(mocks.closeConnection).toHaveBeenCalledWith(client);
    expect(mocks.releaseConnection).not.toHaveBeenCalled();
  });

  it('releases the SSH connection after a non-fatal command error', async () => {
    mocks.execCommands.mockRejectedValue(new Error('SSH_COMMAND_FAILED'));
    const collector = new ServerCollector();

    await expect(collector.collectServer(9)).resolves.toEqual({
      success: false, error: 'SSH_COMMAND_FAILED',
    });

    expect(mocks.releaseConnection).toHaveBeenCalledWith(client);
    expect(mocks.closeConnection).not.toHaveBeenCalled();
  });

  it('runs uname first and releases a non-Linux host without any other command or persistence', async () => {
    mocks.execCommands.mockResolvedValue([ok('AIX\n')]);
    const collector = new ServerCollector();

    await expect(collector.collectServer(9)).resolves.toEqual({
      success: false, error: 'HOST_OS_UNSUPPORTED',
    });

    expect(mocks.execCommands).toHaveBeenCalledTimes(1);
    expect(mocks.execCommands.mock.calls[0][1]).toEqual(['LC_ALL=C LANG=C uname -s']);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.releaseConnection).toHaveBeenCalledWith(client);
    expect(mocks.closeConnection).not.toHaveBeenCalled();
  });

  it('rejects an unsupported configured distribution with a stable error before connecting', async () => {
    mocks.getServerById.mockResolvedValueOnce({
      id: 9, host: 'db.internal', port: 22, credential_type: 'password',
      host_key_fingerprint: 'SHA256:test', os_type: 'Ubuntu 22.04',
    });
    const collector = new ServerCollector();

    await expect(collector.collectServer(9)).resolves.toEqual({
      success: false, error: 'HOST_OS_UNSUPPORTED',
    });
    expect(mocks.getDecryptedCredentials).not.toHaveBeenCalled();
    expect(mocks.getConnection).not.toHaveBeenCalled();
  });
});

describe('server metric Linux OS recognition', () => {
  it.each([
    'RHEL 7.9', 'rhel8', 'CentOS Linux 7', 'centos9', 'Kylin V10',
    'Red Hat Enterprise Linux 7', 'Red Hat Enterprise Linux 8.10',
  ])('recognizes supported distro label %s', (osType) => {
    expect(isSupportedLinuxOsType(osType)).toBe(true);
    expect(new ServerMetricProvider().getDefinitions(osType).length).toBeGreaterThan(0);
  });

  it('does not trust arbitrary or unverified OS labels as Linux', () => {
    for (const osType of ['other', 'AIX', 'Ubuntu 22.04', 'Debian 12', 'Rocky Linux 8']) {
      expect(isSupportedLinuxOsType(osType)).toBe(false);
      expect(new ServerMetricProvider().getDefinitions(osType)).toEqual([]);
    }
  });
});

describe('filesystem metric registry', () => {
  it.each([
    ['filesystem_size_bytes', 'bytes'],
    ['filesystem_used_bytes', 'bytes'],
    ['filesystem_available_bytes', 'bytes'],
    ['filesystem_inode_usage', '%'],
  ])('registers %s as a server metric', (metricName, unit) => {
    const definition = metricRegistry.getById(metricName, 'server');
    expect(definition).toMatchObject({ id: metricName, unit, target_type: 'server' });
  });
});
