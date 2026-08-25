import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const cryptoMocks = vi.hoisted(() => ({
  encryptData: vi.fn((value: string) => `cipher:${value}`),
  decryptData: vi.fn((value: string) => value.replace(/^cipher:/, '')),
  dbConnection: { getPool: vi.fn(() => null) },
}));

vi.mock('../db-connection.js', () => cryptoMocks);

import {
  CONFIG_BACKUP_COMMANDS,
  ConfigBackupService,
  type ConfigBackupConnection,
  type ConfigBackupServiceOptions,
  type ConfigBackupStore,
  type ConfigBackupSshTransport,
} from './config-backup-service.js';

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
  it('uses only the fixed read-only Huawei CLI sequence', async () => {
    const active = connection();
    const config = options({}, active);
    const service = new ConfigBackupService(config);
    const result = await service.collect(7, 42);
    expect(active.commands).toEqual([...CONFIG_BACKUP_COMMANDS]);
    expect(active.commands.join('\n')).not.toMatch(/\b(save|undo|system-view)\b/);
    expect(result.summary).toMatchObject({ id: 9, deviceId: 7, sourceProtocol: 'ssh', sizeBytes: Buffer.byteLength(configuration) });
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

  it('fails closed when the host key fingerprint is missing', async () => {
    const active = connection();
    const config = options({ deviceService: { getDeviceById: vi.fn(async () => target), getCredentials: vi.fn(async () => ({ ...credentials, hostKeyFingerprint: '' })) } }, active);
    const service = new ConfigBackupService(config);
    await expect(service.collect(7)).rejects.toMatchObject({ code: 'SSH_HOST_KEY_FINGERPRINT_REQUIRED' });
    expect(active.commands).toEqual([]);
  });

  it('returns encrypted raw content only when the caller explicitly asks for it', async () => {
    const active = connection();
    const saved = { id: 9, deviceId: 7, versionNo: 1, contentEncrypted: `cipher:${configuration}`, contentSha256: createHash('sha256').update(configuration).digest('hex'), sourceProtocol: 'ssh' as const, collectedAt: '2026-01-01T00:00:00.000Z', sizeBytes: Buffer.byteLength(configuration), redactionStatus: 'redacted' as const };
    const config = options({ store: store({ find: vi.fn(async () => saved) }) }, active);
    const service = new ConfigBackupService(config);
    await expect(service.get(7, 9, false)).resolves.toMatchObject({ id: 9, preview: expect.not.stringContaining('SuperSecret') });
    await expect(service.get(7, 9, true)).resolves.toMatchObject({ id: 9, content: configuration });
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
