import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ActorContext } from '../auth/actor-context.js';
import { ActorAuthenticationError } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { requirePermission } from '../auth/require-permission.js';
import { InvestigationGovernanceSchemas } from './governance-contracts.js';
import { GovernanceReadError, InvestigationGovernanceStore } from './governance-store.js';

export async function registerInvestigationGovernanceRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  store = new InvestigationGovernanceStore(() => dbConnection.getPool())): Promise<void> {
  for (const kind of ['policies', 'budget', 'usage'] as const) {
    const schema = kind === 'policies' ? InvestigationGovernanceSchemas.InvestigationPoliciesResponse
      : kind === 'budget' ? InvestigationGovernanceSchemas.InvestigationBudgetResponse : InvestigationGovernanceSchemas.InvestigationUsageResponse;
    app.get(`/api/investigation-${kind}`, {
      onRequest: async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); },
      preHandler: [verifyToken, requirePermission('ai:view'), ...(kind === 'policies' ? [] : [requirePermission('config:manage')])],
      schema: { response: { 200: schema,
        400: Type.Object({ error: Type.String() }, { additionalProperties: false }),
        401: Type.Object({ error: Type.String() }, { additionalProperties: false }),
        403: Type.Object({ error: Type.String() }, { additionalProperties: false }),
        503: Type.Object({ error: Type.String() }, { additionalProperties: false }) } },
    }, async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      if (Object.keys(q).some(key => kind !== 'usage' || !['limit', 'offset'].includes(key))
        || kind === 'usage' && (q.limit !== undefined && (typeof q.limit !== 'string' || !/^[1-9]\d?$/.test(q.limit) || Number(q.limit) > 50)
          || q.offset !== undefined && (typeof q.offset !== 'string' || !/^(0|[1-9]\d{0,5})$/.test(q.offset) || Number(q.offset) > 200_000))) {
        return reply.code(400).send({ error: 'INVESTIGATION_INPUT_INVALID' });
      }
      try {
        const actor = (request as unknown as { user: ActorContext }).user;
        return kind === 'usage' ? await store.usage(actor, Number(q.limit ?? 20), Number(q.offset ?? 0)) : await store[kind](actor);
      } catch (error) {
        const status = error instanceof ActorAuthenticationError ? 401
          : error instanceof GovernanceReadError && error.code === 'GOVERNANCE_FORBIDDEN' ? 403 : 503;
        return reply.code(status).send({ error: status === 401 ? 'GOVERNANCE_IDENTITY_REVOKED'
          : status === 403 ? 'GOVERNANCE_FORBIDDEN' : 'GOVERNANCE_UNAVAILABLE' });
      }
    });
  }
}
