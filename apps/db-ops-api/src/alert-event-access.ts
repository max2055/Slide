import type { ActorContext } from './auth/actor-context.js';
import { actorContextService } from './auth/actor-context.js';
import { hasInstanceAccess, getAccessibleInstanceIds } from './auth/require-instance-access.js';
import { hasPermission, requirePermission } from './auth/require-permission.js';
import { dbConnection } from './db-connection.js';
import { canReadResource, canManageResource } from './resources/resource-service.js';
import { RefSchema } from './metrics/policy/model.js';
import { alertEventService } from './alert-event-service.js';
import type { RowDataPacket } from 'mysql2/promise';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
export async function eventResourceAccess(actor: ActorContext, event: any, write = false) {
  const pool = dbConnection.getPool();
  if (!pool) return false;
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT payload FROM metric_trigger_episodes WHERE event_id=?',
    [event.id],
  );
  if (rows.length) {
    const r = parse(rows[0].payload).resource;
    const ref = RefSchema.parse({ ...r, id: Number(r.id) });
    return write ? canManageResource(actor, ref) : canReadResource(actor, ref);
  }
  return (
    event.instance_id !== null &&
    hasInstanceAccess(actor, Number(event.instance_id), write ? 'read-write' : 'read-only')
  );
}
export async function requireEventAccess(request: any, reply: any, id: number, level = 'read-only') {
  const actor = await actorContextService.revalidateActor(request.user, request.id);
  const event = await alertEventService.getEventById(id);
  if (!event || !(await eventResourceAccess(actor, event, level === 'read-write'))) {
    reply.code(404).send({ error: '事件未找到' });
    return null;
  }
  return event;
}
async function scope(actor: ActorContext) {
  const pool = dbConnection.getPool();
  if (!pool) throw Error('EVENT_STORE_UNAVAILABLE');
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT event_id,payload FROM metric_trigger_episodes');
  const ids = rows
    .filter((row) => {
      const r = parse(row.payload).resource;
      return canReadResource(actor, RefSchema.parse({ ...r, id: Number(r.id) }));
    })
    .map((row) => Number(row.event_id));
  return { allowed_instance_ids: getAccessibleInstanceIds(actor), allowed_event_ids: ids };
}
/** Same read handlers mounted by production and the isolated browser host. */
export async function registerEventReadRoutes(app: FastifyInstance, verify: preHandlerHookHandler) {
  for (const path of ['', '/stats', '/mttr', '/search', '/:id', '/:id/logs'])
    app.get(
      '/api/alerts/events' + path,
      { preHandler: [verify, requirePermission('alert:view')] },
      async (req: any, reply) => {
        const actor = await actorContextService.revalidateActor(req.user, req.id);
        if (!hasPermission(new Set(actor.permissions), 'alert:view'))
          return reply.code(403).send({ error: 'FORBIDDEN' });
        let result: any;
        if (path.startsWith('/:id')) {
          const event = await requireEventAccess(req, reply, Number(req.params.id));
          if (!event) return;
          result = path.endsWith('/logs') ? await alertEventService.getEventLogs(event.id) : event;
        } else {
          const s = await scope(actor);
          const query = req.query as any;
          const instanceId = query.instance_id === undefined ? undefined : Number(query.instance_id);
          if (instanceId !== undefined && (!Number.isSafeInteger(instanceId) || instanceId <= 0))
            return reply.code(400).send({ error: 'INVALID_INSTANCE' });
          if (instanceId !== undefined && !hasInstanceAccess(actor, instanceId))
            return reply.code(403).send({ error: 'FORBIDDEN' });
          result =
            path === '/stats'
              ? await alertEventService.getEventStats(s.allowed_instance_ids, s.allowed_event_ids)
              : path === '/mttr'
                ? await alertEventService.getMTTRStats(s.allowed_instance_ids, s.allowed_event_ids)
                : path === '/search'
                  ? await alertEventService.searchEvents({ ...query, ...s, instance_id: instanceId })
                  : await alertEventService.getEvents({ ...query, ...s, instance_id: instanceId });
        }
        const final = await actorContextService.revalidateActor(actor, req.id);
        if (
          JSON.stringify(final.permissions) !== JSON.stringify(actor.permissions) ||
          JSON.stringify(final.instanceScopes) !== JSON.stringify(actor.instanceScopes) ||
          JSON.stringify(final.resourceBoundary) !== JSON.stringify(actor.resourceBoundary)
        )
          return reply.code(403).send({ error: 'AUTHORITY_CHANGED' });
        return result;
      },
    );
}
