import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerResourceRoutes } from './resource-routes.js';
import type { ActorContext } from '../auth/actor-context.js';
const actor: ActorContext = { userId: 1, username: 'test', roles: [], permissions: ['*'], sessionVersion: 1, instanceScopes: {}, requestId: 'test' };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup(permissions: string[] = ['*']) {
  const app = Fastify(); apps.push(app);
  const result = vi.fn(async () => ({ analysisId: 7, status: 'running', result: null }));
  const diagnose = vi.fn(async () => ({ success: true, analysisId: 7, status: 'queued' }));
  await registerResourceRoutes(app, async request => { (request as any).user = { ...actor, permissions }; }, {} as any, { result, diagnose } as any);
  return { app, result, diagnose };
}
describe('resource-bound analysis routes', () => {
  it.each(['instance', 'server', 'network_device'])('returns actual %s state with the subject forwarded for authorization', async type => {
    const { app, result } = await setup();
    const response = await app.inject(`/api/resources/${type}/2/analyses/7`);
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ status: 'running', result: null });
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ userId: 1 }), { type, id: 2 }, 7);
  });
  it('requires ai:view for results and ai:manage for new analysis', async () => {
    const { app, result } = await setup(['ai:manage']);
    expect((await app.inject('/api/resources/server/2/analyses/7')).statusCode).toBe(403); expect(result).not.toHaveBeenCalled();
    const viewer = await setup(['ai:view']);
    expect((await viewer.app.inject({ method: 'POST', url: '/api/resources/server/2/diagnose-agent' })).statusCode).toBe(403); expect(viewer.diagnose).not.toHaveBeenCalled();
  });
  it('rejects malformed identities and preserves queued HTTP semantics', async () => {
    const { app, result } = await setup();
    expect((await app.inject('/api/resources/server/2/analyses/7x')).statusCode).toBe(400);
    expect((await app.inject('/api/resources/constructor/2/analyses/7')).statusCode).toBe(400); expect(result).not.toHaveBeenCalled();
    const response = await app.inject({ method: 'POST', url: '/api/resources/server/2/diagnose-agent' });
    expect(response.statusCode).toBe(202); expect(response.json().status).toBe('queued');
  });
});
