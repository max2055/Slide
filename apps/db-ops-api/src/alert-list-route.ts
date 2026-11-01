import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { alertDatabaseService } from './alert-database-service.js';
import { hasPermission, requirePermission } from './auth/require-permission.js';
import { getAccessibleInstanceIds, hasInstanceAccess } from './auth/require-instance-access.js';
/** Shared production registrar; fixtures exercise the actual JWT/public read path. */
export async function registerAlertListRoute(fastify:FastifyInstance,verifyToken:preHandlerHookHandler){
  fastify.get('/api/alerts', { preHandler: [verifyToken, requirePermission('alert:view')] }, async (request, reply) => {
    try {
      const q = request.query as any;
      const instanceId = q.instance_id === undefined ? undefined : Number(q.instance_id);
      if (instanceId !== undefined && (!Number.isSafeInteger(instanceId) || instanceId <= 0)) {
        return reply.code(400).send({ error: 'instance_id 必须为正整数' });
      }
      if (instanceId !== undefined && !hasInstanceAccess((request as any).user, instanceId, 'read-only')) {
        return reply.code(403).send({ error: '无权访问该实例' });
      }
      const alerts = await alertDatabaseService.getAlerts({
        instance_id: instanceId,
        allowed_instance_ids: getAccessibleInstanceIds((request as any).user),
        allowed_server_ids: hasPermission(new Set((request as any).user?.permissions ?? []), 'servers:view') ? null : [],
        allowed_network_device_ids: hasPermission(new Set((request as any).user?.permissions ?? []), 'network_devices:view') ? null : [],
        limit: q.limit ? parseInt(q.limit) : undefined,
        offset: q.offset ? parseInt(q.offset) : undefined,
        status: q.status || undefined,
        level: q.level || undefined,
        strict: true,
      });
      reply.send(alerts);
    } catch (error: any) {
      reply.code(500).send({ error: '获取告警列表失败：' + error.message });
    }
  });

}
