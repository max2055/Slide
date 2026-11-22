import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { ActorAuthenticationError, type ActorContext } from '../../auth/actor-context.js';
import { PolicyError, RefSchema, rule, type Ref } from '../policy/model.js';
import type { PolicyService } from '../policy/service.js';
import type { MetricConfigurationService } from './service.js';
import { configurationReader } from './status-store.js';

/** Exercise the package status renderer against the same persisted evidence as the application. */
export function legacyConfigurationReader(pool: () => Pool) {
  const { inventory, evidence } = configurationReader(pool);
  return { inventory, evidence };
}

type ResourceParams = { type: string; id: string; key: string };
type Run = (actor: ActorContext, ref: Ref, params: ResourceParams, body: unknown) => Promise<unknown>;

function registerPackageRoute(app: FastifyInstance, verifyToken: preHandlerHookHandler, method: 'GET' | 'POST',
  url: string, run: Run, failure = 'POLICY_FAILED') {
  app.route({ method, url, preHandler: [verifyToken], bodyLimit: 65536, handler: async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const actor = (request as unknown as { user?: ActorContext }).user;
    if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
    try {
      const params = request.params as ResourceParams;
      rule(/^[1-9]\d*$/.test(params.id), 'POLICY_RESOURCE');
      return await run(actor, RefSchema.parse({ type: params.type, id: Number(params.id) }), params, request.body);
    } catch (error) {
      if (error instanceof ActorAuthenticationError) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
      if (error instanceof PolicyError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'POLICY_INPUT_INVALID' });
      if (error instanceof Error && error.message === 'PACKAGE_PIN') return reply.code(400).send({ error: 'POLICY_PACKAGE_PIN' });
      return reply.code(500).send({ error: failure });
    }
  } });
}

/** Retired HTTP paths mounted by the disposable MySQL transport tests. */
export function registerPackageConfigurationTestRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  service: MetricConfigurationService) {
  const root = '/api/metrics/config/resources/:type/:id';
  registerPackageRoute(app, verifyToken, 'POST', `${root}/activate`,
    (actor, ref, _params, body) => service.activate(actor, ref, body), 'TRIAL_FAILED');
  registerPackageRoute(app, verifyToken, 'GET', `${root}/operations/:key`,
    (actor, ref, params) => service.operation(actor, ref, params.key));
}

/** Reuse PolicyService's real transaction and post-lock permission checks. */
export function registerPackagePolicyTestRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  service: PolicyService, reload: (actor: ActorContext) => Promise<ActorContext>) {
  const root = '/api/metrics/policy/resources/:type/:id';
  registerPackageRoute(app, verifyToken, 'GET', root,
    (actor, ref) => service.binding(actor, ref, () => reload(actor)));
  registerPackageRoute(app, verifyToken, 'GET', `${root}/effective`,
    (actor, ref) => service.effective(actor, ref, () => reload(actor)));
  registerPackageRoute(app, verifyToken, 'GET', `${root}/audit`,
    (actor, ref) => service.audits(actor, ref, undefined, () => reload(actor)));
  registerPackageRoute(app, verifyToken, 'POST', `${root}/preview`,
    (actor, ref, _params, body) => service.changeBinding(actor, ref, body, false, undefined, false, () => reload(actor)));
  registerPackageRoute(app, verifyToken, 'POST', `${root}/publish`,
    (actor, ref, _params, body) => service.changeBinding(actor, ref, body, true, undefined, false, () => reload(actor)));
}
