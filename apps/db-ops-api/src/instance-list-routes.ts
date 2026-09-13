import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { requirePermission } from './auth/require-permission.js';
import { filterByInstanceAccess } from './auth/require-instance-access.js';
import type { ActorContext } from './auth/actor-context.js';
import { DatabaseInstancesResponseSchema, ErrorResponseSchema } from './contracts/public-api.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { publicInstanceDto } from './security/public-dto.js';

export async function registerInstanceListRoutes(
  app: FastifyInstance,
  verifyToken: preHandlerHookHandler,
  service: Pick<typeof instanceDatabaseService, 'getManagedInstances'> = instanceDatabaseService,
): Promise<void> {
  app.get('/api/database/instances', {
    preHandler: [verifyToken, requirePermission('instance:view')],
    schema: { response: { 200: DatabaseInstancesResponseSchema, 503: ErrorResponseSchema } },
  }, async (request, reply) => {
    try {
      const instances = await service.getManagedInstances();
      const actor = (request as typeof request & { user: ActorContext }).user;
      const visible = filterByInstanceAccess(actor, instances, instance => Number(instance.id));
      return reply.send(visible.map(instance => publicInstanceDto(instance as unknown as Record<string, unknown>)));
    } catch (error) {
      request.log.error({ err: error }, 'Instance enumeration failed');
      return reply.code(503).send({ error: 'INSTANCE_ENUMERATION_UNAVAILABLE' });
    }
  });
}
