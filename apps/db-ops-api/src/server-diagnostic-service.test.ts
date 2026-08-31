import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerDiagnosticService, diagnosticCommands } from './server-diagnostic-service.js';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, signal: null, truncated: false });

describe('ServerDiagnosticService', () => {
  const client = {} as any;
  let getServerById: ReturnType<typeof vi.fn>;
  let getDecryptedCredentials: ReturnType<typeof vi.fn>;
  let getConnection: ReturnType<typeof vi.fn>;
  let execCommands: ReturnType<typeof vi.fn>;
  let releaseConnection: ReturnType<typeof vi.fn>;
  let closeConnection: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getServerById = vi.fn().mockResolvedValue({
      id: 3, host: 'db.internal', port: 22, os_type: 'RHEL 8',
      credential_type: 'password', host_key_fingerprint: 'SHA256:test',
    });
    getDecryptedCredentials = vi.fn().mockResolvedValue({ username: 'ops', password: 'secret' });
    getConnection = vi.fn().mockResolvedValue(client);
    releaseConnection = vi.fn();
    closeConnection = vi.fn();
    execCommands = vi.fn(async (_client: unknown, commands: string[]) => commands.map((command) => {
      if (command.includes('uname -s')) return ok('Linux\n');
      if (command.includes('systemctl')) return ok('sshd.service loaded active running SSH daemon\n');
      if (command.includes('ss -lntup')) return ok('tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1))\n');
      if (command.includes('ps -eo')) return ok('12 sshd 1.0 0.2\n13 mysqld 55.0 20.0\n');
      if (command.includes('journalctl')) return ok(`${JSON.stringify({ MESSAGE: 'token=secret', PRIORITY: '3', __REALTIME_TIMESTAMP: '1723248000000000' })}\n`);
      if (command.includes('/proc/net/dev')) return ok(' eth0: 100 0 2 3 0 0 0 0 200 0 4 5 0 0 0 0\n');
      return ok();
    }));
  });

  function create(overrides: Record<string, unknown> = {}) {
    return new ServerDiagnosticService({
      serverDatabaseService: { getServerById, getDecryptedCredentials } as any,
      sshSessionPool: { getConnection, execCommands, releaseConnection, closeConnection } as any,
      now: () => new Date('2026-08-26T00:00:00.000Z'),
      ...overrides,
    });
  }

  it('collects only fixed commands and returns bounded five-minute sections', async () => {
    const service = create();
    const result = await service.collectDiagnostics(3);
    expect(execCommands.mock.calls.map((call) => call[1][0])).toEqual(expect.arrayContaining([...diagnosticCommands()].slice(0, 6)));
    expect(result).toMatchObject({
      schemaVersion: 1, serverId: 3, osType: 'rhel',
      collectedAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-26T00:05:00.000Z', validForMs: 300000,
    });
    expect(result.sections.interfaceErrors.items[0]).toMatchObject({ interface: 'eth0', rxErrors: 2, txDrops: 5 });
    expect(result.sections.listeningPorts.items[0]).toMatchObject({ protocol: 'tcp', port: 22 });
    expect(result.recentSystemLogs.items[0].message).not.toContain('secret');
    expect(releaseConnection).toHaveBeenCalledWith(client);
    expect(closeConnection).not.toHaveBeenCalled();
  });

  it('rejects unsupported OS before credentials or network use', async () => {
    getServerById.mockResolvedValue({ id: 3, os_type: 'Ubuntu 22.04' });
    await expect(create().collectDiagnostics(3)).rejects.toThrow('HOST_OS_UNSUPPORTED');
    expect(getDecryptedCredentials).not.toHaveBeenCalled();
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('closes the session after a fatal bounded-command error', async () => {
    execCommands.mockRejectedValue(new Error('SSH_COMMAND_OUTPUT_LIMIT'));
    await expect(create().collectDiagnostics(3)).rejects.toThrow('SSH_COMMAND_OUTPUT_LIMIT');
    expect(closeConnection).toHaveBeenCalledWith(client);
    expect(releaseConnection).not.toHaveBeenCalled();
  });
});
