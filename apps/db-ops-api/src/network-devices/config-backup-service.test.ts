import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const cryptoMocks = vi.hoisted(() => ({
  encryptData: vi.fn((value: string) => `cipher:${value}`),
  decryptData: vi.fn((value: string) => value.replace(/^cipher:/, '')),
  dbConnection: { getPool: vi.fn(() => null) },
}));

vi.mock('../db-connection.js', () => cryptoMocks);

import {
  CONFIG_BACKUP_COMMANDS,
  CONFIG_BACKUP_MAX_BYTES,
  ConfigBackupService,
  execOnClient,
  verifySshHostKey,
  type ConfigBackupConnection,
  type ConfigBackupServiceOptions,
  type ConfigBackupStore,
  type ConfigBackupSshTransport,
} from './config-backup-service.js';
import { auditLogManager } from '../audit/audit-log.js';

const target = { id: 7, host: '192.0.2.10', sshPort: 22 };
const fingerprint = `SHA256:${'A'.repeat(43)}`;
const credentials = { protocol: 'ssh' as const, username: 'readonly', credentialType: 'password' as const, credentialValue: 'ssh-secret', hostKeyFingerprint: fingerprint };
const configuration = [
  'sysname edge-1',
  'snmp-agent community read cipher SuperSecret',
  'local-user readonly password irreversible-cipher PasswordSecret',
  'interface GigabitEthernet0/0/1',
  ' description uplink',
].join('\n');

function connection(output = configuration): ConfigBackupConnection & { commands: string[] } {
  const commands: string[] = [];
  return { commands, exec: vi.fn(async (command: string) => { commands.push(command); return { stdout: command === CONFIG_BACKUP_COMMANDS[1] ? output : '', exitCode: 0 }; }), end: vi.fn() };
}

function store(overrides: Partial<ConfigBackupStore> = {}): ConfigBackupStore {
  return {
    list: vi.fn(async () => []),
    find: vi.fn(async () => null),
    insert: vi.fn(async (input) => ({ id: 9, deviceId: input.deviceId, versionNo: 1, contentSha256: input.contentSha256, sourceProtocol: 'ssh' as const, collectedAt: input.collectedAt.toISOString(), sizeBytes: input.sizeBytes, redactionStatus: input.redactionStatus })),
    ...overrides,
  };
}

