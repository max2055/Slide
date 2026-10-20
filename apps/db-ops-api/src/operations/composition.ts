import { ActionExecutionStore } from './actions/execution-store.js';
import { ActionExecutor, type ActionAdapter } from './actions/executor.js';
import { ActionVerificationStore } from './actions/verification-store.js';
import { ActionVerificationService, type VerificationClock } from './actions/verification-service.js';
import { type ActionEvidenceAdapter } from './actions/evidence-adapter.js';
import { registerActionExecutionRoutes } from './actions/workflow-handler.js';
import { registerActionVerificationRoutes } from './actions/verification-handler.js';
import { actionRuntimeConfigured, loadActionRuntimePorts, registeredActionAdapter } from './actions/runtime-ports.js';
import { OperationsUiIntegration, registerOperationsUiRoutes, type TrustedActionProposal } from './ui-integration.js';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { ActorContextService } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { InvestigationAuthorization } from '../investigations/authorization.js';
import { InvestigationStoreError } from '../investigations/store.js';
import { OperationsAuthorization } from './authorization.js';
import { OperationsError } from './contracts.js';
import { operationsFlags } from './feature-flags.js';
import { RegisteredActionEnvironment } from './action-environment.js';
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
      const proof = await resolver.lock(session.connection as never, actor, ref).catch(error => {
        // An inaccessible source contributes no fact, including when only an
        // investigation resource outside the relation endpoints was revoked.
        if (error instanceof InvestigationStoreError && error.statusCode === 404) return null;
        throw error;
      });
      if (!proof) return 'unavailable';
      if (!proof.active || proof.id !== ref.id || proof.version !== ref.version || proof.hash !== ref.hash
        || !Number.isFinite(Date.parse(proof.validUntil)) || Date.parse(proof.validUntil) <= +now
        || Date.parse(ref.validUntil) <= +now || Date.parse(ref.validUntil) > Date.parse(proof.validUntil)
        // Each cited proof must cover both endpoints itself. Do not pool
        // incomplete proofs or use the investigation's additional ACL scope.
        || ![relation.source, relation.target].every(endpoint => proof.evidenceResources.some(r => r.type === endpoint.type && r.id === endpoint.id))) return 'withdrawn';
    }
    return 'valid';
  } };
}

/** Shared by the real server and isolated HTTP qualification. Construction
 * creates no roles, targets, approval or model call. Action handlers are consumed
 * only by the independent worker; deployments default to disabled. */
export function createOperationsComposition(pool: () => Pool | null, options: {
  jwtSecret: string;
  env?: Readonly<Record<string, string | undefined>>;
  actionEnvironment?: ActionEnvironment & Partial<TrustedActionProposal>;
  /** Trusted process-local test/embedding ports; never populated from HTTP. */
  actionPorts?: { adapter: ActionAdapter; evidence: ActionEvidenceAdapter; clock?: VerificationClock };
}) {
  if (options.jwtSecret.length < 32) throw new Error('OPERATIONS_CURSOR_SECRET_INVALID');
  const contexts = new ActorContextService(pool as never);
  const authorization = new OperationsAuthorization(contexts);
  const investigations = new InvestigationAuthorization(contexts);
  const evidence = investigationRelationEvidence(investigations);
  const env = options.env ?? process.env;
  const flags = () => {
    const current = operationsFlags(env);
    return Object.freeze({ ...current, dispatch: current.dispatch && Boolean(options.actionPorts || actionRuntimeConfigured(env)) });
  };
  const key = createHmac('sha256', options.jwtSecret).update('slide:operations:case-cursor:v1').digest();
  const knowledge = new KnowledgeService(new KnowledgeStore(pool, new CaseCursorCodec(key), authorization, contexts, investigations), flags);
  const relations = new RelationService(new MysqlRelationStore(pool), authorization, evidence, flags);
  const baselines = new BaselineStore(pool, formalBaselineSource, authorization, flags);
  const attention = new AttentionStore(pool, contexts, evidence, {}, flags);
  const environment = options.actionEnvironment ?? new RegisteredActionEnvironment(options.env ?? process.env);
  const planStore = new PlanStore({ async getConnection() {
    const current = pool();
    if (!current) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    return await current.getConnection() as never;
  } });
  const sources = new PlanSources(environment, investigations, new InvestigationRelationEvidence(investigations));
  const plans = new ActionPlanService(planStore, sources, authorization, flags);
  const executions = new ActionExecutionStore(planStore, sources, plans, authorization);
  const executor = new ActionExecutor(executions, sources, options.actionPorts?.adapter ?? registeredActionAdapter(env), authorization, flags);
  const reports = new ActionVerificationStore(planStore, sources, authorization);
  const verification = {
    store: reports,
    async prepare(actor: Parameters<ActionVerificationService['prepare']>[0], id: string) {
      const ports = options.actionPorts ?? await loadActionRuntimePorts(env);
      return new ActionVerificationService(reports, ports.evidence, 'clock' in ports ? ports.clock : undefined).prepare(actor, id);
    },
    async run(actor: Parameters<ActionVerificationService['run']>[0], id: string) {
      const ports = options.actionPorts ?? await loadActionRuntimePorts(env);
      return new ActionVerificationService(reports, ports.evidence, 'clock' in ports ? ports.clock : undefined).run(actor, id);
    },
  };
  const persistedCaller = (id: string) => executions.transaction(async c => executions.actor(c, await executions.load(c, id)));
  const ui = new OperationsUiIntegration(new PlanStore({getConnection:async()=>{const p=pool();if(!p)throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');return await p.getConnection() as never;}}), plans,knowledge,new CaseCursorCodec(key), 'proposal' in environment ? environment as TrustedActionProposal : undefined, contexts,investigations);
  const registerActions = async (app: FastifyInstance, verify: ReturnType<typeof createVerifyToken>) => {
    await registerActionPlanRoutes(app, verify, plans);
    await registerActionExecutionRoutes(app, verify, executions, executor);
    await registerActionVerificationRoutes(app, verify, verification);
    await registerOperationsUiRoutes(app, verify, ui);
  };
  return {
    flags, knowledge, relations, baselines, attention, plans, ui, executions, executor, reports, verification, persistedCaller,
    /** Same formal action boundary for hosts that already own context routes. */
    async registerActions(app: FastifyInstance) {
      await app.register(async scope => {
        scope.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); });
        await registerActions(scope, createVerifyToken(options.jwtSecret, contexts));
      });
    },
    actionEnvironmentAvailable: Boolean(options.actionEnvironment || ((options.env ?? process.env).OPERATIONS_PILOT_MANIFEST_FILE
      && (options.env ?? process.env).OPERATIONS_PILOT_PUBLIC_KEY_FILE && (options.env ?? process.env).OPERATIONS_PILOT_SSH_KEY_FILE)),
    async register(app: FastifyInstance) {
      await app.register(async app => {
      app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); });
      const verify = createVerifyToken(options.jwtSecret, contexts);
      await registerRelationRoutes(app, verify, relations);
      await registerKnowledgeRoutes(app, verify, knowledge);
      await registerBaselineRoutes(app, verify, baselines);
      await registerAttentionRoutes(app, verify, attention);
      await registerActions(app, verify);
      });
    },
  };
}
