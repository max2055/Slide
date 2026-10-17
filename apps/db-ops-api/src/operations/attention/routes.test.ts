import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { registerAttentionRoutes } from './routes.js';
import type { AttentionStore } from './store.js';
import { OperationsError } from '../contracts.js';
describe('attention HTTP authentication and disclosure', () => {
  it('authenticates every endpoint before domain work', async () => {
    const app = Fastify(), compute = vi.fn();
    await registerAttentionRoutes(app, async (_r, reply) => { reply.code(401).send({ error: 'UNAUTHORIZED' }); }, { compute } as unknown as AttentionStore);
    try {
      for (const [method, url] of [['POST', '/api/operations/attention'], ['GET', '/api/operations/attention/id'], ['POST', '/api/operations/attention/id/overrides']] as const)
        expect((await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) })).statusCode).toBe(401);
      expect(compute).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('returns domain codes and masks arbitrary source failures', async () => {
    const app = Fastify(), compute = vi.fn().mockRejectedValueOnce(new OperationsError('OPERATIONS_VERSION_CONFLICT'))
      .mockRejectedValueOnce(new Error('PRIVATE_SQL_CANARY source password hidden'));
    await registerAttentionRoutes(app, async request => { (request as any).user = {}; }, { compute } as unknown as AttentionStore);
    try {
      const conflict = await app.inject({ method: 'POST', url: '/api/operations/attention', payload: {} });
      expect(conflict.statusCode).toBe(409); expect(conflict.json()).toEqual({ error: 'OPERATIONS_VERSION_CONFLICT' });
      const failed = await app.inject({ method: 'POST', url: '/api/operations/attention', payload: {} });
      expect(failed.statusCode).toBe(503); expect(failed.json()).toEqual({ error: 'OPERATIONS_DEPENDENCY_UNAVAILABLE' });
      expect(failed.headers['cache-control']).toBe('private, no-store'); expect(failed.body).not.toMatch(/CANARY|password|hidden/);
    } finally { await app.close(); }
  });
});
