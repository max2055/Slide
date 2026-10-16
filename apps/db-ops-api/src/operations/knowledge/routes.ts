import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from '../../auth/actor-context.js';
import { OperationsError } from '../contracts.js';
import { KnowledgeService } from './service.js';
import type { CaseSearchInput } from './search.js';

/** Internal composition export. P10 owns server registration/public generated
 * contracts. verifyToken must bind the trusted ActorContext on request.user. */
export async function registerKnowledgeRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  service: KnowledgeService): Promise<void> {
  const actorOf = (r: FastifyRequest) => (r as FastifyRequest & { user: ActorContext }).user;
  const idOf = (r: FastifyRequest) => (r.params as { id: string }).id;
  function route(method: 'GET' | 'POST' | 'PUT', url: string,
    handler: (r: FastifyRequest, reply: FastifyReply, actor: ActorContext) => Promise<unknown>) {
    app.route({ method, url, preHandler: verifyToken, bodyLimit: 64 * 1024,
      onRequest: async (_r, reply) => { reply.header('Cache-Control', 'private, no-store'); },
      handler: async (r, reply) => {
        try {
          const actor = actorOf(r);
          if (!actor) return reply.code(401).send({ error: 'UNAUTHORIZED' });
          return await handler(r, reply, actor);
        } catch (error) {
          if (reply.sent) return reply;
          if (error instanceof OperationsError) return reply.code(error.statusCode).send({ error: error.code });
          r.log.error({ code: 'OPERATIONS_DEPENDENCY_UNAVAILABLE', requestId: r.id }, 'Knowledge HTTP failed');
          return reply.code(503).send({ error: 'OPERATIONS_DEPENDENCY_UNAVAILABLE' });
        }
      } });
  }
  route('GET', '/api/operations/knowledge', async (r, reply, actor) => {
    const query = { ...(r.query as Record<string, unknown>) };
    if (query.limit !== undefined) {
      if (typeof query.limit !== 'string' || !/^[1-9]\d?$/.test(query.limit)) throw new OperationsError('OPERATIONS_INPUT_INVALID');
      query.limit = Number(query.limit);
    }
    await service.search(actor, query as CaseSearchInput, page => { reply.send(page); });
    return reply;
  });
  route('GET', '/api/operations/knowledge/:id', async (r, reply, actor) => {
    await service.detail(actor, idOf(r), view => { reply.send(view); });
    return reply;
  });
  route('POST', '/api/operations/knowledge', async (r, reply, actor) => reply.code(201).send(await service.create(actor, r.body)));
  route('PUT', '/api/operations/knowledge/:id', async (r, _reply, actor) => service.revise(actor, idOf(r), r.body));
  route('POST', '/api/operations/knowledge/:id/submit', async (r, _reply, actor) => service.submit(actor, idOf(r), r.body));
  route('POST', '/api/operations/knowledge/:id/review', async (r, _reply, actor) => service.review(actor, idOf(r), r.body));
  route('POST', '/api/operations/knowledge/:id/withdraw', async (r, _reply, actor) => service.withdraw(actor, idOf(r), r.body));
}
