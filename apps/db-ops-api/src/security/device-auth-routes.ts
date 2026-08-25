import type { FastifyInstance } from 'fastify';
import type { ActorContext } from '../auth/actor-context.js';
import { getDeviceAuthService } from './device-auth-service.js';

export async function registerDeviceAuthRoutes(fastify: FastifyInstance, verifyToken: (request: any, reply: any) => Promise<unknown>): Promise<void> {
  fastify.post('/api/device/register', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const actor = (request as any).user as ActorContext;
      const body = request.body as { deviceId?: unknown; publicKey?: unknown };
      if (typeof body?.deviceId !== 'string' || typeof body.publicKey !== 'string') return reply.code(400).send({ reasonCode: 'DEVICE_AUTH_INPUT_INVALID' });
      return reply.send(await getDeviceAuthService().register(actor, body.deviceId, body.publicKey));
    } catch (error: any) {
      return reply.code(400).send({ reasonCode: error?.message || 'DEVICE_AUTH_INPUT_INVALID' });
    }
  });

  fastify.post('/api/device/challenge', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const actor = (request as any).user as ActorContext;
      const body = request.body as { deviceId?: unknown };
      if (typeof body?.deviceId !== 'string') return reply.code(400).send({ reasonCode: 'DEVICE_AUTH_INPUT_INVALID' });
      return reply.send(await getDeviceAuthService().issueChallenge(actor, body.deviceId));
    } catch (error: any) {
      return reply.code(403).send({ reasonCode: error?.message || 'PAIRING_REQUIRED' });
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
    } catch (error: any) {
      return reply.code(401).send({ reasonCode: error?.message || 'DEVICE_AUTH_INVALID' });
    }
  });
}
