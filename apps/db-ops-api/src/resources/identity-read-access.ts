import type {FastifyReply, FastifyRequest} from 'fastify';
import {actorContextService, ActorAuthenticationError, type ActorContext} from '../auth/actor-context.js';
import {hasPermission} from '../auth/require-permission.js';
import {hasInstanceAccess} from '../auth/require-instance-access.js';
import {canReadResource} from './resource-service.js';
import type {ResourceRef} from './types.js';

export function canReadIdentity(actor: ActorContext, resource: ResourceRef): boolean {
  return resource.type === 'instance' ? hasInstanceAccess(actor, resource.id) : canReadResource(actor, resource);
}

/** Call after the last inventory await, before serialization. Never reuse the preHandler snapshot. */
export async function revalidateIdentityRead(request: FastifyRequest, reply: FastifyReply, type: ResourceRef['type'], id?: number): Promise<ActorContext | null> {
  try {
    const current = await actorContextService.revalidateActor((request as FastifyRequest & {user: ActorContext}).user, request.id);
    const permission = type === 'instance' ? 'instance:view' : type === 'server' ? 'servers:view' : 'network_devices:view';
    if (!hasPermission(new Set(current.permissions), permission) || (id !== undefined && !canReadIdentity(current, {type, id}))) {
      reply.code(403).send({error:'RESOURCE_FORBIDDEN'});
      return null;
    }
    return current;
  } catch (error) {
    if (error instanceof ActorAuthenticationError) reply.code(401).send({error:'AUTHENTICATION_REQUIRED'});
    else reply.code(503).send({error:'PLATFORM_UNAVAILABLE'});
    return null;
  }
}
