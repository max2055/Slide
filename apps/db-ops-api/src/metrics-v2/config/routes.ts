import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { dbConnection } from '../../db-connection.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { PolicyError, RefSchema, refKey, rule } from '../policy/model.js';
import { policyService } from '../policy/service.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MetricConfigurationService, type TrialStore } from './service.js';
import type { PackageRegistry } from '../packages/model.js';
import { CollectionAttemptSchema } from '../../contracts/metrics-v2/index.js';
import { trialAccess } from './access.js';

const registry = createConfigurationRegistry();
const pool = () => { const p = dbConnection.getPool(); rule(p, 'POLICY_STORE_UNAVAILABLE', 503); return p; };
export function createTrialStore(pool: () => Pool, registry: PackageRegistry): TrialStore { return {
  reserve: ref => new MysqlScheduleStore(pool(), registry).reserve(ref),
  attempts: async ref => {
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT payload FROM metric_v2_attempts
      WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.binding_id')) = ? ORDER BY stored_at DESC LIMIT 20`, [refKey(ref)]);
    return rows.map(r => CollectionAttemptSchema.parse(typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
  },
}; }
const service = new MetricConfigurationService(policyService, registry, createTrialStore(pool, registry), trialAccess);
export async function registerMetricConfigurationRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  implementation = service): Promise<void> {
  for (const operation of ['catalog', 'access', 'attempts', 'trial'] as const) {
    app.route({ method: operation === 'trial' ? 'POST' : 'GET',
      url: operation === 'catalog' ? '/api/metrics-v2/config/catalog' : `/api/metrics-v2/config/resources/:type/:id/${operation}`,
      preHandler: [verifyToken], bodyLimit: 65536, handler: async (request, reply) => {
        const actor = (request as unknown as { user?: ActorContext }).user;
        if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
        try {
          if (operation === 'catalog') return implementation.catalog(actor);
          const params = request.params as { type: string; id: string };
          rule(/^[1-9]\d*$/.test(params.id), 'POLICY_RESOURCE');
          const ref = RefSchema.parse({ type: params.type, id: Number(params.id) });
          if (operation === 'access') return await implementation.resource(actor, ref);
          if (operation === 'attempts') return await implementation.attempts(actor, ref);
          return await implementation.trial(actor, ref, request.body);
        } catch (error) {
          if (error instanceof PolicyError) return reply.code(error.status).send({ error: error.code });
          if (error instanceof z.ZodError) return reply.code(400).send({ error: 'POLICY_INPUT_INVALID' });
          if (error instanceof Error && error.message === 'PACKAGE_PIN') return reply.code(400).send({ error: 'POLICY_PACKAGE_PIN' });
          return reply.code(500).send({ error: 'TRIAL_FAILED' });
        }
      } });
  }
}
