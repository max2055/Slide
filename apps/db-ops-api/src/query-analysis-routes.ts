import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { requirePermission } from './auth/require-permission.js';
import { requireInstanceAccess } from './auth/require-instance-access.js';
import { databaseService } from './database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { classifySql } from './sql-validator.js';
import { sensitiveOperationRateLimitConfig } from './security/http-security.js';

// Share the production handlers with isolated real-database browser acceptance.
export async function registerQueryAnalysisRoutes(fastify: FastifyInstance, verifyToken: preHandlerHookHandler): Promise<void> {
  // 查询性能分析（QAN）
  fastify.get('/api/database/instances/:id/qan', { preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const query = request.query as any;
      const limit = Math.min(parseInt(query.limit || '20') || 20, 100);
      const data = await databaseService.getQueryAnalytics(Number(id), limit);
      if (!data) {
        return reply.code(404).send({ error: '无法获取 QAN 数据，实例可能未连接或数据库不支持' });
      }
      reply.send(data);
    } catch (error: any) {
      reply.code(500).send({ error: '获取 QAN 数据失败：' + error.message });
    }
  });

  // EXPLAIN 执行计划（JSON 格式）
  fastify.get('/api/database/instances/:id/explain', {
    config: { rateLimit: sensitiveOperationRateLimitConfig },
    preHandler: [verifyToken, requirePermission('instance:query'), requireInstanceAccess('read-only')],
  }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const query = request.query as any;
      const sql = query.sql;
      if (!sql) return reply.code(400).send({ error: '缺少参数：sql' });
      const instance = await instanceDatabaseService.getInstanceById(Number(id));
      if (!instance) return reply.code(404).send({ error: '实例不存在' });
      const classification = classifySql(String(sql), instance.db_type);
      if (classification.commandType !== 'read') return reply.code(400).send({ error: '只支持单条安全 SELECT', detail: classification.reasonCode });
      const plan = await databaseService.getExplainPlanJson(Number(id), sql);
      if (!plan) {
        return reply.code(404).send({ error: '无法获取执行计划，实例可能未连接' });
      }
      reply.send(plan);
    } catch (error: any) {
      reply.code(500).send({ error: '获取执行计划失败：' + error.message });
    }
  });

}
