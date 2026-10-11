import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerSourceRoutes } from './source-routes.js';
describe('source API', () => {
  it('rejects nonadministrators before issuing any credential reference', async () => {
    const app = Fastify(); const service = { credentialStatus: vi.fn(), saveCredential: vi.fn(), deleteCredential: vi.fn(), load: vi.fn(), save: vi.fn(), sync: vi.fn(), inspect: vi.fn() };
    await registerSourceRoutes(app, async request => { (request as any).user = { userId: 2, permissions: [] }; }, service);
    const result = await app.inject({ method: 'POST', url: '/api/platform/source/sync', payload: { token: 'secret' } });
    expect(result.statusCode).toBe(403); expect(service.sync).not.toHaveBeenCalled(); await app.close();
  });
  it('routes validated source requests without exposing internal errors', async () => {
    const app = Fastify(); const service = { credentialStatus: vi.fn(), saveCredential: vi.fn(), deleteCredential: vi.fn(), load: vi.fn(async () => null), save: vi.fn(), sync: vi.fn(), inspect: vi.fn(async () => { throw new Error('database secret'); }) };
    await registerSourceRoutes(app, async request => { (request as any).user = { userId: 1, permissions: ['admin:*'] }; }, service);
    expect((await app.inject('/api/platform/source/config')).json()).toEqual({ config: null });
    const result = await app.inject('/api/platform/source/manifest'); expect(result.statusCode).toBe(503); expect(result.body).not.toContain('database');
    await app.close();
  });
});

it('passes source tokens only within the request without credential persistence', async () => {
  const app = Fastify();
  const service = { credentialStatus: vi.fn(), saveCredential: vi.fn(), deleteCredential: vi.fn(), load: vi.fn(), save: vi.fn(), sync: vi.fn(async () => ({ ok: true } as any)), inspect: vi.fn() };
  await registerSourceRoutes(app, async request => { (request as any).user = { userId: 1, permissions: ['admin:*'] }; }, service);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/platform/source/sync', payload: { token: 'one-use-fixture' } });
    expect(response.statusCode).toBe(200);
    expect(service.sync).toHaveBeenCalledWith(expect.objectContaining({ userId: 1 }), 'one-use-fixture');
  } finally { await app.close(); }
});

it.each([
  ['SOURCE_SIGNING_KEY_INVALID', 503], ['SOURCE_CREDENTIAL_ENCRYPTION_UNAVAILABLE', 503],
  ['SOURCE_CREDENTIAL_INVALID', 400], ['SOURCE_CONFIG_INVALID', 400],
  ['SOURCE_UPSTREAM_FORBIDDEN', 403], ['SOURCE_UPSTREAM_PERMISSION_DENIED', 403],
  ['SOURCE_UPSTREAM_RATE_LIMITED', 429], ['SOURCE_REPOSITORY_NOT_FOUND', 404],
  ['SOURCE_REF_NOT_FOUND', 404], ['SOURCE_SYNC_BUSY', 409],
  ['SOURCE_SNAPSHOT_UNTRUSTED', 409], ['SOURCE_CONFIG_CHANGED', 409],
  ['SOURCE_SECRET_TOKEN', 503], ['Authorization: fixture-secret', 503],
])('returns a safe machine code and HTTP classification for %s', async (code, status) => {
  const app = Fastify();
  const fail = vi.fn(async () => { throw new Error(code); });
  const service = { credentialStatus: fail, saveCredential: fail, deleteCredential: fail, load: fail, save: fail, sync: fail, inspect: fail };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await registerSourceRoutes(app, async request => { (request as any).user = { userId: 1, permissions: ['admin:*'] }; }, service);
  try {
    for (const request of [{ method: 'GET' as const, url: '/api/platform/source/manifest' }, { method: 'POST' as const, url: '/api/platform/source/sync', payload: { token: 'fixture-secret' } }]) {
      const result = await app.inject(request);
      expect(result.statusCode).toBe(status);
      expect(result.json()).toEqual({ error: code.startsWith('SOURCE_SECRET') || code.startsWith('Authorization') ? 'SOURCE_UNAVAILABLE' : code });
      expect(result.body).not.toContain('fixture-secret');
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain('fixture-secret');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SOURCE_SECRET_TOKEN');
  } finally { log.mockRestore(); await app.close(); }
});
