import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from '../../auth/actor-context.js';
import { OperationsError } from '../contracts.js';
import { AttentionStore } from './store.js';

/** Internal export: P10 owns shared server, permission and migration assembly. */
export async function registerAttentionRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler, service = new AttentionStore()) {
  for (const [method, url, operation] of [
    ['POST', '/api/operations/attention', 'compute'],
    ['GET', '/api/operations/attention/:id', 'read'],
    ['POST', '/api/operations/attention/:id/overrides', 'override'],
  ] as const) app.route({ method, url, preHandler: verifyToken, bodyLimit: 64 * 1024,
    config: { rateLimit: { max: method === 'POST' ? 6 : 60, timeWindow: 60_000 } },
    onRequest: async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); },
    handler: async (request, reply) => {
      const actor = (request as FastifyRequest & { user?: ActorContext }).user;
      if (!actor) return reply.code(401).send({ error: 'UNAUTHORIZED' });
      try {
        const deliver = (value: unknown) => { reply.send(value); };
        const id = (request.params as { id?: string })?.id ?? '';
        if (operation === 'compute') await service.compute(actor, request.body, deliver);
        else if (operation === 'read') await service.read(actor, id, request.query, deliver);
        else await service.override(actor, id, request.body, deliver);
        return reply;
      } catch (error) {
        if (reply.sent) return reply;
        return reply.code(error instanceof OperationsError ? error.statusCode : 503)
          .send({ error: error instanceof OperationsError ? error.code : 'OPERATIONS_DEPENDENCY_UNAVAILABLE' });
      }
    } });
}
