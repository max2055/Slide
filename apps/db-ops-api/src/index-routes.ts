import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { IndexUsageReadError, indexService } from './index-service.js';
import { indexDatabaseService } from './index-database-service.js';

// 生产与真实 HTTP 回归共用注册入口，调用方必须显式提供权限链。
export function registerIndexRoutes(
  fastify: FastifyInstance,
  security: { manage: preHandlerHookHandler[]; view: preHandlerHookHandler[] },
): void {
  // ========== 索引管理 API ==========

  // 触发索引采集
  fastify.post('/api/index/collect/:instanceId', {
    preHandler: security.manage,
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const result = await indexService.collectIndexes(Number(instanceId));
        if ('error' in result) {
          return reply.code(400).send({ success: false, error: result.error });
        }
        return reply.send({ success: true, data: result });
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    }
  });

  // 触发冗余检测
  fastify.post('/api/index/detect/:instanceId', {
    preHandler: security.manage,
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const result = await indexService.detectRedundantIndexes(Number(instanceId));
        if ('error' in result) {
          return reply.code(400).send({ success: false, error: result.error });
        }
        return reply.send(result);
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取实例所有索引
  fastify.get('/api/indexes/:instanceId', {
    preHandler: security.view,
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const indexes = await indexDatabaseService.getIndexesByInstance(Number(instanceId));
        return reply.send(indexes);
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取冗余索引报告（必须在 :tableName 之前）
  fastify.get('/api/indexes/:instanceId/redundancy', {
    preHandler: security.view,
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const report = await indexDatabaseService.getRedundancyReport(Number(instanceId));
        return reply.send(report);
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取未使用索引列表（必须在 :tableName 之前）
  fastify.get('/api/indexes/:instanceId/unused', {
    preHandler: security.view,
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const { rows, evidence } = await indexService.readUnusedIndexObservation(Number(instanceId));
        return reply
          .header('access-control-expose-headers', 'x-slide-index-usage')
          .header('x-slide-index-usage', JSON.stringify(evidence))
          .send(rows);
      } catch (error: any) {
        if (error instanceof IndexUsageReadError) return reply.code(503).send({ error: error.message });
        return reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取指定表的索引
  fastify.get('/api/indexes/:instanceId/:tableName', {
    preHandler: security.view,
    handler: async (request, reply) => {
      try {
        const { instanceId, tableName } = request.params as any;
        const indexes = await indexDatabaseService.getIndexesByTable(Number(instanceId), tableName);
        return reply.send(indexes);
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    }
  });

}