function options(overrides: Partial<ConfigBackupServiceOptions> = {}, active = connection()): ConfigBackupServiceOptions {
  const transport: ConfigBackupSshTransport = { connect: vi.fn(async () => active) };
  return {
    deviceService: { getDeviceById: vi.fn(async () => target), getCredentials: vi.fn(async () => credentials) },
    store: store(), transport,
    authorizeTarget: vi.fn(async ({ host, port }) => ({ hostname: host, address: host, port } as any)),
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ConfigBackupService', () => {
  it('can verify an SSH host key without executing a device command', async () => {
    const active = connection();
    const transport: ConfigBackupSshTransport = { connect: vi.fn(async () => active) };
    const authorizeTarget = vi.fn(async ({ host, port }: { host: string; port: number }) => ({ hostname: host, address: host, port } as any));
    await verifySshHostKey({
      host: target.host, port: target.sshPort, username: credentials.username,
      credentialType: credentials.credentialType, credentialValue: credentials.credentialValue,
      hostKeyFingerprint: credentials.hostKeyFingerprint,
    }, { transport, authorizeTarget });
    expect(authorizeTarget).toHaveBeenCalledWith({ host: target.host, port: target.sshPort }, expect.any(Object));
    expect(transport.connect).toHaveBeenCalledWith(expect.objectContaining({ hostKeyFingerprint: fingerprint, readyTimeoutMs: 30_000 }));
    expect(active.commands).toEqual([]);
    expect(active.end).toHaveBeenCalledTimes(1);
  });

  it('aborts the SSH channel and connection when stdout/stderr exceed the hard output limit', async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const channel = Object.assign(stdout, {
      stderr,
      destroy: vi.fn(),
      close: vi.fn(),
    });
    const client = {
      exec: vi.fn((_command: string, callback: (error?: Error, channel?: unknown) => void) => callback(undefined, channel)),
      end: vi.fn(),
    };

    const pending = execOnClient(client as any, 'display current-configuration');
    stdout.emit('data', Buffer.alloc(Math.floor(CONFIG_BACKUP_MAX_BYTES / 2), 0x78));
    stderr.emit('data', Buffer.alloc(Math.ceil(CONFIG_BACKUP_MAX_BYTES / 2) + 1, 0x79));

    await expect(pending).rejects.toMatchObject({ code: 'CONFIG_OUTPUT_LIMIT' });
    expect(channel.destroy).toHaveBeenCalledTimes(1);
    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('uses only the fixed read-only Huawei CLI sequence', async () => {
    const active = connection();
    const config = options({}, active);
    const service = new ConfigBackupService(config);
    const result = await service.collect(7, 42);
    expect(active.commands).toEqual([...CONFIG_BACKUP_COMMANDS]);
    expect(active.commands.join('\n')).not.toMatch(/\b(save|undo|system-view)\b/);
    expect(result.summary).toMatchObject({ id: 9, deviceId: 7, sourceProtocol: 'ssh', sizeBytes: Buffer.byteLength(configuration) });
    expect((config.transport!.connect as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({ hostKeyFingerprint: fingerprint }));
    expect(active.end).toHaveBeenCalledTimes(1);
  });

  it('encrypts original content, hashes plaintext, and redacts preview values', async () => {
    const active = connection();
    const config = options({}, active);
    const service = new ConfigBackupService(config);
    const result = await service.collect(7);
    const expectedHash = createHash('sha256').update(configuration).digest('hex');
    expect(cryptoMocks.encryptData).toHaveBeenCalledWith(configuration);
    expect((config.store!.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ contentSha256: expectedHash, createdBy: null });
    expect(result.preview).not.toContain('SuperSecret');
    expect(result.preview).not.toContain('PasswordSecret');
    expect(result.preview).toContain('<redacted>');
  });

  it('maps output truncation to a stable failure and never inserts partial content', async () => {
    const active = connection('x'.repeat(64));
    const config = options({ maxOutputBytes: 32 }, active);
    const service = new ConfigBackupService(config);
    await expect(service.collect(7)).rejects.toMatchObject({ code: 'CONFIG_OUTPUT_LIMIT' });
    expect(config.store!.insert).not.toHaveBeenCalled();
  });

  it('collects without a host-key verifier when the fingerprint is missing', async () => {
    const active = connection();
    const config = options({ deviceService: { getDeviceById: vi.fn(async () => target), getCredentials: vi.fn(async () => ({ ...credentials, hostKeyFingerprint: '' })) } }, active);
    const service = new ConfigBackupService(config);
    await expect(service.collect(7)).resolves.toMatchObject({ summary: { deviceId: 7 } });
    expect((config.transport!.connect as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ hostKeyFingerprint: undefined }),
    );
    expect(active.commands).toEqual([...CONFIG_BACKUP_COMMANDS]);
  });

  it('rejects a malformed non-empty host-key fingerprint', async () => {
    const active = connection();
    const config = options({ deviceService: { getDeviceById: vi.fn(async () => target), getCredentials: vi.fn(async () => ({ ...credentials, hostKeyFingerprint: 'SHA256:invalid' })) } }, active);
    const service = new ConfigBackupService(config);

    await expect(service.collect(7)).rejects.toMatchObject({ code: 'SSH_HOST_KEY_FINGERPRINT_REQUIRED' });
    expect(config.transport!.connect).not.toHaveBeenCalled();
    expect(active.commands).toEqual([]);
  });

  it('authorizes the destination before reading credentials and pins the resolved address', async () => {
    const active = connection();
    const order: string[] = [];
    const getCredentials = vi.fn(async () => { order.push('credentials'); return credentials; });
    const authorizeTarget = vi.fn(async () => { order.push('authorize'); return { hostname: target.host, address: '10.20.30.40', port: 2222 }; });
    const config = options({
      deviceService: { getDeviceById: vi.fn(async () => target), getCredentials },
      authorizeTarget,
    }, active);
    const service = new ConfigBackupService(config);
    await service.collect(7);
    expect(order).toEqual(['authorize', 'credentials']);
    expect((config.transport!.connect as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ address: '10.20.30.40', port: 2222 }),
    }));
  });

  it('accepts the snake_case target shape returned by the database service', async () => {
    const active = connection();
    const authorizeTarget = vi.fn(async ({ host, port }) => ({ hostname: host, address: '10.20.30.40', port }));
    const config = options({
      deviceService: {
        getDeviceById: vi.fn(async () => ({ id: 7, host: target.host, ssh_port: target.sshPort } as any)),
        getCredentials: vi.fn(async () => credentials),
      },
      authorizeTarget,
    }, active);
    await new ConfigBackupService(config).collect(7);
    expect(authorizeTarget).toHaveBeenCalledWith({ host: target.host, port: 22 }, expect.anything());
  });

  it('does not read credentials when the destination policy denies the target', async () => {
    const getCredentials = vi.fn(async () => credentials);
    const config = options({
      deviceService: { getDeviceById: vi.fn(async () => target), getCredentials },
      authorizeTarget: vi.fn(async () => { throw new Error('SNMP_TARGET_ADDRESS_DENIED'); }),
    });
    const service = new ConfigBackupService(config);
    await expect(service.collect(7)).rejects.toMatchObject({ code: 'SSH_TARGET_DENIED' });
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it('returns encrypted raw content only when the caller explicitly asks for it', async () => {
    const active = connection();
    const saved = { id: 9, deviceId: 7, versionNo: 1, contentEncrypted: `cipher:${configuration}`, contentSha256: createHash('sha256').update(configuration).digest('hex'), sourceProtocol: 'ssh' as const, collectedAt: '2026-01-01T00:00:00.000Z', sizeBytes: Buffer.byteLength(configuration), redactionStatus: 'redacted' as const };
    const config = options({ store: store({ find: vi.fn(async () => saved) }) }, active);
    const service = new ConfigBackupService(config);
    await expect(service.get(7, 9, false)).resolves.toMatchObject({ id: 9, preview: expect.not.stringContaining('SuperSecret') });
    await expect(service.get(7, 9, true)).resolves.toMatchObject({ id: 9, content: configuration });
  });

  it('uses the default redacted audit sink for raw reads', async () => {
    const saved = { id: 9, deviceId: 7, versionNo: 1, contentEncrypted: `cipher:${configuration}`, contentSha256: 'a'.repeat(64), sourceProtocol: 'ssh' as const, collectedAt: '2026-01-01T00:00:00.000Z', sizeBytes: Buffer.byteLength(configuration), redactionStatus: 'redacted' as const };
    const config = options({ store: store({ find: vi.fn(async () => saved) }) });
    const audit = vi.spyOn(auditLogManager, 'logConfigBackupAccess').mockResolvedValue();
    try {
      await expect(new ConfigBackupService(config).get(7, 9, true, 42)).resolves.toMatchObject({ content: configuration });
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'read_raw', deviceId: 7, backupId: 9, contentSha256: 'a'.repeat(64), sizeBytes: Buffer.byteLength(configuration), userId: '42' }));
      expect(JSON.stringify(audit.mock.calls[0]?.[0])).not.toContain('SuperSecret');
      expect(JSON.stringify(audit.mock.calls[0]?.[0])).not.toContain('ssh-secret');
    } finally {
      audit.mockRestore();
    }
  });

  it('keeps diff output bounded and redacted', async () => {
    const left = { id: 9, deviceId: 7, versionNo: 1, contentEncrypted: `cipher:${configuration}`, contentSha256: 'a'.repeat(64), sourceProtocol: 'ssh' as const, collectedAt: '2026-01-01T00:00:00.000Z', sizeBytes: 10, redactionStatus: 'redacted' as const };
    const right = { ...left, id: 10, versionNo: 2, contentEncrypted: `cipher:${configuration.replace('uplink', 'backup')}`, contentSha256: 'b'.repeat(64) };
    const config = options({ store: store({ find: vi.fn(async (_device, id) => id === 9 ? left : right) }) });
    const service = new ConfigBackupService(config);
    const result = await service.diff(7, 9, 10);
    expect(result.diff).toContain('backup');
    expect(result.diff).not.toContain('SuperSecret');
  });
});


