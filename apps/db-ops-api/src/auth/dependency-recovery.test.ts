import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { ActorContextService } from './actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';

describe('live authentication during dependency failure', () => {
  it('rejects database failure as 503 while rejecting an invalid token as 401', async () => {
    const service = new ActorContextService(() => ({ execute: async () => { throw Object.assign(new Error('private connection detail'), { code: 'ECONNREFUSED' }); } }));
    const app = Fastify();
    let businessCalls = 0;
    app.get('/protected', { preHandler: createVerifyToken('test-secret', service) }, async () => { businessCalls++; return { ok: true }; });
    try {
      const token = jwt.sign({ userId: 1, sessionVersion: 1 }, 'test-secret');
      const response = await app.inject({ url: '/protected', headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('private');
      expect(businessCalls).toBe(0);
      expect((await app.inject({ url: '/protected', headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it('does not call a failed refresh transaction an invalid credential', async () => {
    const service = new ActorContextService(() => ({ execute: async () => [], getConnection: async () => { throw new Error('connection unavailable'); } }));
    await expect(service.rotateRefreshToken('refresh')).rejects.toMatchObject({ name: 'PlatformUnavailableError' });
  });
});
