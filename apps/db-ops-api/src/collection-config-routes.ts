import type { FastifyInstance } from 'fastify';
import type { ActorContext } from './auth/actor-context.js';
import { requirePermission } from './auth/require-permission.js';
import { collectionConfigService, type CollectionConfig } from './collection-config.js';

type VerifyToken = (request: any, reply: any) => Promise<unknown>;

function validBody(body: unknown): body is Pick<CollectionConfig, 'serverIntervalSeconds' | 'networkDeviceIntervalSeconds'> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return Object.keys(record).length === 2
    && Number.isSafeInteger(record.serverIntervalSeconds)
    && Number.isSafeInteger(record.networkDeviceIntervalSeconds);
}

export async function registerCollectionConfigRoutes(
  fastify: FastifyInstance,
  verifyToken: VerifyToken,
  applyConfig: (config: CollectionConfig) => void = () => undefined,
): Promise<void> {
  const preHandler = [verifyToken, requirePermission('admin:*')];

  fastify.get('/api/system/collection-config', { preHandler }, async (_request, reply) => {
    return reply.send(await collectionConfigService.get());
  });

  fastify.put('/api/system/collection-config', { preHandler }, async (request, reply) => {
    if (!validBody(request.body)) {
      return reply.code(400).send({ reasonCode: 'COLLECTION_CONFIG_UPDATE_INVALID' });
    }
    try {
      const actor = (request as any).user as ActorContext;
      const config = await collectionConfigService.set(request.body, actor.userId);
      applyConfig(config);
      return reply.send(config);
    } catch (error) {
      const reasonCode = error instanceof Error ? error.message : 'COLLECTION_CONFIG_UPDATE_FAILED';
      return reply.code(reasonCode === 'COLLECTION_CONFIG_UPDATE_INVALID' ? 400 : 500).send({
        reasonCode: reasonCode === 'COLLECTION_CONFIG_UPDATE_INVALID'
          ? reasonCode
          : 'COLLECTION_CONFIG_UPDATE_FAILED',
      });
    }
  });
}
