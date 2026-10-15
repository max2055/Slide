import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { requirePermission } from './auth/require-permission.js';
import { requireInstanceAccess } from './auth/require-instance-access.js';
import { databaseService } from './database-service.js';

// Shared by the platform server and real-service query acceptance tests.
export async function registerInstanceQueryRoutes(fastify: FastifyInstance, verifyToken: preHandlerHookHandler): Promise<void> {
  // 获取慢查询 (TopSQL)
  fastify.get('/api/database/instances/:id/topsql', { preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const { limit = 10 } = request.query as any;
      let source = 'unknown';
      const queries = await databaseService.getSlowQueries(Number(id), Number(limit), value => { source = value; });
      if (!queries) {
        return reply.code(404).send({ error: '无法获取慢查询，实例可能未连接' });
      }
      reply.header('x-slide-query-source', source).send(queries);
    } catch (error: any) {
      reply.code(500).send({ error: '获取慢查询失败：' + error.message });
    }
  });

  // 获取会话列表
  fastify.get('/api/database/instances/:id/sessions', { preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const sessions = await databaseService.getActiveSessions(Number(id));
      if (!sessions) {
        return reply.code(404).send({ error: '无法获取会话，实例可能未连接' });
      }
      reply.send(sessions);
    } catch (error: any) {
      reply.code(500).send({ error: '获取会话失败：' + error.message });
    }
  });

}
