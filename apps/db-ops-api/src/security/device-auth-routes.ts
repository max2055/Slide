import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ActorContext } from '../auth/actor-context.js';
import { DeviceAuthBusinessError, getDeviceAuthService } from './device-auth-service.js';

import { platformUnavailableResponse } from '../lifecycle/platform-unavailable.js';

function deviceAuthFailure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof DeviceAuthBusinessError) {
    const statuses = { DEVICE_AUTH_INPUT_INVALID: 400, DEVICE_AUTH_PUBLIC_KEY_INVALID: 400, DEVICE_AUTH_REVOKED: 403, PAIRING_REQUIRED: 403 } as const;
    if (Object.hasOwn(statuses, error.reasonCode)) {
      return reply.code(statuses[error.reasonCode]).send({ reasonCode: error.reasonCode });
    }
  }
  // Never serialize the exception, cause, SQL or request payload into diagnostics.
  request.log.error({ reasonCode: 'PLATFORM_UNAVAILABLE' }, 'Device authentication failed');
  return reply.code(503).send(platformUnavailableResponse);
}

export async function registerDeviceAuthRoutes(fastify: FastifyInstance, verifyToken: (request: any, reply: any) => Promise<unknown>): Promise<void> {
  fastify.post('/api/device/register', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const actor = (request as any).user as ActorContext;
      const body = request.body as { deviceId?: unknown; publicKey?: unknown };
      if (typeof body?.deviceId !== 'string' || typeof body.publicKey !== 'string') return reply.code(400).send({ reasonCode: 'DEVICE_AUTH_INPUT_INVALID' });
      return reply.send(await getDeviceAuthService().register(actor, body.deviceId, body.publicKey));
    } catch (error: unknown) {
      return deviceAuthFailure(error, request, reply);
    }
  });

  fastify.post('/api/device/challenge', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const actor = (request as any).user as ActorContext;
      const body = request.body as { deviceId?: unknown };
      if (typeof body?.deviceId !== 'string') return reply.code(400).send({ reasonCode: 'DEVICE_AUTH_INPUT_INVALID' });
      return reply.send(await getDeviceAuthService().issueChallenge(actor, body.deviceId));
    } catch (error: unknown) {
      return deviceAuthFailure(error, request, reply);
    }
  });

  fastify.post('/api/device/session', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const actor = (request as any).user as ActorContext;
      const body = request.body as Record<string, unknown>;
      if (!body || typeof body.deviceId !== 'string' || typeof body.publicKey !== 'string'
        || typeof body.signature !== 'string' || typeof body.nonce !== 'string'
        || typeof body.timestamp !== 'number') {
        return reply.code(400).send({ reasonCode: 'DEVICE_AUTH_INPUT_INVALID' });
      }
      const valid = await getDeviceAuthService().verify(actor, {
        deviceId: body.deviceId,
        publicKey: body.publicKey,
        signature: body.signature,
        nonce: body.nonce,
        timestamp: body.timestamp,
        method: typeof body.method === 'string' ? body.method : 'POST',
        path: typeof body.path === 'string' ? body.path : '/api/device/session',
        body: typeof body.body === 'string' ? body.body : '',
      });
      return valid
        ? reply.send({ authenticated: true, deviceId: body.deviceId })
        : reply.code(401).send({ reasonCode: 'DEVICE_AUTH_SIGNATURE_INVALID' });
    } catch (error: unknown) {
      return deviceAuthFailure(error, request, reply);
    }
  });
}
