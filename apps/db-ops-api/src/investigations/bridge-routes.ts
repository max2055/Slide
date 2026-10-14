import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { LegacyAnalysisBridge } from './legacy-analysis-bridge.js';
import { InvestigationStoreError } from './store.js';
import { investigationBridgeFlags } from './bridge-flags.js';
import { alertRCAService } from '../alert-rca-service.js';
import { requirePermission } from '../auth/require-permission.js';

export async function registerAnalysisBridgeRoutes(app: FastifyInstance, verify: preHandlerHookHandler,
  bridge = new LegacyAnalysisBridge(() => dbConnection.getPool()), flags = investigationBridgeFlags,
  rca: Pick<typeof alertRCAService, 'analyzeAlert'> = alertRCAService) {
  app.post('/api/alerts/:id/investigation', { preHandler: [verify, requirePermission('ai:manage')],
    onRequest: async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); } }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try {
      const raw = (request.params as { id: string }).id;
      if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || request.body !== undefined
        && (!request.body || typeof request.body !== 'object' || Object.keys(request.body).length)) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
      const result = await rca.analyzeAlert(Number(raw), 'manual', (request as FastifyRequest & { user: ActorContext }).user);
      if (result.error === 'INVESTIGATION_NOT_FOUND') throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
      return reply.code(result.success ? result.investigationId ? 202 : 200 : result.status === 'unknown' ? 409 : 422).send({ ...result,
        ...(result.analysisId ? { id: result.analysisId, session_key: result.sessionKey } : {}) });
    } catch (error) {
      if (error instanceof InvestigationStoreError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(503).send({ error: 'INVESTIGATION_QUEUE_UNAVAILABLE' });
    }
  });
  app.post('/api/ai/analysis/:id/investigation', { preHandler: verify,
    onRequest: async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); } }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try {
      if (!flags().legacy) return reply.code(503).send({ error: 'INVESTIGATION_LEGACY_BRIDGE_DISABLED' });
      if (request.body !== undefined && (!request.body || typeof request.body !== 'object' || Object.keys(request.body).length))
        throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
      const raw = (request.params as { id: string }).id;
      if (!/^[1-9]\d*$/.test(raw)) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
      return await bridge.link((request as FastifyRequest & { user: ActorContext }).user, Number(raw));
    } catch (error) {
      if (error instanceof InvestigationStoreError) return reply.code(error.statusCode).send({ error: error.code });
      request.log.error({ code: 'INVESTIGATION_QUEUE_UNAVAILABLE' }, 'Legacy bridge unavailable');
      return reply.code(503).send({ error: 'INVESTIGATION_QUEUE_UNAVAILABLE' });
    }
  });
}
