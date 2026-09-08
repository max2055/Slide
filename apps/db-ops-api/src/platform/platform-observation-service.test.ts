import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { installPlatformObservation } from './platform-observation-service.js';
import { StructuredLogEvidenceAdapter } from './structured-log-evidence-adapter.js';

describe('platform observation runtime hooks', () => {
  it('accepts only bounded authenticated client event types and marks them unverified', async () => {
    const app = Fastify(); const logs = new StructuredLogEvidenceAdapter();
    await installPlatformObservation(app, async request => { (request as any).user = request.headers.authorization ? { userId: 1, permissions: ['config:view'] } : undefined; }, logs);
    expect((await app.inject({ method: 'POST', url: '/api/platform/frontend-events', payload: { eventType: 'runtime.error' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/platform/frontend-events', headers: { authorization: 'user' }, payload: { eventType: 'runtime.error', message: 'private' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/platform/frontend-events', headers: { authorization: 'user' }, payload: { eventType: 'runtime.error', buildId: 'unknown' } })).statusCode).toBe(202);
    expect(logs.query({ component: 'frontend' }).gaps).toContain('LOG_STATUS_UNKNOWN');
    expect(JSON.stringify(logs.query({}))).not.toContain('private');
    await app.close();
  });
  it('records actual responses and protects platform log queries', async () => {
    const app = Fastify(); const logs = new StructuredLogEvidenceAdapter();
    await installPlatformObservation(app, async request => { (request as any).user = { permissions: request.headers.authorization === 'admin' ? ['config:view'] : [] }; }, logs);
    app.get('/failure', async (_request, reply) => reply.code(503).send({ error: 'unavailable' }));
    await app.inject('/failure');
    expect((await app.inject('/api/platform/observations')).statusCode).toBe(403);
    const result = await app.inject({ url: '/api/platform/observations', headers: { authorization: 'admin' } });
    expect(result.statusCode).toBe(200);
    expect(result.json().logs.groups.some((group: any) => group.failures > 0)).toBe(true);
    expect(result.json().components.find((component: any) => component.component === 'collector').quality).toBe('unknown');
    await app.close();
  });
});
