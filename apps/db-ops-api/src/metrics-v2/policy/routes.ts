import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { PolicyError, RefSchema } from './model.js';
import { policyService, type PolicyService } from './service.js';

export async function registerMetricPolicyRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler, service: PolicyService = policyService): Promise<void> {
  const ref = (params: unknown) => {
    const p = params as { type: string; id: string };
    if (!/^[1-9]\d*$/.test(p.id)) throw new PolicyError('POLICY_RESOURCE');
    return RefSchema.parse({ type: p.type, id: Number(p.id) });
  };
  const root = '/api/metrics-v2/policy';
  const routes: Array<{ method: 'GET' | 'POST'; url: string; run: (actor: ActorContext, params: any, body: unknown) => Promise<unknown> }> = [
    { method: 'GET', url: `${root}/resources/:type/:id`, run: (a, p) => service.binding(a, ref(p)) },
    { method: 'GET', url: `${root}/resources/:type/:id/effective`, run: (a, p) => service.effective(a, ref(p)) },
    { method: 'GET', url: `${root}/resources/:type/:id/audit`, run: (a, p) => service.audits(a, ref(p)) },
    { method: 'POST', url: `${root}/resources/:type/:id/preview`, run: (a, p, b) => service.changeBinding(a, ref(p), b, false) },
    { method: 'POST', url: `${root}/resources/:type/:id/publish`, run: (a, p, b) => service.changeBinding(a, ref(p), b, true) },
    { method: 'GET', url: `${root}/groups/:id/access`, run: (a, p) => service.groupPermissions(a, p.id) },
    { method: 'GET', url: `${root}/groups/:id`, run: (a, p) => service.group(a, p.id) },
    { method: 'POST', url: `${root}/groups/:id/preview`, run: (a, p, b) => service.changeGroup(a, p.id, b, false) },
    { method: 'POST', url: `${root}/groups/:id/publish`, run: (a, p, b) => service.changeGroup(a, p.id, b, true) },
  ];
  for (const route of routes) app.route({ method: route.method, url: route.url, preHandler: [verifyToken], bodyLimit: 65536,
    handler: async (request, reply) => {
      const actor = (request as unknown as { user?: ActorContext }).user;
      if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
      try { return await route.run(actor, request.params, request.body); }
      catch (error) {
        if (error instanceof PolicyError) return reply.code(error.status).send({ error: error.code });
        if (error instanceof z.ZodError) return reply.code(400).send({ error: 'POLICY_INPUT_INVALID' });
        if (error instanceof Error && error.message === 'PACKAGE_PIN') return reply.code(400).send({ error: 'POLICY_PACKAGE_PIN' });
        return reply.code(500).send({ error: 'POLICY_FAILED' });
      }
    },
  });
}
