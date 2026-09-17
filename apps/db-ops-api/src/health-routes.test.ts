import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVerifyToken } from './auth-middleware.js';
import { registerHealthRoutes } from './health-routes.js';

const snapshot = { status: 'ok', checkedAt: '2026-09-17T00:00:00.000Z', truth: { ready: true }, extra: ['preserved'] };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function setup() {
  const app = Fastify();
  apps.push(app);
  const authenticateAccessToken = vi.fn(async (token: string) => {
    if (token === 'invalid') throw new Error('invalid token');
    return { userId: 2, username: 'reader', roles: [], permissions: token === 'allowed' ? ['config:view'] : [] };
  });
  const checker = { healthOverview: vi.fn().mockResolvedValue(snapshot) };
  registerHealthRoutes(app, createVerifyToken('test-secret', { authenticateAccessToken } as any), checker);
  return { app, checker };
}

describe('health API routes', () => {
  it('serves public health with the original schema without authentication', async () => {
    const { app, checker } = setup();
    const response = await app.inject('/api/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', timestamp: expect.any(String) });
    expect(new Date(response.json().timestamp).toISOString()).toBe(response.json().timestamp);
    expect(checker.healthOverview).not.toHaveBeenCalled();
  });

  for (const route of ['overview', 'consistency', 'readiness']) {
    describe(route, () => {
      for (const token of [undefined, 'invalid', 'denied']) {
        it(`rejects ${token ?? 'missing'} authentication/permission before checking health`, async () => {
          const { app, checker } = setup();
          const response = await app.inject({ url: `/api/health/${route}`, headers: token ? { authorization: `Bearer ${token}` } : {} });
          expect(response.statusCode).toBe(token === 'denied' ? 403 : 401);
          expect(checker.healthOverview).not.toHaveBeenCalled();
        });
      }
      for (const refresh of ['', '?refresh=true', '?refresh=false', '?refresh=TRUE', '?refresh=1']) {
        it(`preserves snapshot projection and strict refresh for ${refresh || 'default'}`, async () => {
          const { app, checker } = setup();
          const response = await app.inject({ url: `/api/health/${route}${refresh}`, headers: { authorization: 'Bearer allowed' } });
          expect(response.statusCode).toBe(200);
          const { truth, ...consistency } = snapshot;
          expect(response.json()).toEqual(route === 'overview' ? snapshot : route === 'readiness' ? truth : consistency);
          expect(checker.healthOverview).toHaveBeenCalledExactlyOnceWith(refresh === '?refresh=true');
        });
      }
      it('preserves the error status and payload', async () => {
        const { app, checker } = setup();
        checker.healthOverview.mockRejectedValueOnce(new Error('snapshot failed'));
        const response = await app.inject({ url: `/api/health/${route}`, headers: { authorization: 'Bearer allowed' } });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: 'snapshot failed' });
      });
    });
  }
});
