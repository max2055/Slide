import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { evidenceEvaluationService } from './evidence-evaluation.js';
import type { ActorContext } from '../auth/actor-context.js';
import type { ResourceRef } from '../resources/types.js';
interface EvaluationApi {
  evaluate(actor: ActorContext, ref: ResourceRef): Promise<unknown>;
  rules(actor: ActorContext, ref: ResourceRef): Promise<unknown>;
  updateRules(actor: ActorContext, ref: ResourceRef, input: unknown): Promise<unknown>;
  recordDecision(actor: ActorContext, ref: ResourceRef, input: unknown): Promise<unknown>;
  decision(actor: ActorContext, ref: ResourceRef, id: string): Promise<unknown>;
  decisions(actor: ActorContext, ref: ResourceRef, limit?: number): Promise<unknown>;
  recovery(actor: ActorContext, ref: ResourceRef, id: string): Promise<unknown>;
  recoveryPolicy(actor: ActorContext, ref: ResourceRef): Promise<unknown>;
  updateRecoveryPolicy(actor: ActorContext, ref: ResourceRef, input: unknown): Promise<unknown>;
}
export async function registerEvidenceEvaluationRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler, service: EvaluationApi = evidenceEvaluationService) {
  const handle = (method: keyof EvaluationApi) => async (request: any, reply: any) => {
    const { type, id, decisionId, operationId } = request.params;
    if (!['instance', 'server', 'network_device'].includes(type) || !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) return reply.code(400).send({ error: 'RESOURCE_REF_INVALID' });
    if (!request.user) return reply.code(401).send({ error: 'ACTOR_REQUIRED' });
    const ref = { type, id: Number(id) } as ResourceRef;
    try {
      const result = method === 'evaluate' || method === 'rules' || method === 'recoveryPolicy' ? await service[method](request.user, ref)
        : method === 'decisions' ? await service.decisions(request.user, ref, request.query.limit === undefined ? undefined : Number(request.query.limit))
          : method === 'decision' ? await service.decision(request.user, ref, decisionId)
          : method === 'recovery' ? await service.recovery(request.user, ref, operationId)
            : await service[method](request.user, ref, request.body);
      return result === null ? reply.code(404).send({ error: 'DECISION_NOT_FOUND' }) : reply.send(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (['RESOURCE_FORBIDDEN', 'RULES_FORBIDDEN', 'RECOVERY_POLICY_FORBIDDEN'].includes(code)) return reply.code(403).send({ error: code });
      if (code === 'RULES_VERSION_CONFLICT' || code === 'RECOVERY_POLICY_VERSION_CONFLICT') return reply.code(409).send({ error: code });
      if (code === 'OPERATION_NOT_FOUND') return reply.code(404).send({ error: code });
      if (/^(RESOURCE|RULES|DECISION|EVIDENCE|OPERATION|RECOVERY)_[A-Z_]*INVALID$/.test(code)) return reply.code(400).send({ error: code });
      return reply.code(503).send({ error: 'EVIDENCE_UNAVAILABLE' });
    }
  };
  const options = { preHandler: [verifyToken], bodyLimit: 65536 };
  app.post('/api/resources/:type/:id/evaluation', options, handle('evaluate'));
  app.get('/api/resources/:type/:id/evaluation', options, handle('evaluate'));
  app.get('/api/resources/:type/:id/invariants', options, handle('rules'));
  app.put('/api/resources/:type/:id/invariants', options, handle('updateRules'));
  app.post('/api/resources/:type/:id/decisions', options, handle('recordDecision'));
  app.get('/api/resources/:type/:id/decisions', options, handle('decisions'));
  app.get('/api/resources/:type/:id/decisions/:decisionId', options, handle('decision'));
  app.get('/api/resources/:type/:id/recovery/:operationId', options, handle('recovery'));
  app.get('/api/resources/:type/:id/recovery-policy', options, handle('recoveryPolicy'));
  app.put('/api/resources/:type/:id/recovery-policy', options, handle('updateRecoveryPolicy'));
}
