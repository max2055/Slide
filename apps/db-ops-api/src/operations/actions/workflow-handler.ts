import { z } from 'zod';
import type { ClaimedJob } from '../../workflows/worker-runtime.js';
import { OperationsError } from '../contracts.js';
import type { ActionExecutor } from './executor.js';

/** P10 registers this ONLY on the independent action worker, never the read-only
 * investigation dispatcher. Workflow delivery grants no action authority. The
 * executor loads persisted requester ceilings, once intent, lease and fence. */
export function actionWorkflowHandler(executor: ActionExecutor, workerId: string) {
  return async (job: ClaimedJob): Promise<void> => {
    const parsed = z.strictObject({ executionId: z.string().uuid() }).safeParse(job.payload);
    if (job.type !== 'operations.action.execute' || !parsed.success)
      throw new OperationsError('OPERATIONS_INPUT_INVALID');
    await executor.run(parsed.data.executionId, workerId);
  };
}

import type { FastifyInstance } from 'fastify';
import type { ActorContext } from '../../auth/actor-context.js';
import { InvestigationStoreError } from '../../investigations/store.js';
import type { ActionExecutionStore } from './execution-store.js';

/** Domain-only registration. P10 owns public contract generation and server
 * assembly with existing JWT/live-session middleware. GET never enqueues. */
export async function registerActionExecutionRoutes(
  app: FastifyInstance,
  verifyToken: (request: any, reply: any) => Promise<unknown>,
  store: ActionExecutionStore,
  executor: ActionExecutor,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('preHandler', verifyToken);
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof OperationsError || error instanceof InvestigationStoreError)
        return reply.code(error.statusCode).send({ reasonCode: error.code });
      return reply.code(503).send({ reasonCode: 'OPERATIONS_DEPENDENCY_UNAVAILABLE' });
    });
    const caller = (r: any): ActorContext => {
      if (!r.user) throw new OperationsError('OPERATIONS_FORBIDDEN');
      return r.user;
    };
    const id = (r: any): string => {
      const parsed = z.string().uuid().safeParse(r.params.id);
      if (!parsed.success) throw new OperationsError('OPERATIONS_INPUT_INVALID');
      return parsed.data;
    };
    const empty = (r: any) => {
      if (r.body != null && !z.strictObject({}).safeParse(r.body).success)
        throw new OperationsError('OPERATIONS_INPUT_INVALID');
    };
    scope.post('/api/operations/action-plans/:id/versions/:version/execute', async (req, reply) => {
      const r = req as any;
      const parsed = z
        .strictObject({
          approvalId: z.string().regex(/^[1-9]\d{0,19}$/),
          requestKey: z.string().min(1).max(128),
        })
        .safeParse(req.body);
      const version = z
        .string()
        .regex(/^[1-9]\d{0,14}$/)
        .safeParse(r.params.version);
      if (!parsed.success || !version.success)
        throw new OperationsError('OPERATIONS_INPUT_INVALID');
      return reply
        .code(202)
        .send({
          execution: await store.enqueue(caller(req), {
            ...parsed.data,
            planId: id(req),
            expectedVersion: Number(version.data),
          }),
        });
    });
    scope.get('/api/operations/action-executions/:id', async (req) => ({
      execution: await store.get(caller(req), id(req)),
    }));
    scope.post('/api/operations/action-executions/:id/cancel', async (req) => {
      empty(req);
      return { execution: await store.cancel(caller(req), id(req)) };
    });
    scope.post('/api/operations/action-executions/:id/reconcile', async (req) => {
      empty(req);
      return { execution: await executor.reconcile(caller(req), id(req)) };
    });
  });
}
