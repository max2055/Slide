import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { requirePermission } from './auth/require-permission.js';
import { HealthResponseSchema, InfrastructureReadinessSchema } from './contracts/public-api.js';
import { consistencyChecker } from './consistency-checker.js';

export function registerHealthRoutes(
  fastify: FastifyInstance,
  verifyToken: preHandlerHookHandler,
  checker: Pick<typeof consistencyChecker, 'healthOverview'> = consistencyChecker,
  readiness: () => Promise<boolean> = async () => false,
): void {
  // 健康检查
  fastify.get('/api/health', { schema: { response: { 200: HealthResponseSchema } } }, async (request, reply) => {
    reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  fastify.get('/api/health/ready', { schema: { response: { 200: InfrastructureReadinessSchema, 503: InfrastructureReadinessSchema } } }, async (_request, reply) => {
    let ready = false;
    try { ready = await readiness(); } catch { /* Public probe never exposes dependency errors. */ }
    return reply.code(ready ? 200 : 503).send({ ready });
  });

  // 详细健康检查共享一个短时快照，避免页面重复查询纳管资源与一致性数据。
  fastify.get('/api/health/overview', { preHandler: [verifyToken, requirePermission('config:view')] }, async (request, reply) => {
    try {
      const { refresh } = request.query as { refresh?: string };
      return reply.send(await checker.healthOverview(refresh === 'true'));
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  fastify.get('/api/health/consistency', { preHandler: [verifyToken, requirePermission('config:view')] }, async (request, reply) => {
    try {
      const { refresh } = request.query as { refresh?: string };
      const { truth: _truth, ...consistency } = await checker.healthOverview(refresh === 'true');
      return reply.send(consistency);
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  fastify.get('/api/health/readiness', { preHandler: [verifyToken, requirePermission('config:view')] }, async (request, reply) => {
    try {
      const { refresh } = request.query as { refresh?: string };
      return reply.send((await checker.healthOverview(refresh === 'true')).truth);
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
