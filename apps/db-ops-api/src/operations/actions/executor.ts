import { z } from 'zod';
import { ActorContextService } from '../../auth/actor-context.js';
import { freezeInvestigationCaller } from '../../investigations/authorization.js';
import { OperationsAuthorization } from '../authorization.js';
import { OperationsError, operationsContentHash, type ActionPlanVersion } from '../contracts.js';
import {
  assertOperationsEnabled,
  operationsFlags,
  type OperationsFlags,
} from '../feature-flags.js';
import {
  ACTION_APPROVAL_KIND,
  ACTION_APPROVAL_TOOL,
  actionApprovalHash,
  approvalAuthority,
  authorityCaller,
  assertPlanFresh,
  type ApprovalAuthority,
} from './approval-binding.js';
import { PlanSources, planRows, decodePlanJson, type PlanConnection } from './plan-store.js';
import {
  ActionExecutionStore,
  type ExecutionLease,
  type ExecutionRecord,
} from './execution-store.js';

export interface ActionInvocation {
  readonly executionId: string;
  readonly operationId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly planHash: string;
  readonly serverId: number;
  readonly toolHash: string;
  readonly configHash: string;
}
const capabilities = new WeakSet<object>();
/** Single-use process-local capability. Plain JSON, generic approval tokens,
 * Chat and investigation tool contexts cannot authorize a target write. */
