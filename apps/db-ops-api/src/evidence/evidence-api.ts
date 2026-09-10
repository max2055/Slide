import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from '../auth/actor-context.js';
import type { ResourceRef } from '../resources/types.js';
import { evidenceService } from './evidence-service.js';

interface EvidenceReader {
  getBundle(actor: ActorContext, ref: ResourceRef, options?: { from?: string; to?: string; limit?: number; correlationId?: string }): Promise<unknown>;
  getItem(actor: ActorContext, ref: ResourceRef, id: string): Promise<unknown>;
}

export async function registerEvidenceRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler, service: EvidenceReader = evidenceService) {
  const handle = (single: boolean) => async (request: any, reply: any) => {
    const { type, id, evidenceId } = request.params;
    if (!['instance', 'server', 'network_device'].includes(type) || !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) return reply.code(400).send({ error: 'RESOURCE_REF_INVALID' });
    if (!request.user) return reply.code(401).send({ error: 'ACTOR_REQUIRED' });
    const query = request.query as Record<string, string>;
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) return reply.code(400).send({ error: 'EVIDENCE_LIMIT_INVALID' });
    if ((query.from !== undefined && !Number.isFinite(Date.parse(query.from))) || (query.to !== undefined && !Number.isFinite(Date.parse(query.to))) || (query.correlationId?.length ?? 0) > 128) return reply.code(400).send({ error: 'EVIDENCE_QUERY_INVALID' });
    const ref = { type, id: Number(id) } as ResourceRef;
    try {
      if (single) {
        if (!/^[a-f0-9]{64}$/.test(evidenceId)) return reply.code(400).send({ error: 'EVIDENCE_ID_INVALID' });
        const item = await service.getItem(request.user, ref, evidenceId);
        return item ? reply.send(item) : reply.code(404).send({ error: 'EVIDENCE_NOT_FOUND' });
      }
      return reply.send(await service.getBundle(request.user, ref, { from: query.from, to: query.to, correlationId: query.correlationId, limit }));
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'RESOURCE_FORBIDDEN') return reply.code(403).send({ error: code });
      if (code === 'RESOURCE_NOT_FOUND') return reply.code(404).send({ error: code });
      if (/^EVIDENCE_[A-Z_]*(INVALID|RANGE)$/.test(code)) return reply.code(400).send({ error: code });
      return reply.code(503).send({ error: 'EVIDENCE_UNAVAILABLE' });
    }
  };
  app.get('/api/resources/:type/:id/evidence', { preHandler: [verifyToken] }, handle(false));
  app.get('/api/resources/:type/:id/evidence/:evidenceId', { preHandler: [verifyToken] }, handle(true));
}
