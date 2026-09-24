import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { dbConnection } from '../../db-connection.js';
import { PolicyError, RefSchema, type Ref } from '../policy/model.js';
import { policyService } from '../policy/service.js';
import { CasSchema, CutoverSchema, MysqlRolloutCoordinator, ShadowGateSchema } from './coordinator.js';
import { metricPortfolioService, type MetricPortfolioService } from './portfolio.js';

const ShadowSchema = z.strictObject({ expected_revision: z.number().int().positive() });
const GateSchema = z.strictObject({ expected_revision: z.number().int().positive(), gate: ShadowGateSchema });
const ConfirmSchema = z.strictObject({ expected_revision: z.number().int().positive() });
type Coordinator = Pick<MysqlRolloutCoordinator, 'status' | 'startShadow' | 'acceptShadow' | 'cutover' | 'confirmApplied' | 'rollback'>;
type Access = (actor: ActorContext, ref: Ref, write: boolean) => Promise<void>;
type Portfolio = Pick<MetricPortfolioService, 'status' | 'prepare' | 'shadow' | 'cutover' | 'confirm'>;
const PortfolioSchema = z.strictObject({ expected_plan_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/) });

const runtimeCoordinator = () => {
  const pool = dbConnection.getPool();
  if (!pool) throw new Error('ROLLOUT_STORE_UNAVAILABLE');
  return new MysqlRolloutCoordinator(pool);
};

export async function registerMetricRolloutRoutes(
  app: FastifyInstance,
  verifyToken: preHandlerHookHandler,
  implementation?: Coordinator,
  assertAccess: Access = (actor, ref, write) => policyService.assertAccess(actor, ref, write),
  portfolio?: Portfolio,
): Promise<void> {
  const root = '/api/metrics-v2/rollout/resources/:type/:id';
  const ref = (params: unknown) => {
    const value = params as { type?: string; id?: string };
    if (!value || !/^[1-9]\d*$/.test(value.id ?? '')) throw new PolicyError('ROLLOUT_RESOURCE');
    return RefSchema.parse({ type: value.type, id: Number(value.id) });
  };
  const run = async (request: any, reply: any, operation: 'status' | 'shadow' | 'gate' | 'cutover' | 'confirm' | 'rollback') => {
    const actor = request.user as ActorContext | undefined;
    if (!actor) return reply.code(401).send({ error: 'ROLLOUT_AUTH_REQUIRED' });
    try {
      const resource = ref(request.params);
      await assertAccess(actor, resource, operation !== 'status');
      const coordinator = implementation ?? runtimeCoordinator();
      const audit = { userId: actor.userId, requestId: actor.requestId };
      if (operation === 'status') return await coordinator.status(resource);
      if (operation === 'shadow') {
        const body = ShadowSchema.parse(request.body);
        return await coordinator.startShadow(resource, body.expected_revision, audit);
      }
      if (operation === 'gate') {
        const body = GateSchema.parse(request.body);
        return await coordinator.acceptShadow(resource, body.expected_revision, body.gate, audit);
      }
      if (operation === 'cutover') return await coordinator.cutover(resource, CutoverSchema.parse(request.body), audit);
      if (operation === 'confirm') {
        const body = ConfirmSchema.parse(request.body);
        return await coordinator.confirmApplied(resource, body.expected_revision, audit);
      }
      return await coordinator.rollback(resource, CasSchema.parse(request.body), audit);
    } catch (error) {
      if (error instanceof PolicyError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'ROLLOUT_INPUT_INVALID' });
      if (error instanceof Error && error.message.endsWith('_NOT_FOUND')) return reply.code(404).send({ error: error.message });
      if (error instanceof Error && (error.message.includes('CONFLICT') || error.message.includes('MUST_INCREASE')
        || error.message.includes('GATE') || error.message.includes('NOT_APPLIED') || error.message.includes('PACKAGE_CHANGED')
        || error.message.includes('PHASE'))) return reply.code(409).send({ error: error.message });
      return reply.code(503).send({ error: 'ROLLOUT_UNAVAILABLE' });
    }
  };
  app.get(root, { preHandler: [verifyToken] }, (request, reply) => run(request, reply, 'status'));
  for (const operation of ['shadow', 'gate', 'cutover', 'confirm', 'rollback'] as const) {
    app.post(`${root}/${operation}`, { preHandler: [verifyToken], bodyLimit: 65536 },
      (request, reply) => run(request, reply, operation));
  }

  const runPortfolio = async (request: any, reply: any, operation: 'status' | 'prepare' | 'shadow' | 'cutover' | 'confirm') => {
    const actor = request.user as ActorContext | undefined;
    if (!actor) return reply.code(401).send({ error: 'PORTFOLIO_AUTH_REQUIRED' });
    try {
      const service = portfolio ?? metricPortfolioService();
      if (operation === 'status') return await service.status(actor);
      const { expected_plan_hash: planHash } = PortfolioSchema.parse(request.body);
      return await service[operation](actor, planHash);
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'PORTFOLIO_INPUT_INVALID' });
      if (error instanceof Error && error.message === 'PORTFOLIO_FORBIDDEN') return reply.code(403).send({ error: error.message });
      if (error instanceof Error && error.message === 'PORTFOLIO_PLAN_CHANGED') return reply.code(409).send({ error: error.message });
      return reply.code(503).send({ error: 'PORTFOLIO_UNAVAILABLE' });
    }
  };
  app.get('/api/metrics-v2/rollout/portfolio', { preHandler: [verifyToken] },
    (request, reply) => runPortfolio(request, reply, 'status'));
  for (const operation of ['prepare', 'shadow', 'cutover', 'confirm'] as const) {
    app.post(`/api/metrics-v2/rollout/portfolio/${operation}`, { preHandler: [verifyToken], bodyLimit: 65536 },
      (request, reply) => runPortfolio(request, reply, operation));
  }
}
