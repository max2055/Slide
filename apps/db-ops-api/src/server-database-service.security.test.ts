import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintSshHostKey } from './security/ssh-host-key.js';

const mocks = vi.hoisted(() => ({
  authorizeTarget: vi.fn(),
  connectConfigs: [] as any[],
}));

vi.mock('./db-connection', () => ({
  dbConnection: { getPool: vi.fn(() => null), isConnected: vi.fn(() => false) },
  encryptData: vi.fn((value: string) => value),
  decryptData: vi.fn((value: string) => value),
  needsEncryptionMigration: vi.fn(() => false),
}));

vi.mock('./security/server-target-policy', () => ({
  authorizeServerTarget: mocks.authorizeTarget,
}));

vi.mock('ssh2', () => ({
  Client: class {
    private handlers: Record<string, (...args: any[]) => void> = {};
    on(event: string, handler: (...args: any[]) => void) {
      this.handlers[event] = handler;
      return this;
    }
    connect(config: any) {
      mocks.connectConfigs.push(config);
      queueMicrotask(() => this.handlers.ready?.());
    }
    end() {}
  },
}));

import { dbConnection } from './db-connection.js';
import { serverDatabaseService } from './server-database-service.js';

describe('ServerDatabaseService SSH security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectConfigs.length = 0;
    mocks.authorizeTarget.mockResolvedValue({
      hostname: 'ssh.internal.example',
      address: '10.20.30.40',
      port: 22,
    });
  });

  it('connects only to the policy-pinned address and verifies the expected host key', async () => {
    const hostKey = Buffer.from('known-host-key');
    const result = await serverDatabaseService.testConnection(
      'ssh.internal.example',
      22,
      'password',
      'secret',
      'operator',
      fingerprintSshHostKey(hostKey),
    );

    expect(result.success).toBe(true);
    expect(mocks.authorizeTarget).toHaveBeenCalledWith({ host: 'ssh.internal.example', port: 22 });
    expect(mocks.connectConfigs[0]).toMatchObject({ host: '10.20.30.40', port: 22, username: 'operator' });
    expect(mocks.connectConfigs[0].hostVerifier(hostKey)).toBe(true);
    expect(mocks.connectConfigs[0].hostVerifier(Buffer.from('wrong-key'))).toBe(false);
  });

  it('never opens a socket without a valid host key fingerprint', async () => {
    const result = await serverDatabaseService.testConnection(
      'ssh.internal.example', 22, 'password', 'secret', 'operator', '',
    );

    expect(result.success).toBe(false);
    expect(mocks.connectConfigs).toHaveLength(0);
  });

  it('stores a server with a null host-key fingerprint during enrollment', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ insertId: 9 }, []]);
    vi.mocked(dbConnection.getPool).mockReturnValue({ execute } as any);

    const result = await serverDatabaseService.createServer({
      host: 'ssh.internal.example',
      os_type: 'centos',
      credential_type: 'password',
      credential_username: 'operator',
      credential_value: 'secret',
    });

    expect(result).toEqual({ success: true, serverId: 9 });
    expect(execute.mock.calls[1][1]).toEqual([
      'ssh.internal.example', 22, null, 'centos', 'password', expect.any(String), null,
    ]);
  });
});
