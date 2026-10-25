import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ActorContext } from '../auth/actor-context.js';
import { ActorAuthenticationError } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { requirePermission } from '../auth/require-permission.js';
import { InvestigationGovernanceSchemas, InvestigationEffectiveBudgetViewSchema } from './governance-contracts.js';
import { GovernanceReadError, InvestigationGovernanceStore } from './governance-store.js';
import { InvestigationEffectiveBudgetError, InvestigationEffectiveBudgetInputSchema } from './effective-budget.js';

const errorSchema = Type.Object({ error: Type.String() }, { additionalProperties: false });

export async function registerInvestigationGovernanceRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  store = new InvestigationGovernanceStore(() => dbConnection.getPool())): Promise<void> {
  for (const kind of ['policies', 'budget', 'usage'] as const) {
    const schema = kind === 'policies' ? InvestigationGovernanceSchemas.InvestigationPoliciesResponse
      : kind === 'budget' ? InvestigationGovernanceSchemas.InvestigationBudgetResponse : InvestigationGovernanceSchemas.InvestigationUsageResponse;
    app.get(`/api/investigation-${kind}`, {
      onRequest: async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); },
      preHandler: [verifyToken, requirePermission('ai:view'), ...(kind === 'policies' ? [] : [requirePermission('config:manage')])],
      schema: { response: { 200: schema, 400: errorSchema, 401: errorSchema, 403: errorSchema, 503: errorSchema } },
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

  const budgetStatus = (error: unknown) => error instanceof ActorAuthenticationError ? 401
    : error instanceof GovernanceReadError && error.code === 'GOVERNANCE_FORBIDDEN' ? 403
    : error instanceof InvestigationEffectiveBudgetError ? ({
      INVESTIGATION_BUDGET_CONFLICT: 409,
      INVESTIGATION_BUDGET_CONFIGURATION_INVALID: 400,
      INVESTIGATION_BUDGET_CAPABILITY_UNAVAILABLE: 422,
      INVESTIGATION_BUDGET_CAPABILITY_EXCEEDED: 422,
      INVESTIGATION_BUDGET_UNAVAILABLE: 503,
    } as const)[error.code] : 503;
  const budgetError = (error: unknown, reply: any) => {
    const status = budgetStatus(error);
    return reply.code(status).send({ error: error instanceof InvestigationEffectiveBudgetError ? error.code
      : status === 401 ? 'GOVERNANCE_IDENTITY_REVOKED' : status === 403 ? 'GOVERNANCE_FORBIDDEN' : 'GOVERNANCE_UNAVAILABLE' });
  };
  const effectiveBudgetSchema = { 200: InvestigationEffectiveBudgetViewSchema, 400: errorSchema, 401: errorSchema,
    403: errorSchema, 409: errorSchema, 422: errorSchema, 503: errorSchema };
  app.get('/api/investigation-budget/effective', {
    onRequest: async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); },
    preHandler: [verifyToken, requirePermission('ai:view'), requirePermission('config:manage')],
    schema: { response: effectiveBudgetSchema },
  }, async (request, reply) => {
    try {
      return await store.effectiveBudgetFacts((request as unknown as { user: ActorContext }).user);
    } catch (error) { return budgetError(error, reply); }
  });
  app.put('/api/investigation-budget/effective', {
    onRequest: async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); },
    preHandler: [verifyToken, requirePermission('ai:view'), requirePermission('config:manage')],
    schema: { body: InvestigationEffectiveBudgetInputSchema, response: effectiveBudgetSchema },
  }, async (request, reply) => {
    try {
      const actor = (request as unknown as { user: ActorContext }).user;
      await store.saveEffectiveBudget(actor, request.body,
        { clientIp: request.ip, userAgent: request.headers['user-agent'] });
      return await store.effectiveBudgetFacts(actor);
    } catch (error) { return budgetError(error, reply); }
  });
}
