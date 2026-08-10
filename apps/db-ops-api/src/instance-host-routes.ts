import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { Value } from '@sinclair/typebox/value';
import type { ActorContext } from './auth/actor-context.js';
import {
  ErrorResponseSchema,
  HostedInstancesResponseSchema,
  InstanceHostsResponseSchema,
  OkResponseSchema,
  ReplaceInstanceHostsBodySchema,
  ReplaceInstanceHostsResponseSchema,
  type ReplaceInstanceHostsBody,
} from './contracts/public-api.js';
import type {
  HostedInstanceDetail,
  InstanceHostDetail,
  InstanceHostService,
} from './resources/instance-host-service.js';

type InstanceHostRouteService = Pick<
  InstanceHostService,
  'listHosts' | 'replaceHosts' | 'unlinkHost' | 'listInstances'
>;

interface ServerLookup {
  getServerById(id: number): Promise<unknown | null>;
}

export interface InstanceHostRouteDependencies {
  verifyToken: preHandlerHookHandler;
  service: InstanceHostRouteService;
  serverLookup: ServerLookup;
}

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  404: ErrorResponseSchema,
  500: ErrorResponseSchema,
};

function authenticatedActor(request: { user?: ActorContext }): ActorContext {
  if (!request.user) throw new Error('AUTHENTICATION_REQUIRED');
  return request.user;
}

function parsePositiveRouteId(value: unknown): number | null {
  const candidate = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
}

function serializeTemporalRelation<T extends { validFrom: Date }>(
  relation: T,
): Omit<T, 'validFrom'> & { validFrom: string } {
  return { ...relation, validFrom: relation.validFrom.toISOString() };
}

function instanceHostHttpError(error: unknown): { statusCode: 400 | 404 | 500; error: string } {
  const reason = error instanceof Error ? error.message : '';
  switch (reason) {
    case 'RESOURCE_FORBIDDEN':
    case 'INSTANCE_NOT_FOUND':
      return { statusCode: 404, error: reason };
    case 'RESOURCE_REF_INVALID':
    case 'INSTANCE_HOST_PAYLOAD_INVALID':
    case 'INSTANCE_HOST_LIMIT':
    case 'INSTANCE_HOST_DUPLICATE':
    case 'INSTANCE_HOST_ROLE_INVALID':
    case 'INSTANCE_HOST_NOTES_INVALID':
    case 'SERVER_NOT_FOUND':
      return { statusCode: 400, error: reason };
    default:
      return { statusCode: 500, error: 'INSTANCE_HOST_OPERATION_FAILED' };
  }
}

function sendInstanceHostError(reply: any, error: unknown) {
  const failure = instanceHostHttpError(error);
  return reply.code(failure.statusCode).send({ error: failure.error });
}

export async function registerInstanceHostRoutes(
  fastify: FastifyInstance,
  dependencies: InstanceHostRouteDependencies,
): Promise<void> {
  fastify.get('/api/database/instances/:id/hosts', {
    preHandler: [dependencies.verifyToken],
    schema: { response: { 200: InstanceHostsResponseSchema, ...errorResponses } },
  }, async (request, reply) => {
    try {
      const id = parsePositiveRouteId((request.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: 'RESOURCE_REF_INVALID' });
      const hosts = await dependencies.service.listHosts(authenticatedActor(request as any), id);
      return reply.send({ hosts: hosts.map(serializeTemporalRelation) });
    } catch (error) {
      return sendInstanceHostError(reply, error);
    }
  });

  fastify.put('/api/database/instances/:id/hosts', {
    preHandler: [
      dependencies.verifyToken,
      async (request, reply) => {
        if (!Value.Check(ReplaceInstanceHostsBodySchema, request.body)) {
          return reply.code(400).send({ error: 'INSTANCE_HOST_PAYLOAD_INVALID' });
        }
      },
    ],
    schema: {
      response: { 200: ReplaceInstanceHostsResponseSchema, ...errorResponses },
    },
  }, async (request, reply) => {
    try {
      const id = parsePositiveRouteId((request.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: 'RESOURCE_REF_INVALID' });
      const { hosts: mappings } = request.body as ReplaceInstanceHostsBody;
      const hosts = await dependencies.service.replaceHosts(authenticatedActor(request as any), id, mappings);
      return reply.send({ ok: true, hosts: hosts.map(serializeTemporalRelation) });
    } catch (error) {
      return sendInstanceHostError(reply, error);
    }
  });

  fastify.delete('/api/database/instances/:id/hosts/:serverId', {
    preHandler: [dependencies.verifyToken],
    schema: { response: { 200: OkResponseSchema, ...errorResponses } },
  }, async (request, reply) => {
    try {
      const params = request.params as { id: string; serverId: string };
      const id = parsePositiveRouteId(params.id);
      const serverId = parsePositiveRouteId(params.serverId);
      if (id === null || serverId === null) {
        return reply.code(400).send({ error: 'RESOURCE_REF_INVALID' });
      }
      const removed = await dependencies.service.unlinkHost(authenticatedActor(request as any), id, serverId);
      if (!removed) return reply.code(404).send({ error: 'INSTANCE_HOST_RELATION_NOT_FOUND' });
      return reply.send({ ok: true });
    } catch (error) {
      return sendInstanceHostError(reply, error);
    }
  });

  fastify.get('/api/servers/:id/instances', {
    preHandler: [dependencies.verifyToken],
    schema: { response: { 200: HostedInstancesResponseSchema, ...errorResponses } },
  }, async (request, reply) => {
    try {
      const id = parsePositiveRouteId((request.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: 'RESOURCE_REF_INVALID' });
      const actor = authenticatedActor(request as any);
      const instances = await dependencies.service.listInstances(actor, id);
      if (!await dependencies.serverLookup.getServerById(id)) {
        return reply.code(404).send({ error: 'SERVER_NOT_FOUND' });
      }
      return reply.send({ instances: instances.map(serializeTemporalRelation) });
    } catch (error) {
      return sendInstanceHostError(reply, error);
    }
  });
}
