import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { OperationsError } from '../contracts.js';
import { registerRelationRoutes } from './routes.js';
import type { RelationService } from './service.js';

describe('relation HTTP disclosure boundary', () => {
  it('preserves controlled error status and hides SQL and source failures', async () => {
    const app = Fastify();
    const suggest = vi.fn().mockRejectedValueOnce(new OperationsError('OPERATIONS_VERSION_CONFLICT'))
      .mockRejectedValueOnce(new Error('SQL password=secret-canary table=hidden-name'));
    await registerRelationRoutes(app, async () => {}, { suggest } as unknown as RelationService);
    try {
      const first = await app.inject({ method: 'POST', url: '/api/operations/relations', payload: {} });
      expect(first.statusCode).toBe(409); expect(first.json()).toEqual({ error: 'OPERATIONS_VERSION_CONFLICT' });
      const second = await app.inject({ method: 'POST', url: '/api/operations/relations', payload: {} });
      expect(second.statusCode).toBe(500); expect(second.json()).toEqual({ error: 'OPERATIONS_INTERNAL_ERROR' });
      expect(second.body).not.toMatch(/canary|password|hidden-name/);
    } finally { await app.close(); }
  });
  it('authenticates every registered endpoint before service calls', async () => {
    const app = Fastify(), suggest = vi.fn();
    await registerRelationRoutes(app, async (_request, reply) => { reply.code(401).send({ error: 'UNAUTHORIZED' }); },
      { suggest } as unknown as RelationService);
    try {
      for (const [method, url] of [
        ['POST', '/api/operations/relations'], ['POST', '/api/operations/relations/1/revisions'],
        ['POST', '/api/operations/relations/1/review'], ['GET', '/api/operations/relations/1/revisions'],
        ['GET', '/api/operations/resources/server/1/relations'],
      ] as const) expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect(suggest).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
