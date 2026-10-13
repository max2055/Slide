import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { Value } from '@sinclair/typebox/value';
import { dbConnection } from '../db-connection.js';
import type { ActorContext } from '../auth/actor-context.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { resolveInvestigationProfile } from './profiles.js';
import { InvestigationStoreError, type InvestigationAcceptance, type InvestigationList } from './store.js';
import { InvestigationCreateRequestSchema, InvestigationRequestSchema, InvestigationPatchRequestSchema } from './http-contracts.js';
import { LegacyAnalysisBridge } from './legacy-analysis-bridge.js';

const invalid = () => new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
const actorOf = (request: FastifyRequest) => (request as FastifyRequest & { user: ActorContext }).user;
const principal = (actor: ActorContext) => ({ kind: actor.principalKind ?? 'user', id: actor.userId });
const accepted = (value: InvestigationAcceptance) => ({ id: value.investigationId, ...value });
function key(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 255) throw invalid();
  return value;
}
function uuid(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw invalid();
  return value;
}
function listInput(request: FastifyRequest): { options: InvestigationList; fingerprint: string; limit: number; offset: number } {
  const query = request.query as Record<string, string>;
  if (Object.keys(query).some(k => !['state','profile','resource','query','limit','cursor'].includes(k))) throw invalid();
  const { state, profile, resource, query: search } = query;
  const limit = query.limit === undefined ? 20 : /^\d+$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw invalid();
  let ref: InvestigationList['resource'];
  if (resource !== undefined) {
    const match = /^(instance|server|network_device):([1-9]\d*)$/.exec(resource);
    if (!match) throw invalid();
    ref = { type: match[1] as NonNullable<typeof ref>['type'], id: Number(match[2]) };
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([state ?? null, profile ?? null, resource ?? null, search ?? null])).digest('hex');
  let offset = 0;
  if (query.cursor !== undefined) {
    try {
      if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw invalid();
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (cursor.filter !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw invalid();
      offset = cursor.offset;
    } catch { throw invalid(); }
  }
  return { options: { lifecycle: state as InvestigationList['lifecycle'], profileId: profile as InvestigationList['profileId'],
    resource: ref, query: search, offset, limit }, fingerprint, limit, offset };
}

/** Authenticated HTTP only; no caller-selected actor/Profile authority, models,
 * executor registration, Run state owner, or secondary enqueue path. */
export async function registerInvestigationRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  bridge = new InvestigationSessionBridge(() => dbConnection.getPool()),
  observation = bridge.observationServices(),
  legacy = new LegacyAnalysisBridge(() => dbConnection.getPool(), undefined, bridge)): Promise<void> {
  // Read expiry is immediate; unattended SQL purge is bounded and independently
  // removes raw bodies while preserving all historical metadata/hash bindings.
  let purge: Promise<unknown> | undefined;
  const retention = setInterval(() => {
    if (purge) return;
    purge = observation.evidence.purgeExpired().catch(() => app.log.error({ code: 'EVIDENCE_RETENTION_UNAVAILABLE' }, 'Evidence retention failed'))
      .finally(() => { purge = undefined; });
  }, 60_000);
  retention.unref();
  app.addHook('onClose', async () => { clearInterval(retention); await purge; });
  function route(method: 'GET' | 'POST' | 'PATCH', url: string,
    handler: (request: FastifyRequest, reply: FastifyReply, actor: ActorContext) => Promise<unknown>) {
    app.route({ method, url, preHandler: verifyToken,
      onRequest: async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); },
      handler: async (request, reply) => {
        try { return await handler(request, reply, actorOf(request)); }
        catch (error) {
          if (error instanceof InvestigationStoreError) return reply.code(error.statusCode).send({ error: error.code });
          // Do not publish SQL text, command payloads, or credentials.
          request.log.error({ code: 'INVESTIGATION_QUEUE_UNAVAILABLE', requestId: request.id }, 'Investigation HTTP failed');
          return reply.code(503).send({ error: 'INVESTIGATION_QUEUE_UNAVAILABLE' });
        }
      } });
  }
  route('POST', '/api/investigations', async (request, reply, actor) => {
    const idempotencyKey = key(request);
    if (!Value.Check(InvestigationCreateRequestSchema, request.body)) throw invalid();
    const body = request.body;
    const profile = resolveInvestigationProfile(body.profileId, 1);
    if (!profile.supportedSubjectKinds.includes(body.subject.kind as never)) throw new InvestigationStoreError('PROFILE_SUBJECT_UNSUPPORTED');
    const subject = body.subject;
    if (subject.kind === 'resource' && !body.resourceRefs.some(ref => ref.type === subject.resource.type && ref.id === subject.resource.id)) throw invalid();
    if ((body.from === undefined) !== (body.to === undefined)) throw invalid();
    if (body.from !== undefined && body.to !== undefined) {
      const from = Date.parse(body.from), to = Date.parse(body.to);
      const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
      const canonical = (value: string) => value.includes('.') ? value : value.replace('Z', '.000Z');
      if (!instant.test(body.from) || !instant.test(body.to) || !Number.isFinite(from) || !Number.isFinite(to)
        || new Date(from).toISOString() !== canonical(body.from) || new Date(to).toISOString() !== canonical(body.to)
        || from >= to || to - from > profile.budget.maxWindowMs) throw invalid();
    }
    const context = { subject: subject.kind === 'resource'
      ? { kind: 'resource' as const, resource: { type: subject.resource.type, id: subject.resource.id } }
      : { kind: 'platform' as const, component: subject.component, ...(subject.releaseId ? { releaseId: subject.releaseId } : {}) }, ...(body.from ? { from: body.from, to: body.to } : {}) };
    const result = await bridge.create(actor, { title: body.title, goal: body.goal, profileId: body.profileId,
      profileVersion: profile.version, resources: body.resourceRefs, sessionId: body.sessionId, idempotencyKey, context },
    { message: body.goal, idempotencyKey });
    if (!result.acceptance) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
    return reply.code(202).send(accepted(result.acceptance));
  });
  route('GET', '/api/investigations', async (request, _reply, actor) => {
    const { options, fingerprint, limit, offset } = listInput(request);
    const result = await bridge.storeFor(actor).list(principal(actor), options);
    return { items: result.items, authorizedCounts: { total: result.total },
      nextCursor: offset + limit < result.total ? Buffer.from(JSON.stringify({ offset: offset + limit, filter: fingerprint })).toString('base64url') : null };
  });
  route('GET', '/api/investigations/:id', async (request, _reply, actor) => {
    const id = uuid((request.params as { id: string }).id);
    const record = await bridge.storeFor(actor).detail(principal(actor), id);
    const snapshot = await observation.stream.snapshot(actor, id);
    const results = await observation.results.list(actor, id, undefined, 1);
    const run = record.activeRequestId
      ? snapshot.runs.find(run => run.requestId === record.activeRequestId)
      : snapshot.runs.at(-1);
    return { ...record, legacyAnalysis: await legacy.read(actor, id), derivedRunState: run ? run.resolution === 'outcome_unknown' ? 'unknown' : run.state : record.activeRequestId ? 'queued' : null,
      latestResult: results.items[0] ?? null, watermark: snapshot.watermark };
  });
  route('GET', '/api/investigations/:id/events', async (request, _reply, actor) => {
    const query = request.query as Record<string, string>;
    if (Object.keys(query).some(k => !['after', 'limit'].includes(k))) throw invalid();
    const number = (value: string | undefined, fallback: number) => value === undefined ? fallback : /^\d+$/.test(value) ? Number(value) : NaN;
    const result = await observation.stream.replay(actor, uuid((request.params as { id: string }).id), number(query.after, 0), number(query.limit, 200));
    return { ...result, ...(result.replayRequired ? { code: 'replay_required' } : {}) };
  });
  route('GET', '/api/investigations/:id/evidence/:eid', async (request, reply, actor) => {
    const { id, eid } = request.params as { id: string; eid: string };
    const query = request.query as Record<string, string>;
    if (Object.keys(query).some(k => k !== 'raw') || query.raw !== undefined && query.raw !== 'true') throw invalid();
    const value = await observation.evidence.get(actor, uuid(id), uuid(eid), query.raw === 'true');
    if (query.raw === 'true' && value.status === 'expired') return reply.code(410).send({ error: 'EVIDENCE_EXPIRED', evidence: value });
    return value;
  });
  route('GET', '/api/investigations/:id/results', async (request, _reply, actor) => {
    const query = request.query as Record<string, string>;
    if (Object.keys(query).some(k => !['before', 'limit'].includes(k)) || Object.values(query).some(v => !/^\d+$/.test(v))) throw invalid();
    return observation.results.list(actor, uuid((request.params as { id: string }).id), query.before === undefined ? undefined : Number(query.before), query.limit === undefined ? 20 : Number(query.limit));
  });
  route('PATCH', '/api/investigations/:id', async (request, _reply, actor) => {
    if (await legacy.read(actor, uuid((request.params as { id: string }).id))) throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
    if (!Value.Check(InvestigationPatchRequestSchema, request.body)) throw invalid();
    return bridge.storeFor(actor).patch(principal(actor), uuid((request.params as { id: string }).id), request.body);
  });
  route('POST', '/api/investigations/:id/runs', async (request, reply, actor) => {
    if (await legacy.read(actor, uuid((request.params as { id: string }).id))) throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
    const idempotencyKey = key(request);
    if (!Value.Check(InvestigationRequestSchema, request.body)) throw invalid();
    return reply.code(202).send(accepted(await bridge.admit(actor, { ...request.body, idempotencyKey,
      investigationId: uuid((request.params as { id: string }).id) })));
  });
  route('GET', '/api/investigations/:id/messages', async (request, _reply, actor) => {
    const query = request.query as Record<string, string>;
    if (Object.keys(query).some(k => k !== 'limit')) throw invalid();
    const limit = query.limit === undefined ? 200 : /^\d+$/.test(query.limit) ? Number(query.limit) : NaN;
    return { messages: await bridge.messages(actor, uuid((request.params as { id: string }).id), limit) };
  });
  route('GET', '/api/investigations/:id/facts', async (request, _reply, actor) => {
    const query = request.query as Record<string, string>;
    if (Object.keys(query).some(k => !['limit', 'before'].includes(k)) || query.before !== undefined
      && (!/^\d+:\d+:\d+$/.test(query.before) || query.before.split(':').some(n => !Number.isSafeInteger(Number(n))))) throw invalid();
    const limit = query.limit === undefined ? 200 : /^\d+$/.test(query.limit) ? Number(query.limit) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalid();
    return bridge.facts(actor, uuid((request.params as { id: string }).id), limit, query.before);
  });
  route('POST', '/api/investigations/:id/requests/:requestId/cancel', async (request, reply, actor) => {
    if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Object.keys(request.body).length)) throw invalid();
    const { id, requestId } = request.params as { id: string; requestId: string };
    return reply.code(202).send(await bridge.storeFor(actor).cancel(principal(actor), uuid(id), uuid(requestId)));
  });
}
