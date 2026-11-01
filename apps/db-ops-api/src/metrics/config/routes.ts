import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { actorContextService, ActorAuthenticationError } from '../../auth/actor-context.js';
import { dbConnection } from '../../db-connection.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { PolicyError, RefSchema, refKey, rule } from '../policy/model.js';
import { policyService } from '../policy/service.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MetricConfigurationService, type TrialStore } from './service.js';
import type { PackageRegistry } from '../packages/model.js';
import { CollectionAttemptSchema } from '../../contracts/metrics/index.js';
import { trialAccess } from './access.js';
import { configurationReader } from './status-store.js';

const registry = createConfigurationRegistry();
const pool = () => { const p = dbConnection.getPool(); rule(p, 'POLICY_STORE_UNAVAILABLE', 503); return p; };
export function createTrialStore(pool: () => Pool, registry: PackageRegistry): TrialStore { return {
  reserve: ref => new MysqlScheduleStore(pool(), registry).reserve(ref),
  attempts: async ref => {
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT payload FROM metric_attempts
      WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.binding_id')) = ? ORDER BY stored_at DESC LIMIT 20`, [refKey(ref)]);
    return rows.map(r => CollectionAttemptSchema.parse(typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
  },
}; }
export const metricConfigurationService = new MetricConfigurationService(policyService, registry, createTrialStore(pool, registry), trialAccess, configurationReader(pool),
  actor => actorContextService.revalidateActor(actor, actor.requestId));
export async function registerMetricConfigurationRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  implementation = metricConfigurationService): Promise<void> {
  for (const operation of ['catalog', 'access', 'attempts', 'trial', 'status', 'recommendations', 'activate', 'migration'] as const) {
    app.route({ method: operation === 'trial' || operation === 'activate' ? 'POST' : 'GET',
      url: operation === 'catalog' ? '/api/metrics/config/catalog' : `/api/metrics/config/resources/:type/:id/${operation}`,
      preHandler: [verifyToken], bodyLimit: 65536, handler: async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        const actor = (request as unknown as { user?: ActorContext }).user;
        if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
        try {
          if (operation === 'catalog') return implementation.catalog(actor);
          const params = request.params as { type: string; id: string };
          rule(/^[1-9]\d*$/.test(params.id), 'POLICY_RESOURCE');
          const ref = RefSchema.parse({ type: params.type, id: Number(params.id) });
          if (operation === 'access') return await implementation.resource(actor, ref);
          if (operation === 'attempts') return await implementation.attempts(actor, ref);
          if (operation === 'migration') return await implementation.migration(actor, ref);
          if (operation === 'status') return await implementation.status(actor, ref);
          if (operation === 'recommendations') return await implementation.recommendations(actor, ref);
          if (operation === 'activate') return await implementation.activate(actor, ref, request.body);
          return await implementation.trial(actor, ref, request.body);
        } catch (error) {
          if (error instanceof ActorAuthenticationError) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
          if (error instanceof PolicyError) return reply.code(error.status).send({ error: error.code });
          if (error instanceof z.ZodError) return reply.code(400).send({ error: 'POLICY_INPUT_INVALID' });
          if (error instanceof Error && error.message === 'PACKAGE_PIN') return reply.code(400).send({ error: 'POLICY_PACKAGE_PIN' });
          return reply.code(500).send({ error: 'TRIAL_FAILED' });
        }
      } });
  }
  // Retry support: an absent key is authoritative (no publication with that key
  // is in flight), so a client can decide to retry the same intent without
  // resending a mutation whose outcome it could not observe.
  app.route({ method: 'GET', url: '/api/metrics/config/resources/:type/:id/operations/:key', preHandler: [verifyToken],
    handler: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const actor = (request as unknown as { user?: ActorContext }).user;
      if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
      try {
        const params = request.params as { type: string; id: string; key: string };
        rule(/^[1-9]\d*$/.test(params.id), 'POLICY_RESOURCE');
        return await implementation.operation(actor, RefSchema.parse({ type: params.type, id: Number(params.id) }), params.key);
      } catch (error) {
        if (error instanceof ActorAuthenticationError) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
        if (error instanceof PolicyError) return reply.code(error.status).send({ error: error.code });
        if (error instanceof z.ZodError) return reply.code(400).send({ error: 'POLICY_INPUT_INVALID' });
        return reply.code(500).send({ error: 'POLICY_FAILED' });
      }
    } });
}
