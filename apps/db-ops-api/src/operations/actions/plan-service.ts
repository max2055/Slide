import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ActorContextService,
  ActorAuthenticationError,
  type ActorContext,
} from '../../auth/actor-context.js';
import { freezeInvestigationCaller } from '../../investigations/authorization.js';
import { OperationsAuthorization } from '../authorization.js';
import {
  assertExpectedVersion,
  operationsContentHash,
  OperationsError,
  type ActionPlanVersion,
} from '../contracts.js';
import { assertOperationsEnabled, operationsFlags, type OperationsFlags } from '../feature-flags.js';
import {
  ACTION_APPROVAL_KIND,
  ACTION_APPROVAL_TOOL,
  actionApprovalHash,
  approvalAuthority,
  assertPlanFresh,
  authorityCaller,
  proposedContent,
  type ApprovalAuthority,
} from './approval-binding.js';
import {
  PlanStore, PlanSources, planRows, decodePlanJson, type PlanConnection, type PlanSourceProof,
} from './plan-store.js';

const refSchema = z.strictObject({
  planId: z.string().min(1).max(128),
  expectedVersion: z.number().int().positive().safe(),
});
const reviewSchema = refSchema.extend({
  approvalId: z.string().regex(/^[1-9]\d{0,19}$/),
  action: z.enum(['approve', 'reject']),
  note: z.string().max(1000).default(''),
});
const executeSchema = refSchema.extend({ approvalId: z.string().regex(/^[1-9]\d{0,19}$/) });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new OperationsError('OPERATIONS_INPUT_INVALID');
  return result.data;
}
function requireState(plan: ActionPlanVersion, state: ActionPlanVersion['state']) {
  if (plan.state !== state) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
}
interface ApprovalPolicy {
  kind: typeof ACTION_APPROVAL_KIND;
  proposer: ApprovalAuthority;
  proposerLiveHash: string;
  reviewer?: ApprovalAuthority;
  reviewerLiveHash?: string;
}
/** Domain composition only: P10 owns public contracts, installation and wiring.
 * No action is sent here. P07's durable intent writer is invoked within the
 * same transaction as once consumption; throwing rolls back BOTH writes. */
