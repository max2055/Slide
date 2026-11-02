import { actorContextService } from '../auth/actor-context.js';
import { canReadResource } from '../resources/resource-service.js';
import { RefSchema } from '../metrics/policy/model.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ActorContext } from '../auth/actor-context.js';
import { hasPermission, requirePermission } from '../auth/require-permission.js';
import {
  auditLogManager,
  type AuditEventType,
  type AuditLogManager,
  type AuditLogQuery,
} from './audit-log.js';

type VerifyToken = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const QUERYABLE_EVENT_TYPES = new Set<AuditEventType>([
  'tool_call',
  'approval_request',
  'approval_approved',
  'approval_rejected',
  'approval_expired',
  'login',
  'logout',
  'config_change',
  'user_change',
  'instance_change',
  'config_backup_access',
  'permission_denied',
  'system_operation',
]);

function parseTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 64) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function parseInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : NaN;
}

function requestRoute(request: FastifyRequest): string {
  return request.routeOptions.url || request.url.split('?')[0] || '/api';
}

function resourceFromRequest(request: FastifyRequest, route: string): { resourceType?: string; resourceId?: string } {
  const segments = route.split('/').filter(Boolean);
  const family = segments[0] === 'api' ? segments[1] : segments[0];
  const resourceType = family === 'database' && segments[2] === 'instances' ? 'instance' : family === 'servers' ? 'server' : family === 'network-devices' ? 'network_device' : family;
  const params = request.params as Record<string, unknown> | undefined;
  if (family === 'metrics' && params && ['instance','server','network_device'].includes(String(params.type))
    && /^[1-9]\d*$/.test(String(params.id)) && Number.isSafeInteger(Number(params.id))) {
    return {resourceType:String(params.type),resourceId:String(params.id)};
  }
  const resourceValue = params && Object.values(params).find(value => ['string', 'number'].includes(typeof value));
  return {
    resourceType,
    resourceId: resourceValue === undefined ? undefined : String(resourceValue).slice(0, 255),
  };
}

export async function registerSystemAuditRoutes(
  fastify: FastifyInstance,
  verifyToken: VerifyToken,
  manager: AuditLogManager = auditLogManager,
): Promise<void> {
  fastify.addHook('onResponse', async (request, reply) => {
    if (!MUTATION_METHODS.has(request.method)) return;
    const actor = (request as FastifyRequest & { user?: ActorContext }).user;
    if (!actor) return;

    const route = requestRoute(request);
    if (!route.startsWith('/api/')) return;
    try {
      await manager.logSystemOperation({
        userId: String(actor.userId),
        username: actor.username,
        method: request.method,
        route,
        statusCode: reply.statusCode,
        ...resourceFromRequest(request, route),
        requestId: String(request.id),
        clientIp: request.ip,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
      });
    } catch (error) {
      console.error('[SystemAudit] Failed to persist operation:', error);
    }
  });

  fastify.get('/api/audit/logs', {
    preHandler: [verifyToken, requirePermission('audit:view')],
  }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const eventType = query.eventType;
    const startTime = parseTimestamp(query.startTime);
    const endTime = parseTimestamp(query.endTime);
    const limit = parseInteger(query.limit, 25, 1, 200);
    const offset = parseInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : '';

    if ((eventType !== undefined && (typeof eventType !== 'string' || !QUERYABLE_EVENT_TYPES.has(eventType as AuditEventType)))
      || Number.isNaN(startTime) || Number.isNaN(endTime) || Number.isNaN(limit) || Number.isNaN(offset)
      || keyword.length > 200 || (startTime !== undefined && endTime !== undefined && startTime > endTime)) {
      return reply.code(400).send({ error: '审计查询参数无效' });
    }

    let resource: {type:'instance'|'server'|'network_device';id:number}|null=null;
    if(query.resource!==undefined){
      const match=typeof query.resource==='string'?/^(instance|server|network_device):([1-9]\d*)$/.exec(query.resource):null;
      const parsed=RefSchema.safeParse(match?{type:match[1],id:Number(match[2])}:null);
      if(!parsed.success)return reply.code(400).send({error:'审计资源参数无效'});
      resource=parsed.data;
      const actor=await actorContextService.revalidateActor((request as any).user,request.id);
      if(!hasPermission(new Set(actor.permissions),'audit:view')||!canReadResource(actor,resource))return reply.code(403).send({error:'无权访问该资源审计'});
    }
    const filters: AuditLogQuery = {
      ...(resource?{resourceType:resource.type,resourceId:String(resource.id)}:{}),
      eventType: eventType as AuditEventType | undefined,
      startTime,
      endTime,
      search: keyword || undefined,
      limit,
      offset,
    };
    const result = await manager.query(filters);
    if(resource){const actor=await actorContextService.revalidateActor((request as any).user,request.id);if(!hasPermission(new Set(actor.permissions),'audit:view')||!canReadResource(actor,resource))return reply.code(403).send({error:'无权访问该资源审计'});}
    return reply.send({ items: result.entries, total: result.total, limit, offset });
  });
}