export function consumeActionInvocation(input: unknown): asserts input is ActionInvocation {
  if (!input || typeof input !== 'object' || !capabilities.delete(input))
    throw new OperationsError('OPERATIONS_FORBIDDEN');
}
const receiptSchema = z.strictObject({
  protocol: z.literal(1),
  operationId: z.string().uuid(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  unit: z.literal('slide-action-demo.service'),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  helperHash: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(['succeeded', 'not_executed', 'outcome_unknown']),
  before: z.string().regex(/^[a-f0-9]{32}$/),
  after: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable(),
});
export type ActionReceipt = z.infer<typeof receiptSchema>;
export interface ActionAdapter {
  /** Fixed-target read-only identity/config preflight. No restart. */
  preflight(plan: ActionPlanVersion): Promise<void>;
  execute(invocation: ActionInvocation): Promise<unknown>;
  receipt(plan: ActionPlanVersion, operationId: string): Promise<unknown>;
}
export function actionConfigHash(plan: ActionPlanVersion): string {
  const conditions = plan.content.preconditions;
  if (
    conditions.length !== 1 ||
    conditions[0].kind !== 'target_config_hash' ||
    !/^[a-f0-9]{64}$/.test(conditions[0].expected)
  )
    throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
  return conditions[0].expected;
}
export function checkedActionReceipt(
  value: unknown,
  e: ExecutionRecord,
  p: ActionPlanVersion,
): ActionReceipt {
  const r = receiptSchema.safeParse(value);
  if (
    !r.success ||
    r.data.operationId !== e.operationId ||
    r.data.planHash !== p.contentHash ||
    r.data.helperHash !== p.content.tool.hash ||
    r.data.configHash !== actionConfigHash(p) ||
    (r.data.outcome === 'succeeded' && (!r.data.after || r.data.after === r.data.before))
  )
    throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
  return r.data;
}
/** Independent action worker. No investigation or general write-tool execution. */
export class ActionExecutor {
  constructor(
    private readonly store: ActionExecutionStore,
    private readonly sources: PlanSources,
    private readonly adapter: ActionAdapter,
    private readonly authorization = new OperationsAuthorization(),
    private readonly flags: () => Readonly<OperationsFlags> = operationsFlags,
  ) {}
  private async live(
    c: PlanConnection,
    snapshot: ApprovalAuthority,
    expected: string,
  ): Promise<void> {
    if (!snapshot || !expected) throw new OperationsError('OPERATIONS_FORBIDDEN');
    const actor = await new ActorContextService().loadInvestigationActorFrom(
      c,
      snapshot.userId,
      snapshot.principalKind,
      snapshot.sessionVersion,
      'action-dispatch',
    );
    if (operationsContentHash(approvalAuthority(actor)) !== expected)
      throw new OperationsError('OPERATIONS_FORBIDDEN');
  }
  private async check(c: PlanConnection, e: ExecutionRecord, p: ActionPlanVersion): Promise<void> {
    assertOperationsEnabled(this.flags(), 'dispatch');
    if (p.state !== 'approved') throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    const [a] = await planRows(c, 'SELECT * FROM agent_tool_approvals WHERE id=? FOR UPDATE', [
      e.approvalId,
    ]);
    const [b] = await planRows(
      c,
      'SELECT * FROM action_approval_bindings WHERE approval_id=? FOR UPDATE',
      [e.approvalId],
    );
    const policy = decodePlanJson(a?.policy_snapshot);
    if (
      !a ||
      !b ||
      a.tool_name !== ACTION_APPROVAL_TOOL ||
      a.status !== 'consumed' ||
      a.scope !== 'once' ||
      Number(a.used_count) !== 1 ||
      !b.consumed_at ||
      b.plan_id !== p.id ||
      Number(b.plan_version) !== p.version ||
      b.content_hash !== p.contentHash ||
      b.policy_version !== p.content.policyVersion ||
      b.approval_mode !== 'once' ||
      Number(b.author_id) !== p.content.author.id ||
      Number(b.requester_id) !== p.content.requester.id ||
      policy?.kind !== ACTION_APPROVAL_KIND ||
      policy.proposer?.userId !== p.content.requester.id ||
      policy.proposer?.principalKind !== p.content.requester.kind ||
      Number(a.requester_id) !== p.content.requester.id ||
      policy.reviewer?.userId !== Number(a.reviewer_id) ||
      Number(b.reviewer_id) !== Number(a.reviewer_id) ||
      new Date(b.expires_at).getTime() !== new Date(a.expires_at).getTime() ||
      new Date(a.expires_at).getTime() <= +(await this.store.plans.now(c)) ||
      a.binding_hash !== actionApprovalHash(p, policy.proposer, policy.proposerLiveHash)
    )
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    await this.live(c, policy.proposer, policy.proposerLiveHash);
    await this.live(c, policy.reviewer, policy.reviewerLiveHash);
    const now = await this.store.plans.now(c);
    assertPlanFresh(p, now);
    const executor = await this.store.actor(c, e);
    const proof = await this.sources.lock(c, executor, p.content, now);
    await this.authorization.authorize(
      c,
      authorityCaller(policy.proposer),
      proof.resources,
      'actions:propose',
    );
    await this.authorization.authorize(
      c,
      authorityCaller(policy.reviewer),
      proof.resources,
      'actions:approve',
      { author: p.content.author, requester: p.content.requester },
    );
    await this.authorization.authorize(c, executor, proof.resources, 'actions:execute');
    await this.store.locks(c, e, p);
    if (+(await this.store.plans.now(c)) >= proof.validUntil)
      throw new OperationsError('OPERATIONS_EXPIRED');
    assertOperationsEnabled(this.flags(), 'dispatch');
  }
  async run(id: string, owner: string): Promise<void> {
    const lease = await this.store.claim(id, owner);
    if (!lease) return;
    let plan: ActionPlanVersion;
    try {
      plan = await this.store.transaction(async (c) => {
        const e = await this.store.leased(c, lease);
        if (!e || e.state !== 'prechecking')
          throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
        const p = await this.store.plan(c, e);
        await this.check(c, e, p);
        return p;
      });
      await this.adapter.preflight(plan);
    } catch {
      await this.failBeforeSend(lease);
      return;
    }
    let invocation: ActionInvocation | null;
    try {
      invocation = await this.store.transaction(async (c) => {
        const e = await this.store.leased(c, lease);
        if (!e || e.state !== 'prechecking' || e.cancelRequestedAt) return null;
        const p = await this.store.plan(c, e);
        await this.check(c, e, p);
        // This commit is the conservative send boundary. Ack loss is UNKNOWN;
        // no caller can prove the remote call was not made after it.
        await this.store.transition(c, e, 'dispatching');
        return Object.freeze({
          executionId: e.id,
          operationId: e.operationId,
          planId: p.id,
          planVersion: p.version,
          planHash: p.contentHash,
          serverId: p.content.target.id,
          toolHash: p.content.tool.hash,
          configHash: actionConfigHash(p),
        });
      });
    } catch {
      // Never infer rollback from a commit exception. Inspect durable state.
      await this.failBeforeSend(lease);
      return;
    }
    if (!invocation) return;
    capabilities.add(invocation);
    try {
      const receipt = checkedActionReceipt(
        await this.adapter.execute(invocation),
        lease.execution,
        plan,
      );
      await this.finish(lease, receipt);
    } catch {
      await this.unknown(lease);
    } finally {
      capabilities.delete(invocation);
    }
  }
  private async failBeforeSend(lease: ExecutionLease): Promise<void> {
    await this.store.transaction(async (c) => {
      const e = await this.store.load(c, lease.execution.id);
      if (e.fence !== lease.fence || e.leaseOwner !== lease.owner) return;
      if (e.state === 'dispatching')
        await this.store.transition(c, e, 'outcome_unknown', 'ACTION_SEND_UNCERTAIN');
      else if (e.state === 'prechecking')
        await this.store.transition(c, e, 'failed', 'ACTION_PRECHECK_FAILED');
    });
  }
  private async unknown(lease: ExecutionLease): Promise<void> {
    await this.store.transaction(async (c) => {
      const e = await this.store.load(c, lease.execution.id);
      if (e.fence === lease.fence && e.leaseOwner === lease.owner && e.state === 'dispatching')
        await this.store.transition(c, e, 'outcome_unknown', 'ACTION_SEND_UNCERTAIN');
    });
  }
  private async finish(lease: ExecutionLease, receipt: ActionReceipt): Promise<void> {
    await this.store.transaction(async (c) => {
      const e = await this.store.leased(c, lease);
      if (!e) {
        const stale = await this.store.load(c, lease.execution.id);
        if (
          stale.fence === lease.fence &&
          stale.leaseOwner === lease.owner &&
          stale.state === 'dispatching'
        )
          await this.store.transition(c, stale, 'outcome_unknown', 'ACTION_LEASE_EXPIRED');
        return; // Late receipt is reconciled through the read-only path.
      }
      if (e.state !== 'dispatching') return;
      const state =
        receipt.outcome === 'succeeded'
          ? 'succeeded'
          : receipt.outcome === 'not_executed'
            ? 'failed'
            : 'outcome_unknown';
      await this.store.transition(
        c,
        e,
        state,
        state === 'outcome_unknown' ? 'ACTION_SEND_UNCERTAIN' : null,
        receipt,
      );
    });
  }
  /** No user-authored receipt/text accepted. Reads only the original pinned
   * target and binds its persisted operation receipt to the historical plan. */
  async reconcile(
    actor: Parameters<ActionExecutionStore['get']>[0],
    id: string,
  ): Promise<ExecutionRecord> {
    actor = freezeInvestigationCaller(actor);
    const e = await this.store.get(actor, id);
    if (!['dispatching', 'outcome_unknown'].includes(e.state)) return e;
    const plan = await this.store.transaction((c) => this.store.historicalPlan(c, e));
    const receipt = checkedActionReceipt(await this.adapter.receipt(plan, e.operationId), e, plan);
    return this.store.transaction(async (c) => {
      const current = await this.store.load(c, id);
      await this.store.authorize(c, actor, current, true);
      if (!['dispatching', 'outcome_unknown'].includes(current.state)) return current;
      const state =
        receipt.outcome === 'succeeded'
          ? 'succeeded'
          : receipt.outcome === 'not_executed'
            ? 'failed'
            : 'outcome_unknown';
      await this.store.transition(
        c,
        current,
        state,
        state === 'outcome_unknown' ? 'ACTION_SEND_UNCERTAIN' : null,
        receipt,
      );
      await this.store.auditReconciliation(c, current, actor, receipt);
      return this.store.load(c, id);
    });
  }
}
