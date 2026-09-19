import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { PolicyError, RefSchema, rule } from '../policy/model.js';
import { metricConsumerService } from './runtime.js';
import { ConsumerAlertPolicySchema, scoreMetrics } from './evaluation.js';
const EvaluateSchema = z.strictObject({ query: z.unknown(), policies: z.array(ConsumerAlertPolicySchema).max(32) });
export async function registerMetricConsumerRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler, service = metricConsumerService) {
  for (const op of ['query', 'discover', 'inventory', 'evaluate'] as const) app.post(`/api/metrics-v2/${op}`, { preHandler: [verifyToken], bodyLimit: 65536 }, async (request, reply) => {
    const actor = (request as unknown as { user?: ActorContext }).user;
    if (!actor) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    try {
      if (op === 'discover') return await service.discover(actor, RefSchema.parse(request.body));
      if (op === 'inventory') return await service.inventory(actor, RefSchema.parse(request.body));
      if (op === 'evaluate') {
        const body = EvaluateSchema.parse(request.body), result = await service.query(actor, body.query);
        rule(body.policies.every(p => result.metrics.some(m => m.definition.id === p.metric_id)), 'UNKNOWN_METRIC');
        return { ...result, assessment: scoreMetrics(result.metrics, body.policies) };
      }
      return await service.query(actor, request.body);
    } catch (e) {
      if (e instanceof PolicyError) return reply.code(e.status).send({ error: e.code });
      if (e instanceof z.ZodError) return reply.code(400).send({ error: 'QUERY_INPUT_INVALID' });
      if (e instanceof Error && e.message === 'QUERY_FORBIDDEN') return reply.code(403).send({ error: e.message });
      if (e instanceof Error && ['QUERY_LIMIT_EXCEEDED', 'QUERY_WINDOW', 'QUERY_SERIES_COUNT'].includes(e.message)) return reply.code(400).send({ error: e.message });
      return reply.code(503).send({ error: 'METRIC_QUERY_UNAVAILABLE' });
    }
  });
}
