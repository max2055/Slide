import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import { requirePermission } from './auth/require-permission.js';
import { requireInstanceAccess } from './auth/require-instance-access.js';
import { databaseService, type QueryReadIssue } from './database-service.js';

const sourceFailure = {
  'source-unavailable': { status: 503, error: 'SOURCE_UNAVAILABLE' },
  'source-forbidden': { status: 424, error: 'SOURCE_PERMISSION_DENIED' },
  'read-failed': { status: 502, error: 'SOURCE_READ_FAILED' },
} as const;

function queryFailure(reply: FastifyReply, issue: QueryReadIssue, connectionMessage: string) {
  if (issue === 'not-connected') return reply.code(404).send({ error: connectionMessage });
  const { status, error } = sourceFailure[issue];
  return reply.code(status).send({ error });
}

// Shared by the platform server and real-service query acceptance tests.
export async function registerInstanceQueryRoutes(fastify: FastifyInstance, verifyToken: preHandlerHookHandler): Promise<void> {
  // 获取慢查询 (TopSQL)
  fastify.get('/api/database/instances/:id/topsql', { preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const { limit = 10 } = request.query as any;
      const requested = Number(limit);
      const size = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 10) : 10;
      let source = 'unknown';
      let issue: QueryReadIssue = 'not-connected';
      const queries = await databaseService.getSlowQueries(Number(id), size, value => { source = value; }, value => { issue = value; });
      if (!queries) {
        return queryFailure(reply, issue, '无法获取慢查询，实例未连接');
      }
      return reply.header('access-control-expose-headers', 'x-slide-query-source').header('x-slide-query-source', source).send(queries);
    } catch {
      return queryFailure(reply, 'read-failed', '');
    }
  });

  // 获取会话列表
  fastify.get('/api/database/instances/:id/sessions', { preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      let issue: QueryReadIssue = 'not-connected';
      const sessions = await databaseService.getActiveSessions(Number(id), value => { issue = value; });
      if (!sessions) {
        return queryFailure(reply, issue, '无法获取会话，实例未连接');
      }
      return reply.send(sessions);
    } catch {
      return queryFailure(reply, 'read-failed', '');
    }
  });

}
