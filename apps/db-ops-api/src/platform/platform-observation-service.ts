import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { platformLogs, type StructuredLogEvidenceAdapter } from './structured-log-evidence-adapter.js';
import { expensiveOperationRateLimitConfig } from '../security/http-security.js';
import { FixedWindowRateLimiter } from '../security/agent-runtime-limits.js';

export async function installPlatformObservation(app: FastifyInstance, verifyToken: preHandlerHookHandler, logs: StructuredLogEvidenceAdapter = platformLogs): Promise<void> {
  const starts = new WeakMap<object, number>();
  const clientEvents = new FixedWindowRateLimiter(120, 60_000);
  app.addHook('onRequest', async request => { starts.set(request, performance.now()); });
  app.addHook('onResponse', async (request, reply) => {
    if (request.routeOptions.url?.startsWith('/api/platform/')) return;
    logs.record({ component: 'api', eventType: 'request.completed', status: reply.statusCode >= 500 ? 'failed' : 'ok',
      durationMs: Math.max(0, performance.now() - (starts.get(request) ?? performance.now())), correlationId: request.id,
      errorCode: reply.statusCode >= 400 ? `HTTP_${reply.statusCode}` : undefined, releaseId: process.env.SLIDE_RELEASE_ID });
  });
  app.post('/api/platform/frontend-events', { preHandler: [verifyToken], bodyLimit: 1024, config: { rateLimit: expensiveOperationRateLimitConfig } }, async (request: any, reply) => {
    if (!request.user?.userId) return reply.code(401).send({ error: 'ACTOR_REQUIRED' });
    const body = request.body;
    if (!body || Object.keys(body).some(key => !['eventType', 'buildId'].includes(key)) || !['runtime.error', 'runtime.rejection', 'boot.completed'].includes(body.eventType)
      || (body.buildId !== undefined && body.buildId !== 'unknown' && !/^[a-f0-9]{40}$/.test(body.buildId))) return reply.code(400).send({ error: 'FRONTEND_EVENT_INVALID' });
    if (!clientEvents.allow()) return reply.code(429).send({ error: 'FRONTEND_EVENT_RATE_LIMITED' });
    logs.record({ component: 'frontend', eventType: body.eventType, status: 'unknown', correlationId: request.id,
      releaseId: body.buildId ?? 'unknown', errorCode: 'CLIENT_REPORTED_UNVERIFIED' });
    return reply.code(202).send({ accepted: true });
  });
  app.get('/api/platform/observations', { preHandler: [verifyToken] }, async (request: any, reply) => {
    const permissions: string[] = request.user?.permissions ?? [];
    if (!permissions.some(permission => ['*', 'config:*', 'config:view'].includes(permission))) return reply.code(403).send({ error: 'PLATFORM_OBSERVATION_FORBIDDEN' });
    const { from, to, component } = request.query as Record<string, string>;
    try {
      const summary = logs.query({ from, to, component });
      const components = ['api', 'agent', 'ws', 'collector', 'queue', 'frontend'].map(component => {
        const evidence = logs.query({ component });
        return { component, quality: evidence.quality, gaps: evidence.gaps, groups: evidence.groups };
      });
      return { schemaVersion: 1, generatedAt: new Date().toISOString(), releaseId: process.env.SLIDE_RELEASE_ID ?? null,
        commitSha: /^[a-f0-9]{40}$/.test(process.env.SLIDE_COMMIT_SHA ?? '') ? process.env.SLIDE_COMMIT_SHA : null,
        uptimeSeconds: Math.floor(process.uptime()), components, logs: summary };
    } catch { return reply.code(400).send({ error: 'PLATFORM_LOG_QUERY_INVALID' }); }
  });
}
