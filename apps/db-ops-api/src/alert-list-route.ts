import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { alertDatabaseService } from './alert-database-service.js';
import { actorContextService, ActorAuthenticationError, type ActorContext } from './auth/actor-context.js';
import { hasPermission, requirePermission } from './auth/require-permission.js';
import { getAccessibleInstanceIds, hasInstanceAccess } from './auth/require-instance-access.js';
import { dbConnection } from './db-connection.js';
import { PlatformUnavailableError, platformUnavailableResponse } from './lifecycle/platform-unavailable.js';
import { RefSchema } from './metrics/policy/model.js';
import { TemplateBindingError } from './metrics/templates/binding-service.js';
import { templateBindingService } from './metrics/templates/routes.js';

async function attachTemplateEventIds(items: { id: number; template_event_id?: number }[], actor: ActorContext) {
  if (!items.length || !hasPermission(new Set(actor.permissions), 'alert:view')) return;
  const pageByAlertId = new Map(items.map(item => [Number(item.id), item] as const)
    .filter(([id]) => Number.isSafeInteger(id) && id > 0));
  if (!pageByAlertId.size) return;
  const pool = dbConnection.getPool();
  if (!pool) throw new Error('ALERTS_UNAVAILABLE');
  const [episodes] = await pool.query<RowDataPacket[]>(
    "SELECT alert_id, event_id, JSON_EXTRACT(payload, '$.resource') AS resource FROM metric_trigger_episodes WHERE alert_id IN (?)",
    [[...pageByAlertId.keys()]],
  );
  const accessByResource = new Map<string, boolean>();
  for (const episode of episodes) {
    const item = pageByAlertId.get(Number(episode.alert_id));
    const raw = typeof episode.resource === 'string' ? JSON.parse(episode.resource) : episode.resource;
    const ref = RefSchema.safeParse({ type: raw?.type, id: Number(raw?.id) });
    const eventId = Number(episode.event_id);
    if (!item || !ref.success || !Number.isSafeInteger(eventId) || eventId < 1) continue;
    const key = `${ref.data.type}:${ref.data.id}`;
    if (!accessByResource.has(key)) {
      try {
        await templateBindingService.assertAccess(actor, ref.data, false, pool);
        accessByResource.set(key, true);
      } catch (error) {
        if (!(error instanceof TemplateBindingError)
          || (error.code !== 'TEMPLATE_BINDING_FORBIDDEN' && error.code !== 'TEMPLATE_BINDING_RESOURCE_NOT_FOUND')) throw error;
        accessByResource.set(key, false);
      }
    }
    if (accessByResource.get(key)) item.template_event_id = eventId;
  }
}

/** Shared production registrar; fixtures exercise the actual JWT/public read path. */
export async function registerAlertListRoute(fastify:FastifyInstance,verifyToken:preHandlerHookHandler){
  fastify.get('/api/alerts', { preHandler: [verifyToken, requirePermission('alert:view')] }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try {
      const actor = (request as FastifyRequest & { user: ActorContext }).user;
      const permissions = new Set(actor.permissions);
      const q = request.query as any;
      const instanceId = q.instance_id === undefined ? undefined : Number(q.instance_id);
      if (instanceId !== undefined && (!Number.isSafeInteger(instanceId) || instanceId <= 0)) {
        return reply.code(400).send({ error: 'instance_id 必须为正整数' });
      }
      if (instanceId !== undefined && !hasInstanceAccess(actor, instanceId, 'read-only')) {
        return reply.code(403).send({ error: '无权访问该实例' });
      }
      const alerts = await alertDatabaseService.getAlerts({
        instance_id: instanceId,
        allowed_instance_ids: getAccessibleInstanceIds(actor),
        allowed_server_ids: hasPermission(permissions, 'servers:view') ? actor.resourceBoundary?.serverIds ?? null : [],
        allowed_network_device_ids: hasPermission(permissions, 'network_devices:view') ? actor.resourceBoundary?.networkDeviceIds ?? null : [],
        limit: q.limit ? parseInt(q.limit) : undefined,
        offset: q.offset ? parseInt(q.offset) : undefined,
        status: q.status || undefined,
        level: q.level || undefined,
        strict: true,
      });
      await attachTemplateEventIds(alerts.items, actor);
      const live = await actorContextService.revalidateActor(actor, request.id);
      if (JSON.stringify([actor.permissions, actor.roles, actor.instanceScopes, actor.resourceBoundary])
        !== JSON.stringify([live.permissions, live.roles, live.instanceScopes, live.resourceBoundary])) {
        return reply.code(403).send({ error: 'AUTHORITY_CHANGED' });
      }
      return reply.send(alerts);
    } catch (error) {
      if (error instanceof ActorAuthenticationError) return reply.code(401).send({ error: 'UNAUTHORIZED' });
      if (error instanceof PlatformUnavailableError) return reply.code(503).send(platformUnavailableResponse);
      request.log.error({ code: 'ALERTS_QUERY_FAILED', requestId: request.id }, 'Alert list read failed');
      return reply.code(500).send({ error: '获取告警列表失败' });
    }
  });

}
