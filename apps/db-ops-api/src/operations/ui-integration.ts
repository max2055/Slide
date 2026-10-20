/** B15 thin domain ports. No dispatcher, model invocation or client-supplied registration. */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ActorContextService, type ActorContext } from '../auth/actor-context.js';
import { hasPermission } from '../auth/require-permission.js';
import { freezeInvestigationCaller, InvestigationAuthorization } from '../investigations/authorization.js';
import { InvestigationStoreError } from '../investigations/store.js';
import { resultEvidenceIds } from '../investigations/result-schema.js';
import { OperationsError, operationsContentHash } from './contracts.js';
import { approvalAuthority } from './actions/approval-binding.js';
import { ActionPlanService } from './actions/plan-service.js';
import { PlanStore, planRows, decodePlanJson } from './actions/plan-store.js';
import { CaseCursorCodec } from './knowledge/search.js';
import { KnowledgeService } from './knowledge/service.js';

export const planDiscoverySchema = z.strictObject({ planId: z.string().uuid().optional(), investigationId: z.string().uuid().optional(),
  state: z.enum(['draft','pending_approval','approved','rejected','expired','superseded']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(2048).optional() });
export const trustedDraftSchema = z.strictObject({ investigationId: z.string().uuid(), resultVersion: z.number().int().positive(),
  targetId: z.number().int().positive(), impact: z.string().trim().min(1).max(2000) });
export const manualCaseBindingSchema = z.strictObject({ investigationId: z.string().uuid(), resultVersion: z.number().int().positive(),
  expectedVersion: z.number().int().positive(), version: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  applicabilityConfirmed: z.literal(true) });
export interface TrustedActionProposal {
  proposal(targetId: number): Promise<Record<string, unknown> & { validUntil: string }>;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new OperationsError('OPERATIONS_INPUT_INVALID');
  return result.data;
}
export class OperationsUiIntegration {
  constructor(readonly store: PlanStore, readonly plans: ActionPlanService, readonly knowledge: KnowledgeService,
    readonly cursors: CaseCursorCodec, readonly environment?: TrustedActionProposal,
    private readonly contexts = new ActorContextService(), private readonly investigations = new InvestigationAuthorization()) {}
  async discover(caller: ActorContext, input: unknown) {
    const q = parse(planDiscoverySchema, input), { cursor: _cursor, ...filter } = q;
    caller = freezeInvestigationCaller(caller);
    return this.store.transaction(async c => {
      const current = await this.contexts.loadInvestigationActorFrom(c, caller.userId, caller.principalKind ?? 'user', caller.sessionVersion, caller.requestId);
      if (![caller,current].every(a => hasPermission(new Set(a.permissions),'operations:actions:view')))
        throw new OperationsError('OPERATIONS_NOT_FOUND');
      const now = await this.store.now(c), fingerprint = operationsContentHash(filter), authority = operationsContentHash([approvalAuthority(caller),approvalAuthority(current)]);
      const position = q.cursor ? this.cursors.decode(q.cursor, fingerprint, authority, +now) : null;
      if (q.investigationId) {
        const inv = await this.investigations.load(c,q.investigationId);
        await this.investigations.authorize(c,caller,inv,'content');
      }
      // Bounded scan; invisible records contribute no count or identifier. The
      // encrypted continuation is filter/authority bound, never a global ordinal.
      const candidates = await planRows(c, `SELECT id FROM action_plans WHERE id>? AND created_at<=?
        ${q.investigationId ? 'AND investigation_id=?' : ''} ${q.planId ? 'AND id=?' : ''} ORDER BY id LIMIT 301 FOR SHARE`,
        [position?.after ?? '', new Date(position?.asOf ?? now), ...(q.investigationId ? [q.investigationId] : []), ...(q.planId ? [q.planId] : [])]);
      const items = []; let scanned = '', consumed = 0;
      for (const row of candidates.slice(0,300)) {
        scanned = row.id; consumed++;
        try {
          const plan = await this.plans.readIn(c,caller,row.id);
          if (q.state && plan.state !== q.state) continue;
          const executions = await planRows(c,'SELECT id,plan_version,state FROM action_executions WHERE plan_id=? ORDER BY created_at DESC LIMIT 20 FOR SHARE',[plan.id]);
          const [approval]=await planRows(c,`SELECT id,status FROM agent_tool_approvals WHERE tool_name='operations_action_plan'
            AND JSON_UNQUOTE(JSON_EXTRACT(args_redacted,'$.planId'))=?
            AND JSON_EXTRACT(args_redacted,'$.version')=?
            AND JSON_UNQUOTE(JSON_EXTRACT(args_redacted,'$.contentHash'))=? ORDER BY id DESC LIMIT 1 FOR SHARE`,[plan.id,plan.version,plan.contentHash]);
          items.push({ ...plan, approvalId:approval?String(approval.id):null, executions: executions.map(e => ({id:e.id,planVersion:Number(e.plan_version),state:e.state})) });
          if (items.length === q.limit) break;
        } catch (error) {
          if ((error instanceof OperationsError || error instanceof InvestigationStoreError) && [403,404].includes(error.statusCode)) continue;
          throw error;
        }
      }
      const more = consumed < candidates.length;
      return { items, authorizedCounts: { total: items.length }, countScope: 'page' as const, partial: more,
        nextCursor: more && scanned ? this.cursors.encode({after:scanned,asOf:position?.asOf ?? now.toISOString(),filter:fingerprint,authority,expires:+now+300000}) : null };
    });
  }
  async draft(caller: ActorContext, input: unknown) {
    const q = parse(trustedDraftSchema,input);
    if (!this.environment) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    const material = await this.store.transaction(async c => {
      const inv = await this.investigations.load(c,q.investigationId);
      await this.investigations.authorize(c,caller,inv,'continue');
      if (!inv.resources.some(r => r.type === 'server' && r.id === q.targetId)) throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      const [result] = await planRows(c,'SELECT * FROM investigation_results WHERE investigation_id=? ORDER BY version DESC LIMIT 1 FOR SHARE',[q.investigationId]);
      if (Number(result?.version) !== q.resultVersion) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
      const ids = resultEvidenceIds(decodePlanJson(result.result_json));
      if (!ids.length || ids.length>100) throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      const evidence = [];
      for (const id of ids) {
        const [proof] = await planRows(c,`SELECT * FROM investigation_evidence WHERE id=? AND investigation_id=? AND request_id=? AND run_id=?
          AND expired_at IS NULL AND expires_at>UTC_TIMESTAMP(3) FOR SHARE`,[id,q.investigationId,result.request_id,result.run_id]);
        if (!proof) throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
        evidence.push({id,version:1,hash:proof.content_hash,validUntil:new Date(proof.expires_at).toISOString()});
      }
      return evidence;
    });
    const { validUntil, ...registration } = await this.environment.proposal(q.targetId);
    const lifetime = Math.min(600000,Date.parse(validUntil)-Date.now(),...material.map(e=>Date.parse(e.validUntil)-Date.now()));
    if (lifetime<1000) throw new OperationsError('OPERATIONS_EXPIRED');
    // create() repeats latest result/source/full ACL/environment validation under
    // its own atomic write transaction; these read facts never grant authority.
    return this.plans.create(caller,{...registration,schemaVersion:1,investigationId:q.investigationId,
      resultVersion:q.resultVersion,target:{type:'server',id:q.targetId},impact:q.impact,evidence:material,relations:[],baselines:[]},Math.floor(lifetime)-500);
  }
}
export async function registerOperationsUiRoutes(app: FastifyInstance, verify: (r:any,p:any)=>Promise<unknown>, service: OperationsUiIntegration) {
  await app.register(async scope => {
    scope.addHook('preHandler',verify);
    scope.addHook('onRequest',async(_r,p)=>{p.header('Cache-Control','private, no-store');});
    scope.setErrorHandler((error,_r,p)=>p.code(error instanceof OperationsError || error instanceof InvestigationStoreError ? error.statusCode : 503)
      .send({reasonCode:error instanceof OperationsError || error instanceof InvestigationStoreError ? error.code : 'OPERATIONS_DEPENDENCY_UNAVAILABLE'}));
    const actor = (r:any):ActorContext => { if(!r.user)throw new OperationsError('OPERATIONS_FORBIDDEN');return r.user; };
    scope.get('/api/operations/actions/plans', r=>service.discover(actor(r),r.query));
    scope.post('/api/operations/actions/drafts',async(r,p)=>p.code(201).send({plan:await service.draft(actor(r),r.body)}));
    scope.post('/api/operations/knowledge/:id/bind',async(r,p)=>p.code(201).send(await service.knowledge.bind(actor(r),(r.params as any).id,parse(manualCaseBindingSchema,r.body))));
  });
}
