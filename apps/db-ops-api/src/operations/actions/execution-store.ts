import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { freezeInvestigationCaller } from '../../investigations/authorization.js';
import { OutboxService } from '../../workflows/outbox-service.js';
import { OperationsAuthorization } from '../authorization.js';
import {
  OperationsError,
  operationsContentHash,
  type ActionPlanVersion,
  type ActionExecution,
} from '../contracts.js';
import { ActionPlanService } from './plan-service.js';
import { parsePlanContent } from './approval-binding.js';
import {
  PlanStore,
  PlanSources,
  planRows,
  decodePlanJson,
  type PlanConnection,
} from './plan-store.js';

const commandSchema = z.strictObject({
  planId: z.string().min(1).max(128),
  expectedVersion: z.number().int().positive().safe(),
  approvalId: z.string().regex(/^[1-9]\d{0,19}$/),
  requestKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/),
});
export type ExecuteCommand = z.infer<typeof commandSchema>;
export interface ExecutionRecord extends ActionExecution {
  actorId: number;
  receipt: unknown;
  errorCode: string | null;
}
export interface ExecutionLease {
  execution: ExecutionRecord;
  owner: string;
  fence: number;
}
const iso = (v: any) => (v == null ? null : new Date(v).toISOString());
const record = (r: any): ExecutionRecord => ({
  id: r.id,
  schemaVersion: 1,
  version: Number(r.version),
  contentHash: r.payload_hash,
  planId: r.plan_id,
  planVersion: Number(r.plan_version),
  approvalId: String(r.approval_id),
  operationId: r.operation_id,
  actorId: Number(r.actor_id),
  requestKey: Buffer.isBuffer(r.request_key) ? r.request_key.toString() : r.request_key,
  payloadHash: r.payload_hash,
  state: r.state,
  leaseOwner: r.lease_owner,
  fence: Number(r.fence),
  sentAt: iso(r.sent_at),
  cancelRequestedAt: iso(r.cancel_requested_at),
  receiptHash: r.receipt_hash,
  receipt: decodePlanJson(r.receipt),
  errorCode: r.error_code,
});
/** Durable SQL state only; never sends, refunds approvals or retries a dispatched operation. */
export class ActionExecutionStore {
  constructor(
    readonly plans: PlanStore,
    private readonly sources: PlanSources,
    private readonly approvals: ActionPlanService,
    private readonly authorization = new OperationsAuthorization(),
  ) {}
  transaction<T>(work: (c: PlanConnection) => Promise<T>): Promise<T> {
    return this.plans.transaction(work);
  }
  async load(c: PlanConnection, id: string): Promise<ExecutionRecord> {
    const [row] = await planRows(c, 'SELECT * FROM action_executions WHERE id=? FOR UPDATE', [id]);
    if (!row) throw new OperationsError('OPERATIONS_NOT_FOUND');
    return record(row);
  }
  async plan(c: PlanConnection, e: ExecutionRecord): Promise<ActionPlanVersion> {
    const p = await this.plans.load(c, e.planId);
    if (p.version !== e.planVersion) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
    return p;
  }
  async historicalPlan(c: PlanConnection, e: ExecutionRecord): Promise<ActionPlanVersion> {
    const [row] = await planRows(
      c,
      'SELECT * FROM action_plan_versions WHERE plan_id=? AND version=? FOR SHARE',
      [e.planId, e.planVersion],
    );
    if (!row) throw new OperationsError('OPERATIONS_NOT_FOUND');
    const content = parsePlanContent(decodePlanJson(row.content));
    if (operationsContentHash(content) !== row.content_hash)
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    return {
      id: e.planId,
      version: e.planVersion,
      schemaVersion: 1,
      contentHash: row.content_hash,
      state: row.state,
      content,
    };
  }
  async authorize(
    c: PlanConnection,
    actor: ActorContext,
    e: ExecutionRecord,
    write = false,
  ): Promise<void> {
    // Retained historical executions remain readable/cancellable after plan revision.
    const plan = await this.historicalPlan(c, e);
    const refs = await this.sources.scope(c, actor, plan.content);
    await this.authorization.authorize(c, actor, refs, write ? 'actions:execute' : 'actions:read');
  }
  async get(actor: ActorContext, id: string): Promise<ExecutionRecord> {
    actor = freezeInvestigationCaller(actor);
    return this.transaction(async (c) => {
      const e = await this.load(c, id);
      await this.authorize(c, actor, e);
      return e;
    });
  }
  async enqueue(actor: ActorContext, input: unknown): Promise<ExecutionRecord> {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    const command = parsed.data;
    actor = freezeInvestigationCaller(actor);
    const hash = operationsContentHash({ command, principalKind: actor.principalKind ?? 'user' });
    const existing = () =>
      this.transaction(async (c) => {
        const [r] = await planRows(
          c,
          'SELECT * FROM action_executions WHERE actor_id=? AND request_key=? FOR UPDATE',
          [actor.userId, command.requestKey],
        );
        if (!r) return null;
        const e = record(r);
        await this.authorize(c, actor, e, true);
        if (e.payloadHash !== hash) throw new OperationsError('OPERATIONS_IDEMPOTENCY_CONFLICT');
        return e;
      });
    const prior = await existing();
    if (prior) return prior;
    try {
      return await this.approvals.enqueueApproved(
        actor,
        {
          planId: command.planId,
          expectedVersion: command.expectedVersion,
          approvalId: command.approvalId,
        },
        async (c, p, approvalId) => {
          const id = randomUUID();
          await c.execute(
            `INSERT INTO action_executions(id,plan_id,plan_version,approval_id,operation_id,actor_id,request_key,payload_hash) VALUES(?,?,?,?,?,?,?,?)`,
            [id, p.id, p.version, approvalId, id, actor.userId, command.requestKey, hash],
          );
          // Global default is deliberately fixed at one. Locks also cover queued and unknown work.
          for (const key of ['global', `server:${p.content.target.id}`]) {
            await c.execute(
              'INSERT INTO action_dispatch_locks(lock_key) VALUES(?) ON DUPLICATE KEY UPDATE lock_key=lock_key',
              [key],
            );
            const [lock] = await planRows(
              c,
              'SELECT * FROM action_dispatch_locks WHERE lock_key=? FOR UPDATE',
              [key],
            );
            if (lock.execution_id) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
            await c.execute(
              'UPDATE action_dispatch_locks SET execution_id=?,fence=fence+1,updated_at=UTC_TIMESTAMP(3) WHERE lock_key=?',
              [id, key],
            );
          }
          await c.execute(
            "INSERT INTO agent_tool_execution_intents(id,approval_id,request_id,state) VALUES(?,?,?,'dispatching')",
            [id, approvalId, command.requestKey],
          );
          // Store the request ceiling in server-owned durable storage, never take authority from a queued payload.
          await new OutboxService({ getConnection: async () => c }).append(c, {
            eventType: 'operations.action.execute',
            schemaVersion: 1,
            aggregateType: 'action_execution',
            aggregateId: id,
            aggregateVersion: 1,
            payload: { executionId: id, actor },
            idempotencyKey: `action.execute:${id}`,
          });
          await c.execute(
            `INSERT INTO workflow_jobs(id,job_type,schema_version,payload,idempotency_key,max_attempts,available_at)
          VALUES(?,'operations.action.execute',1,?,?,1,UTC_TIMESTAMP(3))`,
            [randomUUID(), JSON.stringify({ executionId: id }), `action.execute:${id}`],
          );
          return this.load(c, id);
        },
      );
    } catch (error) {
      // Includes commit-ack loss and a concurrent request that consumed the same approval.
      const committed = await existing();
      if (committed) return committed;
      throw error;
    }
  }
  async actor(c: PlanConnection, e: ExecutionRecord): Promise<ActorContext> {
    const [outbox] = await planRows(
      c,
      'SELECT payload FROM outbox_events WHERE idempotency_key=? FOR SHARE',
      [`action.execute:${e.id}`],
    );
    const payload = decodePlanJson(outbox?.payload);
    if (payload?.executionId !== e.id || payload.actor?.userId !== e.actorId)
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    return freezeInvestigationCaller(payload.actor);
  }
  async claim(id: string, owner: string, seconds = 30): Promise<ExecutionLease | null> {
    if (
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(owner) ||
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds > 60
    )
      throw new OperationsError('OPERATIONS_INPUT_INVALID');
    return this.transaction(async (c) => {
      const e = await this.load(c, id),
        now = await this.plans.now(c);
      const [r] = await planRows(c, 'SELECT lease_expires_at FROM action_executions WHERE id=?', [
        id,
      ]);
      const expired = !r.lease_expires_at || +new Date(r.lease_expires_at) <= +now;
      if (!expired) return null;
      if (e.state === 'dispatching') {
        await this.transition(c, e, 'outcome_unknown', 'ACTION_DISPATCH_INTERRUPTED');
        return null;
      }
      if (!['queued', 'prechecking'].includes(e.state)) return null;
      if (e.cancelRequestedAt) {
        await this.transition(c, e, 'cancelled');
        return null;
      }
      await c.execute(
        `UPDATE action_executions SET state='prechecking',lease_owner=?,lease_expires_at=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)),fence=fence+1,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?`,
        [owner, seconds, id],
      );
      const next = await this.load(c, id);
      return { execution: next, owner, fence: next.fence };
    });
  }
  async recoverExpiredDispatches(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new OperationsError('OPERATIONS_INPUT_INVALID');
    return this.transaction(async (c) => {
      const stale = await planRows(
        c,
        `SELECT * FROM action_executions WHERE state='dispatching'
        AND lease_expires_at<=UTC_TIMESTAMP(3) ORDER BY id LIMIT ${limit} FOR UPDATE`,
      );
      for (const row of stale)
        await this.transition(c, record(row), 'outcome_unknown', 'ACTION_DISPATCH_INTERRUPTED');
      return stale.length;
    });
  }
  async leased(c: PlanConnection, lease: ExecutionLease): Promise<ExecutionRecord | null> {
    const e = await this.load(c, lease.execution.id);
    const [r] = await planRows(
      c,
      'SELECT lease_expires_at>UTC_TIMESTAMP(3) AS live FROM action_executions WHERE id=?',
      [e.id],
    );
    return e.leaseOwner === lease.owner && e.fence === lease.fence && Number(r.live) === 1
      ? e
      : null;
  }
  async locks(c: PlanConnection, e: ExecutionRecord, p: ActionPlanVersion): Promise<void> {
    for (const key of ['global', `server:${p.content.target.id}`]) {
      const [lock] = await planRows(
        c,
        'SELECT execution_id FROM action_dispatch_locks WHERE lock_key=? FOR UPDATE',
        [key],
      );
      if (lock?.execution_id !== e.id) throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    }
  }
  /** Final send admission, after all asynchronous validation. The predicate is
   * evaluated by MySQL in the same statement that crosses the send boundary;
   * a prior leased() read cannot authorize dispatch after its deadline. */
  async admitDispatch(
    c: PlanConnection,
    e: ExecutionRecord,
    lease: ExecutionLease,
  ): Promise<boolean> {
    const [result] = (await c.execute(
      `UPDATE action_executions SET state='dispatching',version=version+1,
      sent_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3)
      WHERE id=? AND version=? AND state='prechecking' AND cancel_requested_at IS NULL
      AND lease_owner=? AND fence=? AND lease_expires_at>UTC_TIMESTAMP(3)`,
      [lease.execution.id, e.version, lease.owner, lease.fence],
    )) as [{ affectedRows: number }, unknown];
    if (result.affectedRows !== 1) return false;
    await new OutboxService({ getConnection: async () => c }).append(c, {
      eventType: 'operations.action.state',
      schemaVersion: 1,
      aggregateType: 'action_execution',
      aggregateId: e.id,
      aggregateVersion: e.version + 1,
      payload: { executionId: e.id, state: 'dispatching', version: e.version + 1 },
      idempotencyKey: `action.state:${e.id}:${e.version + 1}`,
    });
    return true;
  }
  async transition(
    c: PlanConnection,
    e: ExecutionRecord,
    state: ExecutionRecord['state'],
    error: string | null = null,
    receipt: unknown = null,
  ): Promise<void> {
    await c.execute(
      `UPDATE action_executions SET state=?,version=version+1,error_code=?,receipt=?,receipt_hash=?,
      sent_at=CASE WHEN ?='dispatching' THEN UTC_TIMESTAMP(3) ELSE sent_at END,
      lease_expires_at=CASE WHEN ?='dispatching' THEN lease_expires_at ELSE NULL END,updated_at=UTC_TIMESTAMP(3) WHERE id=?`,
      [
        state,
        error,
        receipt ? JSON.stringify(receipt) : null,
        receipt ? operationsContentHash(receipt) : null,
        state,
        state,
        e.id,
      ],
    );
    if (['succeeded', 'failed', 'cancelled'].includes(state)) {
      await c.execute(
        'UPDATE action_dispatch_locks SET execution_id=NULL,updated_at=UTC_TIMESTAMP(3) WHERE execution_id=?',
        [e.id],
      );
      await c.execute(
        "UPDATE agent_tool_execution_intents SET state='finished' WHERE id=? AND state='dispatching'",
        [e.id],
      );
    }
    await new OutboxService({ getConnection: async () => c }).append(c, {
      eventType: 'operations.action.state',
      schemaVersion: 1,
      aggregateType: 'action_execution',
      aggregateId: e.id,
      aggregateVersion: e.version + 1,
      payload: { executionId: e.id, state, version: e.version + 1 },
      idempotencyKey: `action.state:${e.id}:${e.version + 1}`,
    });
  }
  async auditReconciliation(
    c: PlanConnection,
    e: ExecutionRecord,
    actor: ActorContext,
    receipt: unknown,
  ): Promise<void> {
    await new OutboxService({ getConnection: async () => c }).append(c, {
      eventType: 'operations.action.reconciled',
      schemaVersion: 1,
      aggregateType: 'action_execution',
      aggregateId: e.id,
      aggregateVersion: e.version + 1,
      payload: {
        executionId: e.id,
        operationId: e.operationId,
        actorId: actor.userId,
        principalKind: actor.principalKind ?? 'user',
        receiptHash: operationsContentHash(receipt),
        source: 'pinned_helper',
      },
      idempotencyKey: `action.reconcile:${e.id}:${e.version + 1}`,
    });
  }
  async cancel(actor: ActorContext, id: string): Promise<ExecutionRecord> {
    actor = freezeInvestigationCaller(actor);
    return this.transaction(async (c) => {
      const e = await this.load(c, id);
      await this.authorize(c, actor, e, true);
      if (['succeeded', 'failed', 'cancelled'].includes(e.state)) return e;
      if (e.cancelRequestedAt) return e;
      await c.execute(
        'UPDATE action_executions SET cancel_requested_at=COALESCE(cancel_requested_at,UTC_TIMESTAMP(3)),version=version+1 WHERE id=?',
        [id],
      );
      const updated = await this.load(c, id);
      await new OutboxService({ getConnection: async () => c }).append(c, {
        eventType: 'operations.action.cancel_requested',
        schemaVersion: 1,
        aggregateType: 'action_execution',
        aggregateId: e.id,
        aggregateVersion: updated.version,
        payload: {
          executionId: e.id,
          actorId: actor.userId,
          principalKind: actor.principalKind ?? 'user',
          requestId: actor.requestId,
        },
        idempotencyKey: `action.cancel:${e.id}:${updated.version}`,
      });
      if (['queued', 'prechecking'].includes(e.state))
        await this.transition(c, updated, 'cancelled');
      return this.load(c, id);
    });
  }
}
