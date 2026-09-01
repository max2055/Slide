import type { FastifyInstance } from 'fastify';
import type { ActorContext } from './actor-context.js';
import { requirePermission } from './require-permission.js';
import { authSessionConfigService } from './session-config.js';

type VerifyToken = (request: any, reply: any) => Promise<unknown>;

function validBody(body: unknown): body is { idleTimeoutMinutes: number } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return Object.keys(record).length === 1 && Number.isSafeInteger(record.idleTimeoutMinutes);
}

export async function registerAuthSessionConfigRoutes(
  fastify: FastifyInstance,
  verifyToken: VerifyToken,
): Promise<void> {
  const preHandler = [verifyToken, requirePermission('admin:*')];

  fastify.get('/api/auth/session-config', { preHandler }, async (_request, reply) => {
    return reply.send(await authSessionConfigService.get());
  });

  fastify.put('/api/auth/session-config', { preHandler }, async (request, reply) => {
    if (!validBody(request.body)) {
      return reply.code(400).send({ reasonCode: 'SESSION_CONFIG_UPDATE_INVALID' });
    }
    try {
      const actor = (request as any).user as ActorContext;
      return reply.send(await authSessionConfigService.set(request.body.idleTimeoutMinutes, actor.userId));
    } catch (error) {
      const reasonCode = error instanceof Error ? error.message : 'SESSION_CONFIG_UPDATE_FAILED';
      return reply.code(reasonCode === 'SESSION_CONFIG_UPDATE_INVALID' ? 400 : 500).send({
        reasonCode: reasonCode === 'SESSION_CONFIG_UPDATE_INVALID'
          ? reasonCode
          : 'SESSION_CONFIG_UPDATE_FAILED',
      });
    }
  });
}
