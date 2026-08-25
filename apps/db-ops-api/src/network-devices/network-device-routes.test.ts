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

type Token = 'reader' | 'manager' | 'backup' | 'none';
const actors: Record<Token, any> = {
  reader: { userId: 1, permissions: ['network_devices:view'], instanceScopes: {} },
  manager: { userId: 2, permissions: ['network_devices:view', 'network_devices:manage'], instanceScopes: {} },
  backup: { userId: 3, permissions: ['network_devices:view', 'network_devices:backup'], instanceScopes: {} },
  none: { userId: 4, permissions: [], instanceScopes: {} },
};

async function appWith(dependencies: any = {}): Promise<FastifyInstance> {
  const app = Fastify();
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
  it('enforces authentication and view/manage permissions', async () => {
    const app = await appWith();
    expect((await app.inject({ method: 'GET', url: '/api/network-devices' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/network-devices', headers: { authorization: 'Bearer none' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/network-devices', headers: { authorization: 'Bearer reader' } })).statusCode).toBe(200);
    await app.close();
  });

  it('uses view permission for backup metadata and backup permission for capture/raw reads', async () => {
    const backupService = {
      list: vi.fn(async () => [{ id: 9, deviceId: 7, versionNo: 1, contentSha256: 'a'.repeat(64), sourceProtocol: 'ssh', collectedAt: '2026-01-01T00:00:00.000Z', sizeBytes: 10, redactionStatus: 'redacted' }]),
      capture: vi.fn(async () => ({ success: true, backup: { id: 9, deviceId: 7, versionNo: 1 }, duplicate: false })),
      get: vi.fn(async (_id: number, _backupId: number, include: boolean) => include ? { id: 9, content: 'secret' } : { id: 9, preview: '<redacted>' }),
      diff: vi.fn(async () => ({ fromId: 9, toId: 10, diff: '+x' })),
    };
    const app = await appWith({ backupService });
    const metadata = await app.inject({ method: 'GET', url: '/api/network-devices/7/config-backups', headers: { authorization: 'Bearer reader' } });
    expect(metadata.statusCode).toBe(200);
    const captureDenied = await app.inject({ method: 'POST', url: '/api/network-devices/7/config-backups', headers: { authorization: 'Bearer reader' } });
    expect(captureDenied.statusCode).toBe(403);
    const capture = await app.inject({ method: 'POST', url: '/api/network-devices/7/config-backups', headers: { authorization: 'Bearer backup' } });
    expect(capture.statusCode).toBe(201);
    expect(backupService.capture).toHaveBeenCalledWith(7, 3);
    const rawDenied = await app.inject({ method: 'GET', url: '/api/network-devices/7/config-backups/9?raw=true', headers: { authorization: 'Bearer reader' } });
    expect(rawDenied.statusCode).toBe(403);
    const raw = await app.inject({ method: 'GET', url: '/api/network-devices/7/config-backups/9?raw=true', headers: { authorization: 'Bearer backup' } });
    expect(raw.statusCode).toBe(200);
    await app.close();
  });

  it('rejects unknown test-connection fields and probes only validated SNMPv3 payloads', async () => {
    const probe = vi.fn(async () => ({ reachable: true, observedAt: new Date(), quality: 'good' as const }));
    const app = await appWith({
      snmpAdapter: { probe },
      authorizeTarget: vi.fn(async ({ host, port }: { host: string; port: number }) => ({ hostname: host, address: host, port })),
    });
    const unknown = await app.inject({ method: 'POST', url: '/api/network-devices/test-connection', headers: { authorization: 'Bearer manager', 'content-type': 'application/json' }, payload: { host: '192.0.2.10', snmpv3: { username: 'm', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: '12345678', privacyProtocol: 'AES', privacySecret: '12345678' }, command: 'display current-configuration' } });
    expect(unknown.statusCode).toBe(400);
    const valid = await app.inject({ method: 'POST', url: '/api/network-devices/test-connection', headers: { authorization: 'Bearer manager', 'content-type': 'application/json' }, payload: { host: '192.0.2.10', version: 3, snmpPort: 161, snmpv3: { username: 'm', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: '12345678', privacyProtocol: 'AES', privacySecret: '12345678' } } });
    expect(valid.statusCode).toBe(200);
    expect(probe).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('returns stable validation errors for malformed IDs', async () => {
    const app = await appWith();
    const response = await app.inject({ method: 'GET', url: '/api/network-devices/not-an-id/metrics', headers: { authorization: 'Bearer reader' } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
