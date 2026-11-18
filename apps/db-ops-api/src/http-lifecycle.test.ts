import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { createVerifyToken } from './auth-middleware.js';
import { registerHealthRoutes } from './health-routes.js';
import { PlatformUnavailableError } from './lifecycle/platform-unavailable.js';

// MAX-684: real sockets and async serialization reproduce the full-entry race.
describe('HTTP reply completion', () => {
  for (const scenario of ['missing', 'empty', 'invalid', 'unavailable']) {
    it('finishes rejection before business handler: ' + scenario, async () => {
      const app = Fastify(); let entered = 0;
      for (let i = 0; i < 2; i++) app.addHook('preSerialization', async (_q, _r, payload) => payload);
      app.addHook('onSend', async (_q, _r, payload) => payload);
      const verify = createVerifyToken('test', { authenticateAccessToken: async () => {
        if (scenario === 'unavailable') throw new PlatformUnavailableError();
        throw new Error('invalid');
      } });
      app.get('/', { preHandler: verify }, async (_q, reply) => { entered++; return reply.code(503).send({ error: 'business' }); });
      try {
        await app.listen({ host: '127.0.0.1', port: 0 });
        const headers = scenario === 'missing' ? {} : { authorization: scenario === 'empty' ? 'Bearer ' : 'Bearer test' };
        const response = await fetch(app.listeningOrigin, { headers });
        await response.json();
        expect(entered).toBe(0);
        expect(response.status).toBe(scenario === 'unavailable' ? 503 : 401);
      } finally { await app.close(); }
    });
  }
  it('returns nonempty liveness JSON with async serialization', async () => {
    const app = Fastify();
    for (let i = 0; i < 2; i++) app.addHook('preSerialization', async (_q, _r, payload) => payload);
    app.addHook('onSend', async (_q, _r, payload) => payload);
    registerHealthRoutes(app, async () => {});
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(app.listeningOrigin + '/api/health');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok', timestamp: expect.any(String) });
    } finally { await app.close(); }
  });
});
