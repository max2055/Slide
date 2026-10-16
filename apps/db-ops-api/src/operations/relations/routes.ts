import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from '../../auth/actor-context.js';
import { OperationsError } from '../contracts.js';
import { RelationService } from './service.js';

/** P10 owns registration and public generated-contract assembly. */
export async function registerRelationRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  service = new RelationService()): Promise<void> {
  const route = (work: (request: FastifyRequest) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    try { return await work(request); }
    catch (error) {
      const known = error instanceof OperationsError;
      return reply.code(known ? error.statusCode : 500).send({ error: known ? error.code : 'OPERATIONS_INTERNAL_ERROR' });
    }
  };
  const actor = (request: FastifyRequest) => (request as FastifyRequest & { user: ActorContext }).user;
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;
  const options = { preHandler: [verifyToken] };
  app.post('/api/operations/relations', options, route(request => service.suggest(actor(request), request.body)));
  app.post('/api/operations/relations/:id/revisions', options, route(request => service.revise(actor(request), id(request), request.body)));
  app.post('/api/operations/relations/:id/review', options, route(request => service.transition(actor(request), id(request), request.body)));
  app.get('/api/operations/relations/:id/revisions', options, route(request => {
    const query = request.query as { before?: string; limit?: string };
    if (Object.keys(query).some(key => !['before', 'limit'].includes(key))) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    return service.history(actor(request), id(request), query.before === undefined ? undefined : Number(query.before),
      query.limit === undefined ? undefined : Number(query.limit));
  }));
  app.get('/api/operations/resources/:type/:id/relations', options, route(request => {
    const params = request.params as { type: string; id: string };
    const query = request.query as { hops?: string; maxEdges?: string; factsOnly?: string };
    if (Object.keys(query).some(key => !['hops', 'maxEdges', 'factsOnly'].includes(key))
      || query.factsOnly !== undefined && !['true', 'false'].includes(query.factsOnly)) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    return service.graph(actor(request), { type: params.type, id: Number(params.id) }, {
      ...(query.hops !== undefined ? { hops: Number(query.hops) } : {}),
      ...(query.maxEdges !== undefined ? { maxEdges: Number(query.maxEdges) } : {}),
      ...(query.factsOnly !== undefined ? { factsOnly: query.factsOnly === 'true' } : {}),
    });
  }));
}
