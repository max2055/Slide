import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from '../../auth/actor-context.js';
import { OperationsError } from '../contracts.js';
import { BaselineStore } from './store.js';

/** Internal composition export. P10 owns server registration, permissions and
 * generated public contracts; these routes do not activate collection/alerts. */
export async function registerBaselineRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  service: BaselineStore = new BaselineStore()): Promise<void> {
  for (const method of ['POST', 'GET'] as const) app.route({ method,
    url: method === 'POST' ? '/api/operations/baselines' : '/api/operations/baselines/:id',
    preHandler: verifyToken, bodyLimit: 16 * 1024,
    config: { rateLimit: { max: method === 'POST' ? 6 : 60, timeWindow: 60_000 } },
    onRequest: async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); },
    handler: async (request, reply) => {
      const actor = (request as FastifyRequest & { user?: ActorContext }).user;
      if (!actor) return reply.code(401).send({ error: 'UNAUTHORIZED' });
      try {
        if (method === 'POST') await service.compute(actor, request.body, value => { reply.send(value); });
        else await service.read(actor, (request.params as { id: string }).id, value => { reply.send(value); });
        return reply;
      } catch (error) {
        if (reply.sent) return reply;
        if (error instanceof OperationsError) return reply.code(error.statusCode).send({ error: error.code });
        request.log.error({ code: 'OPERATIONS_DEPENDENCY_UNAVAILABLE', requestId: request.id }, 'Baseline HTTP failed');
        return reply.code(503).send({ error: 'OPERATIONS_DEPENDENCY_UNAVAILABLE' });
      }
    } });
}
