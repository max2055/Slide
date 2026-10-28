import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { actorContextService, ActorAuthenticationError, type ActorContext } from '../../auth/actor-context.js';
import { PolicyError, RefSchema } from './model.js';
import { policyService, type PolicyService } from './service.js';

/** Re-reads the live actor after admission and lock waits; production uses the session source. */
export type LiveActor = (actor: ActorContext) => Promise<ActorContext>;
const reloadActor: LiveActor = actor => actorContextService.revalidateActor(actor, actor.requestId);

export async function registerMetricPolicyRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  service: PolicyService = policyService, reload: LiveActor = reloadActor): Promise<void> {
  const ref = (params: unknown) => {
    const p = params as { type: string; id: string };
    if (!/^[1-9]\d*$/.test(p.id)) throw new PolicyError('POLICY_RESOURCE');
    return RefSchema.parse({ type: p.type, id: Number(p.id) });
  };
  const root = '/api/metrics/policy';
  app.get(`${root}/groups`, { preHandler: [verifyToken] }, async (request, reply) => {
    const actor = (request as unknown as {user?: ActorContext}).user;
    if (!actor) return reply.code(401).send({error:'POLICY_AUTH_REQUIRED'});
    const input = z.strictObject({query:z.string().max(128).optional()}).safeParse(request.query);
    if (!input.success) return reply.code(400).send({error:'POLICY_INPUT_INVALID'});
    try { return await service.groups(actor, input.data.query, () => reload(actor)); }
    catch(e) { if (e instanceof PolicyError) return reply.code(e.status).send({error:e.code});
      if (e instanceof ActorAuthenticationError) return reply.code(401).send({error:'POLICY_AUTH_REQUIRED'});
      return reply.code(503).send({error:'POLICY_STORE_UNAVAILABLE'}); }
  });
  const routes: Array<{ method: 'GET' | 'POST'; url: string; run: (actor: ActorContext, params: any, body: unknown,
    check: () => Promise<ActorContext>) => Promise<unknown> }> = [
    { method: 'GET', url: `${root}/resources/:type/:id`, run: (a, p, _b, check) => service.binding(a, ref(p), check) },
    { method: 'GET', url: `${root}/resources/:type/:id/effective`, run: (a, p, _b, check) => service.effective(a, ref(p), check) },
    { method: 'GET', url: `${root}/resources/:type/:id/audit`, run: (a, p, _b, check) => service.audits(a, ref(p), undefined, check) },
    { method: 'POST', url: `${root}/resources/:type/:id/preview`, run: (a, p, b, check) => service.changeBinding(a, ref(p), b, false, undefined, false, check) },
    { method: 'POST', url: `${root}/resources/:type/:id/publish`, run: (a, p, b, check) => service.changeBinding(a, ref(p), b, true, undefined, false, check) },
    { method: 'GET', url: `${root}/groups/:id/access`, run: (a, p, _b, check) => service.groupPermissions(a, p.id, check) },
    { method: 'GET', url: `${root}/groups/:id`, run: (a, p, _b, check) => service.group(a, p.id, check) },
    { method: 'POST', url: `${root}/groups/:id/preview`, run: (a, p, b, check) => service.changeGroup(a, p.id, b, false, check) },
    { method: 'POST', url: `${root}/groups/:id/publish`, run: (a, p, b, check) => service.changeGroup(a, p.id, b, true, check) },
  ];
  for (const route of routes) app.route({ method: route.method, url: route.url, preHandler: [verifyToken], bodyLimit: 65536,
    handler: async (request, reply) => {
      const actor = (request as unknown as { user?: ActorContext }).user;
      if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
      try { return await route.run(actor, request.params, request.body, () => reload(actor)); }
      catch (error) {
        // A revoked session is re-authentication, not a policy refusal.
        if (error instanceof ActorAuthenticationError) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
        if (error instanceof PolicyError) return reply.code(error.status).send({ error: error.code });
        if (error instanceof z.ZodError) return reply.code(400).send({ error: 'POLICY_INPUT_INVALID' });
        if (error instanceof Error && error.message === 'PACKAGE_PIN') return reply.code(400).send({ error: 'POLICY_PACKAGE_PIN' });
        return reply.code(500).send({ error: 'POLICY_FAILED' });
      }
    },
  });
}
