/** Internal registration ports. Public schema generation/server/worker assembly belongs to P10. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import type { ClaimedJob } from '../../workflows/worker-runtime.js';
import { InvestigationStoreError } from '../../investigations/store.js';
import { OperationsError } from '../contracts.js';
import { actionWorkflowHandler } from './workflow-handler.js';
import type { ActionExecutor } from './executor.js';
import type { ActionVerificationService } from './verification-service.js';

export function verificationWorkflowHandler(
  service: Pick<ActionVerificationService, 'prepare' | 'run' | 'store'>,
  persistedCaller: (executionId: string) => Promise<ActorContext>,
) {
  return async (job: ClaimedJob): Promise<void> => {
    const p = z.strictObject({ executionId: z.string().uuid() }).safeParse(job.payload);
    if (job.type !== 'operations.action.verify' || !p.success)
      throw new OperationsError('OPERATIONS_INPUT_INVALID');
    // Composition loads the persisted authority ceiling, never a worker-admin identity.
    await service.run(await persistedCaller(p.data.executionId), p.data.executionId);
  };
}
/** P10 can register this wrapper on the independent action worker to guarantee
 * pre-registration precedes the P07 dispatcher, without changing its once/fence logic. */
export function verifiedActionWorkflowHandler(
  service: Pick<ActionVerificationService, 'prepare' | 'run' | 'store'>,
  executor: ActionExecutor,
  workerId: string,
  persistedCaller: (executionId: string) => Promise<ActorContext>,
) {
  const execute = actionWorkflowHandler(executor, workerId);
  return async (job: ClaimedJob): Promise<void> => {
    const parsed = z.strictObject({ executionId: z.string().uuid() }).safeParse(job.payload);
    if (job.type !== 'operations.action.execute' || !parsed.success)
      throw new OperationsError('OPERATIONS_INPUT_INVALID');
    const actor = await persistedCaller(parsed.data.executionId);
    await service.prepare(actor, parsed.data.executionId);
    await execute(job);
    await service.run(actor, parsed.data.executionId);
  };
}
export async function registerActionVerificationRoutes(
  app: FastifyInstance,
  verifyToken: (request: any, reply: any) => Promise<unknown>,
  service: Pick<ActionVerificationService, 'prepare' | 'run' | 'store'>,
) {
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (_req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
    });
    scope.addHook('preHandler', verifyToken);
    scope.setErrorHandler((e, _req, reply) => {
      if (e instanceof OperationsError || e instanceof InvestigationStoreError)
        return reply.code(e.statusCode).send({ reasonCode: e.code });
      return reply.code(503).send({ reasonCode: 'OPERATIONS_DEPENDENCY_UNAVAILABLE' });
    });
    const input = (r: any) => {
      const id = z.string().uuid().safeParse(r.params.id);
      if (!id.success) throw new OperationsError('OPERATIONS_INPUT_INVALID');
      if (!r.user) throw new OperationsError('OPERATIONS_FORBIDDEN');
      return { id: id.data, actor: r.user as ActorContext };
    };
    scope.post('/api/operations/action-executions/:id/verification', async (req, reply) => {
      const { actor, id } = input(req);
      if (req.body != null && !z.strictObject({}).safeParse(req.body).success)
        throw new OperationsError('OPERATIONS_INPUT_INVALID');
      return reply.code(201).send({ verification: await service.prepare(actor, id) });
    });
    scope.get('/api/operations/action-executions/:id/verification', async (req) => {
      const { actor, id } = input(req);
      return { verification: await service.store.get(actor, id) };
    });
    scope.get(
      '/api/operations/action-executions/:id/verification/versions/:version',
      async (req) => {
        const { actor, id } = input(req);
        const version = z
          .string()
          .regex(/^[1-9]\d{0,14}$/)
          .safeParse((req.params as any).version);
        if (!version.success) throw new OperationsError('OPERATIONS_INPUT_INVALID');
        return { verification: await service.store.get(actor, id, Number(version.data)) };
      },
    );
  });
}
