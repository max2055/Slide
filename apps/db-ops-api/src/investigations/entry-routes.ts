import { InvestigationAuthorization } from './authorization.js';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '../auth/actor-context.js';
import { actorContextService } from '../auth/actor-context.js';
import { hasPermission } from '../auth/require-permission.js';
import { alertEventService } from '../alert-event-service.js';
import { eventResourceAccess } from '../alert-event-access.js';
import { dbConnection } from '../db-connection.js';
import { metricConsumerService } from '../metrics/consumers/runtime.js';
import { PolicyError } from '../metrics/policy/model.js';
import { parseEntryContext, type InvestigationEntryContext } from './entry-contracts.js';
import { InvestigationStoreError } from './store.js';
import type { InvestigationSessionBridge } from './session-bridge.js';

export async function checkEntryEvents(actor: ActorContext, context: InvestigationEntryContext) {
  if (!context.sourceEventIds.length) return;
  const live = await actorContextService.revalidateActor(actor, actor.requestId);
  if (!hasPermission(new Set(live.permissions), 'alert:view')) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
  for (const id of context.sourceEventIds) {
    const event = await alertEventService.getEventById(id);
    if (!event || !await eventResourceAccess(live, event)) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
    const pool = dbConnection.getPool();
    if (!pool) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
    const [rows] = await pool.execute<any[]>('SELECT payload FROM metric_trigger_episodes WHERE event_id=?', [id]);
    const payload = rows[0]?.payload;
    const ref = payload ? (typeof payload === 'string' ? JSON.parse(payload) : payload).resource
      : { type: 'instance', id: event.instance_id };
    if (!context.resourceRefs.some(r => r.type === ref.type && r.id === Number(ref.id)))
      throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
  }
}
/** Existing Investigation persistence, no admission, queue, Run or provider. */
export async function registerInvestigationEntryRoutes(app: FastifyInstance, verify: preHandlerHookHandler,
  bridge: InvestigationSessionBridge, metrics = metricConsumerService, events = checkEntryEvents) {
  const actorKey = (a: ActorContext) => ({ kind: a.principalKind ?? 'user', id: a.userId });
  async function scope(actor: ActorContext, context: InvestigationEntryContext) {
    await bridge.storeFor(actor).transaction(async connection => {
      await new InvestigationAuthorization().authorize(connection, actor, {
        id: 'entry-preview', sessionId: 'entry-preview', profileId: 'ops', profileVersion: 1,
        scopeVersion: 'entry-preview', lifecycle: 'open', version: 1, owner: actorKey(actor), resources: context.resourceRefs,
      }, 'read');
    });
  }
  async function read(actor: ActorContext, context: InvestigationEntryContext) {
    await scope(actor, context);
    await events(actor, context);
    const facts = [];
    for (const ref of context.resourceRefs) {
      const resource = { type: ref.type, id: ref.id };
      facts.push(context.metric
        ? await metrics.observations(actor, { resource, metric: context.metric, dimensions: context.dimensions ?? {}, from: context.from, to: context.to, limit: 200 })
        : await metrics.query(actor, { resource, from: context.from, to: context.to, history: true, view: 'core' }));
    }
    await events(actor, context);
    await scope(actor, context);
    return facts;
  }
  function route(method: 'GET' | 'POST', url: string, handler: (r: any, a: ActorContext) => Promise<unknown>) {
    app.route({ method, url, preHandler: verify, bodyLimit: 65536,
      onRequest: async (_r, reply) => { reply.header('Cache-Control', 'private, no-store'); },
      handler: async (r, reply) => {
        try {
          if (Object.keys(r.query as object).length) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
          return await handler(r, (r as any).user);
        }
        catch (e) {
          if (e instanceof InvestigationStoreError) return reply.code(e.statusCode).send({ error: e.code });
          if (e instanceof PolicyError) return reply.code(e.status).send({ error: e.code });
          if (e instanceof z.ZodError) return reply.code(400).send({ error: 'INVESTIGATION_INPUT_INVALID' });
          if (e instanceof Error && e.message === 'QUERY_FORBIDDEN') return reply.code(403).send({ error: e.message });
          if (e instanceof Error && ['QUERY_LIMIT_EXCEEDED', 'QUERY_WINDOW', 'QUERY_SERIES_COUNT'].includes(e.message)) return reply.code(400).send({ error: e.message });
          r.log.error({ code: 'INVESTIGATION_ENTRY_UNAVAILABLE', requestId: r.id }, 'Investigation entry failed');
          return reply.code(503).send({ error: 'INVESTIGATION_QUEUE_UNAVAILABLE' });
        }
      } });
  }
  route('POST', '/api/investigations/drafts', async (r, actor) => {
    const context = parseEntryContext(r.body), key = r.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key) > 255) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
    // Validate the exact requested facts before creating anything. No model dependency.
    await read(actor, context);
    const primary = context.resourceRefs.find(r => r.role === 'primary')!;
    const title = context.sourceEventIds.length ? '事件只读调查' : context.metric ? '指标历史调查' : '资源只读调查';
    const result = await bridge.create(actor, { title, goal: '核对所选资源与时间窗口内的授权事实，保留证据与缺口。',
      profileId: 'ops', profileVersion: 1, resources: context.resourceRefs, idempotencyKey: key,
      context: { subject: { kind: 'resource', resource: { type: primary.type, id: primary.id } }, from: context.from, to: context.to, entry: context } });
    return { id: result.investigation.id, context, modelInvoked: false };
  });
  route('POST', '/api/investigations/entry-facts', async (r, actor) => {
    const context = parseEntryContext(r.body);
    const facts = await read(actor, context);
    return { context, facts, modelInvoked: false };
  });
  route('GET', '/api/investigations/:id/context-facts', async (r, actor) => {
    if (!/^[a-f0-9-]{36}$/.test(r.params.id) || Object.keys(r.query).length) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
    const record = await bridge.storeFor(actor).detail(actorKey(actor), r.params.id);
    if (!record.context?.entry) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
    // Historical absolute window is immutable, even after it leaves retention.
    const context = parseEntryContext(record.context.entry), facts = await read(actor, context);
    await bridge.storeFor(actor).detail(actorKey(actor), r.params.id);
    return { context, facts, modelInvoked: false };
  });
}