describe('vendor backup and failure stages', () => {
  it('uses Cisco commands and stores only the running configuration', async () => {
    const active = connection();
    active.exec = vi.fn(async (command) => {
      active.commands.push(command);
      if (command === 'terminal length 0') return { stdout: 'paging disabled', exitCode: 0 };
      if (command === 'show running-config') return { stdout: 'hostname switch-1\nusername admin secret 5 hidden', exitCode: 0 };
      return { stdout: 'Syntax error', exitCode: 16 };
    });
    const config = options({ deviceService: { getDeviceById: vi.fn(async () => ({ ...target, vendor: 'cisco' })), getCredentials: vi.fn(async () => credentials) } }, active);
    const result = await new ConfigBackupService(config).collect(7);
    expect(active.commands).toEqual(['terminal length 0', 'show running-config']);
    expect(result.preview).toContain('hostname switch-1');
    expect(result.preview).not.toContain('hidden');
    expect(result.preview).not.toContain('paging disabled');
  });
  it.each(['device', 'credentials', 'store'])('does not disguise %s failures as command errors', async (stage) => {
    const config = options();
    const error = new Error('private internal failure');
    if (stage === 'device') (config.deviceService!.getDeviceById as any).mockRejectedValue(error);
    if (stage === 'credentials') (config.deviceService!.getCredentials as any).mockRejectedValue(error);
    if (stage === 'store') (config.store!.insert as any).mockRejectedValue(error);
    await expect(new ConfigBackupService(config).collect(7)).rejects.toMatchObject({ code: stage === 'credentials' ? 'SSH_CREDENTIAL_READ_FAILED' : 'CONFIG_BACKUP_STORE_UNAVAILABLE' });
  });
});
