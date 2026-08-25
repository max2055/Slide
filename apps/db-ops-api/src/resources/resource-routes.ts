import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from '../auth/actor-context.js';
import { resourceDiagnosticService, type ResourceDiagnosticService } from './resource-diagnostic-service.js';
import type { ResourceRef, ResourceType } from './types.js';

const RESOURCE_TYPES = new Set<ResourceType>(['instance', 'server', 'network_device']);

function parseRef(params: Record<string, unknown>): ResourceRef | null {
  const type = params.type;
  const rawId = params.id;
  if (typeof type !== 'string' || !RESOURCE_TYPES.has(type as ResourceType) || typeof rawId !== 'string' || !/^[1-9]\d*$/.test(rawId)) return null;
  const id = Number(rawId);
  return Number.isSafeInteger(id) && id > 0 ? { type: type as ResourceType, id } : null;
}

function actor(request: any): ActorContext {
  return request.user as ActorContext;
}

function errorStatus(error: unknown): number {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'RESOURCE_FORBIDDEN') return 403;
  if (code === 'RESOURCE_NOT_FOUND') return 404;
  if (/INVALID|RANGE|METRIC/.test(code)) return 400;
  return 500;
}

export async function registerResourceRoutes(
  fastify: FastifyInstance,
  verifyToken: preHandlerHookHandler,
  service: ResourceDiagnosticService = resourceDiagnosticService,
): Promise<void> {
  const preHandler = [verifyToken];
  fastify.get('/api/resources', { preHandler }, async (request, reply) => {
    try {
      return reply.send(await service.listResources(actor(request)));
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : 'RESOURCE_LIST_FAILED' });
    }
  });

  fastify.get('/api/resources/:type/:id/observations', { preHandler }, async (request, reply) => {
    const ref = parseRef(request.params as Record<string, unknown>);
    if (!ref) return reply.code(400).send({ error: 'RESOURCE_REF_INVALID' });
    const query = request.query as Record<string, unknown>;
    const metricIds = typeof query.metricIds === 'string' ? query.metricIds.split(',').map((value) => value.trim()).filter(Boolean) : undefined;
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    try {
      return reply.send({ resource: ref, observations: await service.getObservations(actor(request), ref, { metricIds, limit }) });
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : 'RESOURCE_OBSERVATIONS_FAILED' });
    }
  });

  fastify.get('/api/resources/:type/:id/relations', { preHandler }, async (request, reply) => {
    const ref = parseRef(request.params as Record<string, unknown>);
    if (!ref) return reply.code(400).send({ error: 'RESOURCE_REF_INVALID' });
    try {
      return reply.send({ resource: ref, relations: await service.getRelations(actor(request), ref) });
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : 'RESOURCE_RELATIONS_FAILED' });
    }
  });

  fastify.post('/api/resources/:type/:id/diagnose', { preHandler }, async (request, reply) => {
    const ref = parseRef(request.params as Record<string, unknown>);
    if (!ref) return reply.code(400).send({ error: 'RESOURCE_REF_INVALID' });
    try {
      return reply.send(await service.diagnose(actor(request), ref));
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : 'RESOURCE_DIAGNOSIS_FAILED' });
    }
  });
}
