import { randomUUID } from 'node:crypto';
import { actorContextService, type ActorContextService } from './auth/actor-context.js';

export function createVerifyToken(
  secret: string,
  actorContexts: Pick<ActorContextService, 'authenticateAccessToken'> = actorContextService,
) {
  return async (request: any, reply: any): Promise<void> => {
    const authorization = request.headers?.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      reply.code(401).send({ error: '未提供认证令牌' });
      return;
    }

    const token = authorization.slice('Bearer '.length).trim();
    if (!token) {
      reply.code(401).send({ error: '未提供认证令牌' });
      return;
    }

    try {
      request.user = await actorContexts.authenticateAccessToken(
        token,
        secret,
        String(request.id || randomUUID()),
      );
    } catch {
      reply.code(401).send({ error: '无效的认证令牌' });
    }
  };
}
