import { Value } from '@sinclair/typebox/value';
import { SystemEventWorkflow } from './system-event-workflow.js';
import { dbConnection } from '../db-connection.js';
import { SystemDraftSchema, SystemVerificationSchema, SystemVerificationRequestSchema, SystemInvestigationFactsSchema } from './system-http-contracts.js';
import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ActorContext } from '../auth/actor-context.js';
import { OutboxService, type TransactionPool } from '../workflows/outbox-service.js';
import { InvestigationAuthorization, freezeInvestigationCaller } from './authorization.js';
import { InvestigationStoreError, type AdmissionInvestigation } from './store.js';
import { stableHash } from './trigger-policy.js';
import { SYSTEM_EVENT_JOB, type SystemErrorFact } from './system-event-bridge.js';
import { SystemEventsPageSchema, SystemEventDetailSchema } from './system-http-contracts.js';

const decode = (v: any) => typeof v === 'string' ? JSON.parse(v) : v;
export class SystemEventReader {
  constructor(private readonly pool: () => Pool | null, private readonly authorization = new InvestigationAuthorization()) {}
  async read(caller: ActorContext, id?: string) {
    caller = freezeInvestigationCaller(caller);
    if (id !== undefined && !/^[a-f0-9-]{36}$/.test(id)) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
    const pool = this.pool(); if (!pool) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
    return new OutboxService(pool as unknown as TransactionPool).transaction(async c => {
      // Use the same live System scope checks without impersonating service
      // owner or granting access to its linked investigation/session.
      const subject: AdmissionInvestigation = { id: 'system-event-read', sessionId: 'system-event-read', profileId: 'system',
        profileVersion: 1, scopeVersion: 'system-event-read', version: 1, lifecycle: 'open',
        owner: { kind: caller.principalKind ?? 'user', id: caller.userId }, resources: [] };
      await this.authorization.authorize(c, caller, subject, 'create');
      const [rows] = await c.execute(`SELECT e.*, j.payload AS fact, l.investigation_id AS linked_investigation_id FROM operational_events e
        JOIN workflow_jobs j ON JSON_UNQUOTE(JSON_EXTRACT(e.envelope,'$.rawRef'))=CONCAT('workflow-job:',j.id)
        LEFT JOIN investigation_event_links l ON l.event_id=e.id
        WHERE e.source IN ('slide.system.api','slide.system.collector','slide.system.queue','slide.system.agent')
        AND j.job_type=? ${id ? 'AND e.id=?' : ''} ORDER BY e.received_at DESC,e.id DESC LIMIT 100`,
      id ? [SYSTEM_EVENT_JOB, id] : [SYSTEM_EVENT_JOB]) as [RowDataPacket[], unknown];
      if (id && !rows.length) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
      const items = [];
      for (const row of rows) {
        const fact = decode(row.fact) as SystemErrorFact, { contentHash, ...prepared } = fact;
        if (fact.schemaVersion !== 1 || fact.source !== String(row.source) || stableHash(prepared) !== contentHash)
          throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
        let investigationId: string | null = null;
        const linkedId = row.linked_investigation_id ?? row.investigation_id;
        if (linkedId) {
          try {
            const inv = await this.authorization.load(c, linkedId);
            await this.authorization.authorize(c, caller, inv, 'read');
            investigationId = inv.id;
          } catch (e) { if (!(e instanceof InvestigationStoreError) || e.code !== 'INVESTIGATION_NOT_FOUND') throw e; }
        }
        items.push({ eventId: row.id, component: fact.event.subject.kind === 'platform' ? fact.event.subject.component : '',
          occurredAt: fact.event.occurredAt, summary: fact.event.summary, stableErrorCode: fact.event.stableErrorCode,
          disposition: row.disposition, suppressionReason: row.suppression_reason, investigationId,
          ...(id ? { fact } : {}) });
      }
      await this.authorization.authorize(c, caller, subject, 'create');
      return id ? items[0] : { items, truncated: items.length === 100 };
    });
  }
}
export async function registerSystemEventRoutes(app: FastifyInstance, verify: preHandlerHookHandler, reader: SystemEventReader, workflow = new SystemEventWorkflow(() => dbConnection.getPool())) {
  // Explicit writes stay separate: opening facts never creates a draft or Run.
  app.post('/api/platform/system-events/:id/investigation', { preHandler: verify,
    schema: { body: { type: 'object', additionalProperties: false, properties: {} }, response: { 200: SystemDraftSchema } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try {
      if (Object.keys(request.query as object).length) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
      return await workflow.draft((request as any).user, (request.params as any).id);
    } catch (e) { return workflowError(e, reply); }
  });
  app.post('/api/platform/system-events/:id/verifications', { preHandler: verify, schema: { response: { 200: SystemVerificationSchema } } }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try {
      if (Object.keys(request.query as object).length || !Value.Check(SystemVerificationRequestSchema, request.body)) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string') throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
      return await workflow.verify((request as any).user, (request.params as any).id, request.body.investigationId, request.body.expectedVersion, key);
    } catch (e) { return workflowError(e, reply); }
  });
  app.get('/api/investigations/:id/platform-events', { preHandler: verify, schema: { response: { 200: SystemInvestigationFactsSchema } } }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try {
      if (Object.keys(request.query as object).length) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
      return await workflow.detail((request as any).user, (request.params as any).id);
    } catch (e) { return workflowError(e, reply); }
  });
  for (const detail of [false, true]) app.get(detail ? '/api/platform/system-events/:id' : '/api/platform/system-events', {
    preHandler: verify, schema: { response: { 200: detail ? SystemEventDetailSchema : SystemEventsPageSchema } },
    onRequest: async (_r, reply) => { reply.header('Cache-Control', 'private, no-store'); },
  }, async (request, reply: FastifyReply) => {
    try { return await reader.read((request as FastifyRequest & { user: ActorContext }).user, detail ? (request.params as { id: string }).id : undefined); }
    catch (e) {
      if (e instanceof InvestigationStoreError) return reply.code(e.statusCode).send({ error: e.code });
      return reply.code(503).send({ error: 'INVESTIGATION_QUEUE_UNAVAILABLE' });
    }
  });
}

function workflowError(e: unknown, reply: FastifyReply) {
  if (e instanceof InvestigationStoreError) return reply.code(e.statusCode).send({ error: e.code });
  return reply.code(503).send({ error: 'INVESTIGATION_QUEUE_UNAVAILABLE' });
}