export class ActionPlanService {
  constructor(
    private readonly store: PlanStore,
    private readonly sources: PlanSources,
    private readonly authorization = new OperationsAuthorization(),
    private readonly flags: () => Readonly<OperationsFlags> = operationsFlags,
  ) {}
  private async liveHash(c: PlanConnection, snapshot: ApprovalAuthority): Promise<string> {
    try {
      const actor = await new ActorContextService().loadInvestigationActorFrom(
        c,
        snapshot.userId,
        snapshot.principalKind,
        snapshot.sessionVersion,
        'action-binding',
      );
      return operationsContentHash(approvalAuthority(actor));
    } catch (error) {
      if (error instanceof ActorAuthenticationError) throw new OperationsError('OPERATIONS_FORBIDDEN');
      throw error;
    }
  }
  private enabled(dispatch = false) {
    assertOperationsEnabled(this.flags(), dispatch ? 'dispatch' : 'plans');
  }
  private async check(
    c: PlanConnection,
    caller: ActorContext,
    plan: ActionPlanVersion,
    action: 'actions:read' | 'actions:propose' | 'actions:approve' | 'actions:execute',
    now: Date,
  ) {
    assertPlanFresh(plan, now);
    const proof = await this.sources.lock(c, caller, plan.content, now);
    await this.authorization.authorize(c, caller, proof.resources, action, {
      author: plan.content.author,
      requester: plan.content.requester,
    });
    return proof;
  }
  private async fresh(c: PlanConnection, plan: ActionPlanVersion, proof: PlanSourceProof) {
    const now = await this.store.now(c);
    assertPlanFresh(plan, now);
    if (now.getTime() >= proof.validUntil)
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
  }
  async create(
    caller: ActorContext,
    input: unknown,
    lifetimeMs?: number,
  ): Promise<ActionPlanVersion> {
    caller = freezeInvestigationCaller(caller);
    // Clone/validate synchronously before any awaited operation.
    const contentInput = structuredClone(input);
    return this.store.transaction(async (c) => {
      this.enabled();
      const now = await this.store.now(c);
      const content = proposedContent(contentInput, caller, now, lifetimeMs);
      const plan: ActionPlanVersion = {
        id: randomUUID(),
        version: 1,
        schemaVersion: 1,
        contentHash: operationsContentHash(content),
        state: 'draft',
        content,
      };
      const proof = await this.check(c, caller, plan, 'actions:propose', now);
      await this.store.insert(c, plan);
      await this.fresh(c, plan, proof);
      return plan;
    });
  }
  async revise(
    caller: ActorContext,
    ref: unknown,
    input: unknown,
    lifetimeMs?: number,
  ): Promise<ActionPlanVersion> {
    const command = parse(refSchema, ref),
      contentInput = structuredClone(input);
    caller = freezeInvestigationCaller(caller);
    return this.store.transaction(async (c) => {
      this.enabled();
      const previous = await this.store.load(c, command.planId);
      assertExpectedVersion(command.expectedVersion, previous.version);
      // Revision can replace stale content, but cannot evade the old scope ACL.
      const resources = await this.sources.scope(c, caller, previous.content);
      await this.authorization.authorize(c, caller, resources, 'actions:propose');
      const now = await this.store.now(c),
        content = proposedContent(contentInput, caller, now, lifetimeMs);
      if (content.investigationId !== previous.content.investigationId)
        throw new OperationsError('OPERATIONS_INPUT_INVALID');
      const plan: ActionPlanVersion = {
        id: previous.id,
        version: previous.version + 1,
        schemaVersion: 1,
        contentHash: operationsContentHash(content),
        state: 'draft',
        content,
      };
      const proof = await this.check(c, caller, plan, 'actions:propose', now);
      await this.store.insert(c, plan, previous);
      await this.fresh(c, plan, proof);
      return plan;
    });
  }
  async get(caller: ActorContext, planId: string): Promise<ActionPlanVersion> {
    parse(refSchema, { planId, expectedVersion: 1 });
    caller = freezeInvestigationCaller(caller);
    return this.store.transaction(async (c) => {
      const plan = await this.store.load(c, planId);
      const resources = await this.sources.scope(c, caller, plan.content);
      await this.authorization.authorize(c, caller, resources, 'actions:read');
      if (
        Date.parse(plan.content.validUntil) <= (await this.store.now(c)).getTime() &&
        ['draft', 'pending_approval', 'approved'].includes(plan.state)
      )
        return { ...plan, state: 'expired' };
      return plan;
    });
  }
  async submit(
    caller: ActorContext,
    input: unknown,
  ): Promise<{ approvalId: string; plan: ActionPlanVersion }> {
    const command = parse(refSchema, input);
    caller = freezeInvestigationCaller(caller);
    return this.store.transaction(async (c) => {
      this.enabled();
      const plan = await this.store.load(c, command.planId);
      assertExpectedVersion(command.expectedVersion, plan.version);
      requireState(plan, 'draft');
      if (
        caller.userId !== plan.content.requester.id ||
        (caller.principalKind ?? 'user') !== plan.content.requester.kind
      )
        throw new OperationsError('OPERATIONS_FORBIDDEN');
      const now = await this.store.now(c);
      const proof = await this.check(c, caller, plan, 'actions:propose', now);
      const proposer = approvalAuthority(caller),
        proposerLiveHash = await this.liveHash(c, proposer);
      const hash = actionApprovalHash(plan, proposer, proposerLiveHash);
      const [insert] = (await c.execute(
        `INSERT INTO agent_tool_approvals
        (tool_name,requester_id,binding_hash,args_redacted,resource_json,policy_snapshot,status,scope,session_key,risk_level,max_uses,used_count,expires_at)
        VALUES(?,?,?,?,?,?,'pending','once',NULL,'high',1,0,?)`,
        [
          ACTION_APPROVAL_TOOL,
          caller.userId,
          hash,
          JSON.stringify({
            kind: ACTION_APPROVAL_KIND,
            planId: plan.id,
            version: plan.version,
            contentHash: plan.contentHash,
          }),
          JSON.stringify(plan.content.target),
          JSON.stringify({ kind: ACTION_APPROVAL_KIND, proposer, proposerLiveHash }),
          new Date(Math.floor(Date.parse(plan.content.validUntil) / 1000) * 1000),
        ],
      )) as [any];
      if (!insert.insertId) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
      await c.execute(
        "UPDATE action_plan_versions SET state='pending_approval' WHERE plan_id=? AND version=?",
        [plan.id, plan.version],
      );
      await this.fresh(c, plan, proof);
      return { approvalId: String(insert.insertId), plan: { ...plan, state: 'pending_approval' } };
    });
  }
  private async approval(c: PlanConnection, plan: ActionPlanVersion, id: string) {
    const [row] = await planRows(c, 'SELECT * FROM agent_tool_approvals WHERE id=? FOR UPDATE', [
      id,
    ]);
    if (row?.status === 'consumed') throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
    if (
      !row ||
      row.tool_name !== ACTION_APPROVAL_TOOL ||
      row.scope !== 'once' ||
      row.session_key !== null ||
      Number(row.max_uses) !== 1 ||
      Number(row.used_count) !== 0 ||
      row.risk_level !== 'high' ||
      Number(row.requester_id) !== plan.content.requester.id ||
      new Date(row.expires_at).getTime() > Date.parse(plan.content.validUntil)
    )
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    const policy = decodePlanJson(row.policy_snapshot) as ApprovalPolicy;
    if (
      policy?.kind !== ACTION_APPROVAL_KIND ||
      !policy.proposer ||
      policy.proposer.userId !== plan.content.requester.id ||
      policy.proposer.principalKind !== plan.content.requester.kind ||
      row.binding_hash !== actionApprovalHash(plan, policy.proposer, policy.proposerLiveHash)
    )
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    const args = decodePlanJson(row.args_redacted);
    if (
      args?.kind !== ACTION_APPROVAL_KIND ||
      args.planId !== plan.id ||
      args.version !== plan.version ||
      args.contentHash !== plan.contentHash
    )
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    const now = await this.store.now(c);
    if (new Date(row.expires_at).getTime() <= now.getTime()) throw new OperationsError('OPERATIONS_EXPIRED');
    // Revalidate the original request ceiling and session, even if execution is
    // requested by another operator. Lost permission never inherits admin grants.
    if (!policy.proposerLiveHash || (await this.liveHash(c, policy.proposer)) !== policy.proposerLiveHash)
      throw new OperationsError('OPERATIONS_FORBIDDEN');
    await this.check(c, authorityCaller(policy.proposer), plan, 'actions:propose', now);
    return { row, policy, now };
  }
  async review(caller: ActorContext, input: unknown): Promise<ActionPlanVersion> {
    const command = parse(reviewSchema, input);
    caller = freezeInvestigationCaller(caller);
    return this.store.transaction(async (c) => {
      this.enabled();
      const plan = await this.store.load(c, command.planId);
      assertExpectedVersion(command.expectedVersion, plan.version);
      requireState(plan, 'pending_approval');
      const { row, policy, now } = await this.approval(c, plan, command.approvalId);
      if (row.status !== 'pending') throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
      const proof = await this.check(c, caller, plan, 'actions:approve', now);
      const reviewerSnapshot = approvalAuthority(caller),
        reviewerLiveHash = await this.liveHash(c, reviewerSnapshot);
      const approved = command.action === 'approve',
        state = approved ? 'approved' : 'rejected';
      await c.execute(
        `UPDATE agent_tool_approvals SET status=?,reviewer_id=?,review_note=?,reviewed_at=UTC_TIMESTAMP(3),policy_snapshot=?
        WHERE id=? AND status='pending'`,
        [
          state,
          caller.userId,
          command.note,
          JSON.stringify({ ...policy, reviewer: reviewerSnapshot, reviewerLiveHash }),
          command.approvalId,
        ],
      );
      // Rejects remain in the existing review history. Only an actual independent
      // approval creates an executable binding; no pending placeholder reviewer.
      if (approved)
        await c.execute(
          `INSERT INTO action_approval_bindings
        (approval_id,plan_id,plan_version,content_hash,policy_version,author_id,requester_id,reviewer_id,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
          [
            command.approvalId,
            plan.id,
            plan.version,
            plan.contentHash,
            plan.content.policyVersion,
            plan.content.author.id,
            plan.content.requester.id,
            caller.userId,
            new Date(row.expires_at),
          ],
        );
      await c.execute('UPDATE action_plan_versions SET state=? WHERE plan_id=? AND version=?', [
        state,
        plan.id,
        plan.version,
      ]);
      await this.fresh(c, plan, proof);
      return { ...plan, state };
    });
  }
  /** P07 MUST write its unique execution + durable intent/outbox in enqueue.
   * It MUST NOT send to an external target within this callback. A commit with
   * lost acknowledgement is reconciled using the persisted execution key. */
  async enqueueApproved<T>(
    caller: ActorContext,
    input: unknown,
    enqueue: (c: PlanConnection, plan: ActionPlanVersion, approvalId: string) => Promise<T>,
  ): Promise<T> {
    const command = parse(executeSchema, input);
    caller = freezeInvestigationCaller(caller);
    return this.store.transaction(async (c) => {
      this.enabled(true);
      const plan = await this.store.load(c, command.planId);
      assertExpectedVersion(command.expectedVersion, plan.version);
      requireState(plan, 'approved');
      const { row, policy, now } = await this.approval(c, plan, command.approvalId);
      if (row.status !== 'approved' || !policy.reviewer || policy.reviewer.userId !== Number(row.reviewer_id))
        throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
      if (!policy.reviewerLiveHash || (await this.liveHash(c, policy.reviewer)) !== policy.reviewerLiveHash)
        throw new OperationsError('OPERATIONS_FORBIDDEN');
      await this.check(c, authorityCaller(policy.reviewer), plan, 'actions:approve', now);
      const proof = await this.check(c, caller, plan, 'actions:execute', now);
      const [binding] = await planRows(
        c,
        'SELECT * FROM action_approval_bindings WHERE approval_id=? FOR UPDATE',
        [command.approvalId],
      );
      if (
        !binding ||
        binding.plan_id !== plan.id ||
        Number(binding.plan_version) !== plan.version ||
        binding.content_hash !== plan.contentHash ||
        binding.policy_version !== plan.content.policyVersion ||
        binding.approval_mode !== 'once' ||
        binding.consumed_at ||
        Number(binding.author_id) !== plan.content.author.id ||
        Number(binding.requester_id) !== plan.content.requester.id ||
        Number(binding.reviewer_id) !== policy.reviewer.userId ||
        new Date(binding.expires_at).getTime() !== new Date(row.expires_at).getTime()
      )
        throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      const [used] = (await c.execute(
        `UPDATE agent_tool_approvals SET status='consumed',consumed_at=UTC_TIMESTAMP(3),used_count=1
        WHERE id=? AND status='approved' AND scope='once' AND used_count=0 AND expires_at>UTC_TIMESTAMP(3)`,
        [command.approvalId],
      )) as [any];
      if (Number(used.affectedRows) !== 1) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
      await c.execute(
        'UPDATE action_approval_bindings SET consumed_at=UTC_TIMESTAMP(3) WHERE approval_id=? AND consumed_at IS NULL',
        [command.approvalId],
      );
      const result = await enqueue(c, plan, command.approvalId);
      await this.fresh(c, plan, proof);
      return result;
    });
  }
}
