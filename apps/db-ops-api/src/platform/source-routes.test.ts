import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerSourceRoutes } from './source-routes.js';
describe('source API', () => {
  it('rejects nonadministrators before issuing any credential reference', async () => {
    const app = Fastify(); const service = { load: vi.fn(), save: vi.fn(), sync: vi.fn(), inspect: vi.fn() };
    await registerSourceRoutes(app, async request => { (request as any).user = { userId: 2, permissions: [] }; }, service);
    const result = await app.inject({ method: 'POST', url: '/api/platform/source/sync', payload: { token: 'secret' } });
    expect(result.statusCode).toBe(403); expect(service.sync).not.toHaveBeenCalled(); await app.close();
  });
  it('routes validated source requests without exposing internal errors', async () => {
    const app = Fastify(); const service = { load: vi.fn(async () => null), save: vi.fn(), sync: vi.fn(), inspect: vi.fn(async () => { throw new Error('database secret'); }) };
    await registerSourceRoutes(app, async request => { (request as any).user = { userId: 1, permissions: ['admin:*'] }; }, service);
    expect((await app.inject('/api/platform/source/config')).json()).toEqual({ config: null });
    const result = await app.inject('/api/platform/source/manifest'); expect(result.statusCode).toBe(503); expect(result.body).not.toContain('database');
    await app.close();
  });
});

it('passes source tokens only within the request without credential persistence', async () => {
  const app = Fastify();
  const service = { load: vi.fn(), save: vi.fn(), sync: vi.fn(async () => ({ ok: true })), inspect: vi.fn() };
  await registerSourceRoutes(app, async request => { (request as any).user = { userId: 1, permissions: ['admin:*'] }; }, service);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/platform/source/sync', payload: { token: 'one-use-fixture' } });
    expect(response.statusCode).toBe(200);
    expect(service.sync).toHaveBeenCalledWith(expect.objectContaining({ userId: 1 }), 'one-use-fixture');
  } finally { await app.close(); }
});
