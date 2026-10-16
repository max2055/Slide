/** Internal domain route composition. P10 owns public schemas and server
 * registration. Existing JWT/live-session middleware MUST be supplied. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { OperationsError } from '../contracts.js';
import { InvestigationStoreError } from '../../investigations/store.js';
import type { ActionPlanService } from './plan-service.js';

const proposal = z.strictObject({
  content: z.record(z.string(), z.unknown()),
  lifetimeMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60_000)
    .optional(),
});
const revision = proposal.extend({ expectedVersion: z.number().int().positive().safe() });
const version = z.strictObject({ expectedVersion: z.number().int().positive().safe() });
const review = version.extend({
  approvalId: z.string().regex(/^[1-9]\d{0,19}$/),
  action: z.enum(['approve', 'reject']),
  note: z.string().max(1000).optional(),
});
export async function registerActionPlanRoutes(
  app: FastifyInstance,
  verifyToken: (request: any, reply: any) => Promise<unknown>,
  service: ActionPlanService,
): Promise<void> {
  // Encapsulation keeps these safe reason-code errors local to the composition.
  await app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof OperationsError)
        return reply.code(error.statusCode).send({ reasonCode: error.code });
      if (error instanceof InvestigationStoreError)
        return reply.code(error.statusCode).send({ reasonCode: error.code });
      scope.log.error({ err: error }, 'Action plan request failed');
      return reply.code(503).send({ reasonCode: 'OPERATIONS_DEPENDENCY_UNAVAILABLE' });
    });
    scope.addHook('preHandler', verifyToken);
    const actor = (request: any): ActorContext => {
      if (!request.user) throw new OperationsError('OPERATIONS_FORBIDDEN');
      return request.user;
    };
    const body = <T>(schema: z.ZodType<T>, request: any): T => {
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) throw new OperationsError('OPERATIONS_INPUT_INVALID');
      return parsed.data;
    };
    const id = (request: any): string => {
      const value = request.params.id;
      if (typeof value !== 'string' || !value || value.length > 128)
        throw new OperationsError('OPERATIONS_INPUT_INVALID');
      return value;
    };
    scope.post('/api/operations/actions/plans', async (req, reply) => {
      const input = body(proposal, req);
      return reply
        .code(201)
        .send({ plan: await service.create(actor(req), input.content, input.lifetimeMs) });
    });
    scope.get('/api/operations/actions/plans/:id', async (req) => ({
      plan: await service.get(actor(req), id(req)),
    }));
    scope.post('/api/operations/actions/plans/:id/versions', async (req, reply) => {
      const input = body(revision, req);
      return reply.code(201).send({
        plan: await service.revise(
          actor(req),
          { planId: id(req), expectedVersion: input.expectedVersion },
          input.content,
          input.lifetimeMs,
        ),
      });
    });
    scope.post('/api/operations/actions/plans/:id/submit', async (req, reply) => {
      const input = body(version, req);
      return reply.code(201).send(await service.submit(actor(req), { planId: id(req), ...input }));
    });
    scope.post('/api/operations/actions/plans/:id/review', async (req) => {
      const input = body(review, req);
      return { plan: await service.review(actor(req), { planId: id(req), ...input }) };
    });
  });
}
