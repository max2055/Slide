import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { ActorContextService } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { InvestigationAuthorization } from '../investigations/authorization.js';
import { OperationsAuthorization } from './authorization.js';
import { OperationsError } from './contracts.js';
import { operationsFlags } from './feature-flags.js';
import { InvestigationRelationEvidence, PlanSources, PlanStore, type ActionEnvironment } from './actions/plan-store.js';
import { ActionPlanService } from './actions/plan-service.js';
import { registerActionPlanRoutes } from './actions/routes.js';
import { BaselineStore } from './baselines/store.js';
import { formalBaselineSource } from './baselines/source-adapter.js';
import { registerBaselineRoutes } from './baselines/routes.js';
import { AttentionStore } from './attention/store.js';
import { registerAttentionRoutes } from './attention/routes.js';
import { KnowledgeStore } from './knowledge/store.js';
import { KnowledgeService } from './knowledge/service.js';
import { CaseCursorCodec } from './knowledge/search.js';
import { registerKnowledgeRoutes } from './knowledge/routes.js';
import { MysqlRelationStore } from './relations/store.js';
import { RelationService, type RelationEvidence } from './relations/service.js';
import { registerRelationRoutes } from './relations/routes.js';

/** Uses the caller's transaction and the investigation's current membership,
 * complete scope, evidence identity and lifecycle. Unknown namespaces fail closed. */
export function investigationRelationEvidence(investigations: InvestigationAuthorization): RelationEvidence {
  const resolver = new InvestigationRelationEvidence(investigations);
  return { async check(session, actor, relation, now) {
    if (!relation.evidence.length) return 'unavailable';
    for (const ref of relation.evidence) {
      const proof = await resolver.lock(session.connection as never, actor, ref);
      if (!proof) return 'unavailable';
      if (!proof.active || proof.version !== ref.version || proof.hash !== ref.hash
        || !Number.isFinite(Date.parse(proof.validUntil)) || Date.parse(proof.validUntil) <= +now
        || Date.parse(ref.validUntil) <= +now || Date.parse(ref.validUntil) > Date.parse(proof.validUntil)
        || ![relation.source, relation.target].every(endpoint => proof.resources.some(r => r.type === endpoint.type && r.id === endpoint.id))) return 'withdrawn';
    }
    return 'valid';
  } };
}

/** Shared by the real server and isolated HTTP qualification. Construction
 * creates no roles, targets, worker, approval or model call. Preparation-1 has
 * no dispatch registration, even when a deployment sets dispatch=true. */
export function createOperationsComposition(pool: () => Pool | null, options: {
  jwtSecret: string;
  env?: Readonly<Record<string, string | undefined>>;
  actionEnvironment?: ActionEnvironment;
}) {
  if (options.jwtSecret.length < 32) throw new Error('OPERATIONS_CURSOR_SECRET_INVALID');
  const contexts = new ActorContextService(pool as never);
  const authorization = new OperationsAuthorization(contexts);
  const investigations = new InvestigationAuthorization(contexts);
  const evidence = investigationRelationEvidence(investigations);
  const flags = () => Object.freeze({ ...operationsFlags(options.env ?? process.env), dispatch: false });
  const key = createHmac('sha256', options.jwtSecret).update('slide:operations:case-cursor:v1').digest();
  const knowledge = new KnowledgeService(new KnowledgeStore(pool, new CaseCursorCodec(key), authorization, contexts, investigations), flags);
  const relations = new RelationService(new MysqlRelationStore(pool), authorization, evidence, flags);
  const baselines = new BaselineStore(pool, formalBaselineSource, authorization, flags);
  const attention = new AttentionStore(pool, contexts, evidence, {}, flags);
  // Missing P07 environment wiring must never become an allow validator. The
  // current main can expose the contract safely, but cannot create eligible plans.
  const environment: ActionEnvironment = options.actionEnvironment ?? {
    async validate() { throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE'); },
  };
  const plans = new ActionPlanService(new PlanStore({ async getConnection() {
    const current = pool();
    if (!current) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    return await current.getConnection() as never;
  } }), new PlanSources(environment, investigations,
    new InvestigationRelationEvidence(investigations)), authorization, flags);
  return {
    flags, knowledge, relations, baselines, attention, plans,
    actionEnvironmentAvailable: Boolean(options.actionEnvironment),
    async register(app: FastifyInstance) {
      await app.register(async app => {
      app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); });
      const verify = createVerifyToken(options.jwtSecret, contexts);
      await registerRelationRoutes(app, verify, relations);
      await registerKnowledgeRoutes(app, verify, knowledge);
      await registerBaselineRoutes(app, verify, baselines);
      await registerAttentionRoutes(app, verify, attention);
      await registerActionPlanRoutes(app, verify, plans);
      });
    },
  };
}
