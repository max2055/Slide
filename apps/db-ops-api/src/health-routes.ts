import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { requirePermission } from './auth/require-permission.js';
import { HealthResponseSchema } from './contracts/public-api.js';
import { consistencyChecker } from './consistency-checker.js';

export function registerHealthRoutes(
  fastify: FastifyInstance,
  verifyToken: preHandlerHookHandler,
  checker: Pick<typeof consistencyChecker, 'healthOverview'> = consistencyChecker,
): void {
  // 健康检查
  fastify.get('/api/health', { schema: { response: { 200: HealthResponseSchema } } }, async (request, reply) => {
    reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
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
