import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllDevices: vi.fn(async () => []),
  getDeviceById: vi.fn(async (id: number) => id === 7 ? { id: 7, name: 'edge-1', host: '192.0.2.10', snmp_port: 161, ssh_port: 22, vendor: 'huawei', status: 'online', collection_enabled: true } : null),
  createDevice: vi.fn(), updateDevice: vi.fn(), deleteDevice: vi.fn(), getCredentials: vi.fn(async () => ({ protocol: 'snmpv3', username: 'monitor', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: 'auth-secret-123', privacyProtocol: 'AES', privacySecret: 'priv-secret-123' })),
  execute: vi.fn(async () => [[]]),
}));

vi.mock('./network-device-database-service.js', () => ({
  networkDeviceDatabaseService: { getAllDevices: mocks.getAllDevices, getDeviceById: mocks.getDeviceById, createDevice: mocks.createDevice, updateDevice: mocks.updateDevice, deleteDevice: mocks.deleteDevice, getCredentials: mocks.getCredentials },
}));
vi.mock('../db-connection.js', () => ({
  dbConnection: { getPool: () => ({ execute: mocks.execute }) },
  encryptData: (value: string) => `cipher:${value}`,
  decryptData: (value: string) => value.replace(/^cipher:/, ''),
}));

import { registerNetworkDeviceRoutes } from './network-device-routes.js';
import { registerHttpSecurity } from '../security/http-security.js';

type Token = 'reader' | 'manager' | 'backup' | 'none';
const actors: Record<Token, any> = {
  reader: { userId: 1, permissions: ['network_devices:view'], instanceScopes: {} },
  manager: { userId: 2, permissions: ['network_devices:view', 'network_devices:manage'], instanceScopes: {} },
  backup: { userId: 3, permissions: ['network_devices:view', 'network_devices:backup'], instanceScopes: {} },
  none: { userId: 4, permissions: [], instanceScopes: {} },
};

async function appWith(dependencies: any = {}): Promise<FastifyInstance> {
  const app = Fastify();
  await registerHttpSecurity(app, { NODE_ENV: 'test' });
  const verifyToken: preHandlerHookHandler = async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/, '') as Token | undefined;
    const user = token ? actors[token] : undefined;
    if (!user) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    (request as any).user = user;
  };
  await registerNetworkDeviceRoutes(app, verifyToken, dependencies);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDeviceById.mockResolvedValue({ id: 7, name: 'edge-1', host: '192.0.2.10', snmp_port: 161, ssh_port: 22, vendor: 'huawei', status: 'online', collection_enabled: true });
});

