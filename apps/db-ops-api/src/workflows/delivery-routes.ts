import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { deliveryStore, type MysqlDeliveryStore } from './delivery-store.js';

export function registerDeliveryRoutes(app: FastifyInstance, auth: {
  verifyToken: preHandlerHookHandler;
  requirePermission: (permission: string) => preHandlerHookHandler;
}, store: MysqlDeliveryStore = deliveryStore) {
  app.get('/api/notification/jobs/:id/delivery', {
    preHandler: [auth.verifyToken, auth.requirePermission('notification:view')],
  }, async (request, reply) => {
    try {
      const result = await store.inspect((request.params as { id: string }).id);
      return result ?? reply.code(404).send({ error: 'DELIVERY_NOT_FOUND' });
    } catch { return reply.code(503).send({ error: 'DELIVERY_QUERY_UNAVAILABLE' }); }
  });
  app.post('/api/notification/jobs/:id/recover', {
    preHandler: [auth.verifyToken, auth.requirePermission('admin:*')],
  }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['version', 'decision', 'reason', 'reconciliation', 'acceptDuplicateRisk'].includes(key))) {
      return reply.code(400).send({ error: 'DELIVERY_RECOVERY_INVALID' });
    }
    try {
      return await store.recover((request.params as { id: string }).id, (request as any).user.userId, body as any);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const status = code === 'DELIVERY_RECOVERY_INVALID' ? 400 : code === 'DELIVERY_RECOVERY_CONFLICT' ? 409 : code === 'DELIVERY_NOT_FOUND' ? 404 : 503;
      return reply.code(status).send({ error: status === 503 ? 'DELIVERY_RECOVERY_UNAVAILABLE' : code });
    }
  });
}
