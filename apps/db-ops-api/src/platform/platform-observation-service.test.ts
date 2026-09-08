import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { installPlatformObservation } from './platform-observation-service.js';
import { StructuredLogEvidenceAdapter } from './structured-log-evidence-adapter.js';

describe('platform observation runtime hooks', () => {
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
