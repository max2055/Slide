import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from '../auth/actor-context.js';
import { InvestigationFeedbackStore } from './feedback.js';
import { InvestigationStoreError } from './store.js';
import { invalidObservation } from './observation-db.js';
import { InvestigationFeedbackPageSchema, InvestigationFeedbackRecordSchema } from './feedback-contracts.js';

/** Dedicated T11 registration port; production composition requires the shared
 * server owner to register it. No execution, knowledge publication or raw reads. */
export async function registerInvestigationFeedbackRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  store = new InvestigationFeedbackStore()): Promise<void> {
  for (const method of ['GET', 'POST'] as const) {
    app.route({ method, url: '/api/investigations/:id/feedback', preHandler: verifyToken, bodyLimit: 64 * 1024,
      schema: { response: { 200: method === 'GET' ? InvestigationFeedbackPageSchema : InvestigationFeedbackRecordSchema } },
      onRequest: async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); },
      handler: async (request, reply) => {
        try {
          const id = (request.params as { id: string }).id;
          const actor = (request as FastifyRequest & { user: ActorContext }).user;
          const query = request.query as Record<string, string>;
          if (method === 'GET') {
            if (Object.keys(query).some(k => !['before', 'limit'].includes(k)) || Object.values(query).some(v => !/^\d+$/.test(v))) throw invalidObservation();
            return await store.list(actor, id, query.before === undefined ? undefined : Number(query.before), query.limit === undefined ? 20 : Number(query.limit));
          }
          if (Object.keys(query).length) throw invalidObservation();
          const key = request.headers['idempotency-key'];
          if (typeof key !== 'string') throw invalidObservation();
          return await store.add(actor, id, key, request.body);
        } catch (error) {
          if (error instanceof InvestigationStoreError) return reply.code(error.statusCode).send({ error: error.code });
          request.log.error({ code: 'INVESTIGATION_QUEUE_UNAVAILABLE', requestId: request.id }, 'Investigation feedback unavailable');
          return reply.code(503).send({ error: 'INVESTIGATION_QUEUE_UNAVAILABLE' });
        }
      } });
  }
}