describe('network-device routes', () => {
  it.each([
    'SSH_TARGET_DENIED', 'SSH_CONNECT_FAILED', 'SSH_COMMAND_FAILED', 'SSH_COMMAND_TIMEOUT',
    'CONFIG_OUTPUT_LIMIT', 'CONFIG_EMPTY', 'CONFIG_BACKUP_STORE_UNAVAILABLE', 'CONFIG_BACKUP_FAILED',
  ])('preserves the public backup failure through HTTP security: %s', async (error) => {
    const app = await appWith({ backupService: { capture: vi.fn(async () => ({ success: false, error })) } });
    const response = await app.inject({
      method: 'POST', url: '/api/network-devices/7/config-backups',
      headers: { authorization: 'Bearer backup' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error });
    await app.close();
  });

  it('continues to hide unexpected backup errors', async () => {
    const app = await appWith({ backupService: { capture: vi.fn(async () => { throw new Error('password=secret'); }) } });
    const response = await app.inject({
      method: 'POST', url: '/api/network-devices/7/config-backups',
      headers: { authorization: 'Bearer backup' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'INTERNAL_ERROR' });
    await app.close();
  });

  it('enforces authentication and view/manage permissions', async () => {
    const app = await appWith();
    expect((await app.inject({ method: 'GET', url: '/api/network-devices' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/network-devices', headers: { authorization: 'Bearer none' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/network-devices', headers: { authorization: 'Bearer reader' } })).statusCode).toBe(200);
    await app.close();
  });

  it('uses view permission for backup metadata and backup permission for capture/raw reads', async () => {
    const backupService = {
      list: vi.fn(async () => [{ id: 9, device_id: 7, version_no: 1, content_sha256: 'a'.repeat(64), source_protocol: 'ssh', collected_at: '2026-01-01T00:00:00.000Z', size_bytes: 10, redaction_status: 'redacted', content_encrypted: 'do-not-return' }]),
      capture: vi.fn(async () => ({ success: true, backup: { id: 9, deviceId: 7, versionNo: 1, contentEncrypted: 'do-not-return', content_encrypted: 'also-do-not-return', preview: '<redacted>', secret: 'do-not-return' }, duplicate: false })),
      get: vi.fn(async (_id: number, _backupId: number, include: boolean) => include ? { id: 9, content: 'secret' } : { id: 9, preview: '<redacted>' }),
      diff: vi.fn(async () => ({ fromId: 9, toId: 10, diff: '+x' })),
      recordAudit: vi.fn(),
    };
    const app = await appWith({ backupService });
    const metadata = await app.inject({ method: 'GET', url: '/api/network-devices/7/config-backups', headers: { authorization: 'Bearer reader' } });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().backups[0]).not.toHaveProperty('content_encrypted');
    const captureDenied = await app.inject({ method: 'POST', url: '/api/network-devices/7/config-backups', headers: { authorization: 'Bearer reader' } });
    expect(captureDenied.statusCode).toBe(403);
    const capture = await app.inject({ method: 'POST', url: '/api/network-devices/7/config-backups', headers: { authorization: 'Bearer backup' } });
    expect(capture.statusCode).toBe(201);
    expect(capture.json()).toMatchObject({ id: 9, preview: '<redacted>' });
    expect(capture.json()).not.toHaveProperty('contentEncrypted');
    expect(capture.json()).not.toHaveProperty('content_encrypted');
    expect(capture.json()).not.toHaveProperty('secret');
    expect(backupService.capture).toHaveBeenCalledWith(7, 3);
    const rawDenied = await app.inject({ method: 'GET', url: '/api/network-devices/7/config-backups/9?raw=true', headers: { authorization: 'Bearer reader' } });
    expect(rawDenied.statusCode).toBe(403);
    expect(backupService.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'read_denied', deviceId: 7, backupId: 9, reason: 'NETWORK_DEVICE_BACKUP_PERMISSION_REQUIRED', actorId: 1 }));
    const raw = await app.inject({ method: 'GET', url: '/api/network-devices/7/config-backups/9?raw=true', headers: { authorization: 'Bearer backup' } });
    expect(raw.statusCode).toBe(200);
    await app.close();
  });

  it.each([
    ['SSH_CREDENTIAL_REQUIRED', 'SSH_CREDENTIAL_REQUIRED'],
    ['SSH_HOST_KEY_FINGERPRINT_REQUIRED', 'SSH_HOST_KEY_FINGERPRINT_REQUIRED'],
  ])('returns an actionable client error when backup setup is incomplete: %s', async (_label, error) => {
    const backupService = {
      capture: vi.fn(async () => ({ success: false, error })),
      list: vi.fn(), get: vi.fn(), diff: vi.fn(),
    };
    const app = await appWith({ backupService });

    const response = await app.inject({
      method: 'POST', url: '/api/network-devices/7/config-backups',
      headers: { authorization: 'Bearer backup' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error });
    await app.close();
  });

  it('rejects unknown test-connection fields and probes only validated SNMPv3 payloads', async () => {
    const probe = vi.fn(async () => ({ reachable: true, observedAt: new Date(), quality: 'good' as const }));
    const sshProbe = vi.fn(async () => undefined);
    const app = await appWith({
      snmpAdapter: { probe },
      sshProbe,
      authorizeTarget: vi.fn(async ({ host, port }: { host: string; port: number }) => ({ hostname: host, address: host, port })),
    });
    const unknown = await app.inject({ method: 'POST', url: '/api/network-devices/test-connection', headers: { authorization: 'Bearer manager', 'content-type': 'application/json' }, payload: { host: '192.0.2.10', snmpv3: { username: 'm', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: '12345678', privacyProtocol: 'AES', privacySecret: '12345678' }, command: 'display current-configuration' } });
    expect(unknown.statusCode).toBe(400);
    const sshWithoutFingerprint = await app.inject({ method: 'POST', url: '/api/network-devices/test-connection', headers: { authorization: 'Bearer manager', 'content-type': 'application/json' }, payload: { host: '192.0.2.10', snmpv3: { username: 'm', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: '12345678', privacyProtocol: 'AES', privacySecret: '12345678' }, ssh: { username: 'readonly', credentialType: 'password', credentialValue: 'secret' } } });
    expect(sshWithoutFingerprint.statusCode).toBe(200);
    expect(sshProbe).toHaveBeenCalledWith(expect.objectContaining({
      host: '192.0.2.10', username: 'readonly', credentialType: 'password',
      hostKeyFingerprint: undefined,
    }));
    const valid = await app.inject({ method: 'POST', url: '/api/network-devices/test-connection', headers: { authorization: 'Bearer manager', 'content-type': 'application/json' }, payload: { host: '192.0.2.10', version: 3, snmpPort: 161, snmpv3: { username: 'm', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: '12345678', privacyProtocol: 'AES', privacySecret: '12345678' } } });
    expect(valid.statusCode).toBe(200);
    expect(probe).toHaveBeenCalledTimes(2);
    const withSsh = await app.inject({ method: 'POST', url: '/api/network-devices/test-connection', headers: { authorization: 'Bearer manager', 'content-type': 'application/json' }, payload: { host: '192.0.2.10', version: 3, snmpPort: 161, sshPort: 22, snmpv3: { username: 'm', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: '12345678', privacyProtocol: 'AES', privacySecret: '12345678' }, ssh: { username: 'readonly', credentialType: 'password', credentialValue: 'secret', hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` } } });
    expect(withSsh.statusCode).toBe(200);
    expect(withSsh.json()).toMatchObject({ success: true, ssh: { verified: true } });
    expect(sshProbe).toHaveBeenCalledWith(expect.objectContaining({ host: '192.0.2.10', port: 22, username: 'readonly', credentialType: 'password', hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` }));
    const v2 = await app.inject({ method: 'POST', url: '/api/network-devices/test-connection', headers: { authorization: 'Bearer manager', 'content-type': 'application/json' }, payload: { host: '192.0.2.10', vendor: 'cisco', version: 2, snmpv2c: { community: 'readonly' } } });
    expect(v2.statusCode).toBe(200);
    expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ version: 2, community: 'readonly' }));
    const snmpProbeCalls = probe.mock.calls.length;
    const sshOnly = await app.inject({ method: 'POST', url: '/api/network-devices/test-connection', headers: { authorization: 'Bearer manager', 'content-type': 'application/json' }, payload: { mode: 'ssh', host: '192.0.2.10', sshPort: 22, ssh: { username: 'readonly', credentialType: 'password', credentialValue: 'secret' } } });
    expect(sshOnly.statusCode).toBe(200);
    expect(sshOnly.json()).toEqual({ success: true, ssh: { verified: true } });
    expect(probe).toHaveBeenCalledTimes(snmpProbeCalls);
    expect(sshProbe).toHaveBeenLastCalledWith(expect.objectContaining({ host: '192.0.2.10', port: 22, username: 'readonly', credentialType: 'password', hostKeyFingerprint: undefined }));
    await app.close();
  });

  it('maps an SSH host-key handshake failure to a stable error without leaking credentials', async () => {
    const app = await appWith({
      snmpAdapter: { probe: vi.fn(async () => ({ reachable: true, observedAt: new Date(), quality: 'good' as const })) },
      sshProbe: vi.fn(async () => { throw new Error('SSH_HOST_KEY_MISMATCH secret-password'); }),
      authorizeTarget: vi.fn(async ({ host, port }: { host: string; port: number }) => ({ hostname: host, address: host, port })),
    });
    const response = await app.inject({ method: 'POST', url: '/api/network-devices/test-connection', headers: { authorization: 'Bearer manager', 'content-type': 'application/json' }, payload: { host: '192.0.2.10', version: 3, snmpv3: { username: 'm', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: '12345678', privacyProtocol: 'AES', privacySecret: '12345678' }, ssh: { username: 'readonly', credentialType: 'password', credentialValue: 'secret-password', hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` } } });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'INTERNAL_ERROR' });
    expect(JSON.stringify(response.json())).not.toContain('secret-password');
    await app.close();
  });

  it('returns stable validation errors for malformed IDs', async () => {
    const app = await appWith();
    const response = await app.inject({ method: 'GET', url: '/api/network-devices/not-an-id/metrics', headers: { authorization: 'Bearer reader' } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('does not create direct database-instance relations from a network device', async () => {
    const app = await appWith();
    const response = await app.inject({
      method: 'PUT', url: '/api/network-devices/7/relations',
      headers: { authorization: 'Bearer manager', 'content-type': 'application/json' },
      payload: { relations: [{ target: { type: 'instance', id: 11 }, relationType: 'serves' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'RESOURCE_RELATION_TOPOLOGY_INVALID' });
    await app.close();
  });
});
