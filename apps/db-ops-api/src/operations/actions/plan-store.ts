import { dbConnection } from '../../db-connection.js';
import type { ActorContext } from '../../auth/actor-context.js';
import type { TransactionConnection, TransactionPool } from '../../workflows/outbox-service.js';
import { OutboxService } from '../../workflows/outbox-service.js';
import { InvestigationAuthorization } from '../../investigations/authorization.js';
import {
  OperationsError,
  operationsContentHash,
  type ActionPlanContent,
  type ActionPlanVersion,
} from '../contracts.js';
import { parsePlanContent } from './approval-binding.js';
import type { ResourceRef } from '../../resources/types.js';

export type PlanConnection = TransactionConnection;
export async function planRows(
  c: Pick<PlanConnection, 'execute'>,
  sql: string,
  values: unknown[] = [],
): Promise<any[]> {
  const [rows] = (await c.execute(sql, values)) as [any[], unknown];
  return rows;
}
export const decodePlanJson = (v: any): any => (typeof v === 'string' ? JSON.parse(v) : v);
export class PlanStore {
  constructor(
    private readonly pool: TransactionPool = dbConnection.getPool() as unknown as TransactionPool,
  ) {}
  async transaction<T>(work: (c: PlanConnection) => Promise<T>): Promise<T> {
    if (!this.pool) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    return new OutboxService(this.pool).transaction((c) => work(c));
  }
  async now(c: PlanConnection): Promise<Date> {
    const [row] = await planRows(c, 'SELECT UTC_TIMESTAMP(3) AS now');
    return new Date(row.now);
  }
  async load(c: PlanConnection, id: string): Promise<ActionPlanVersion> {
    const [head] = await planRows(c, 'SELECT * FROM action_plans WHERE id = ? FOR UPDATE', [id]);
    if (!head) throw new OperationsError('OPERATIONS_NOT_FOUND');
    const [row] = await planRows(
      c,
      'SELECT * FROM action_plan_versions WHERE plan_id = ? AND version = ? FOR UPDATE',
      [id, head.current_version],
    );
    if (!row) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    const content = parsePlanContent(decodePlanJson(row.content));
    if (
      operationsContentHash(content) !== row.content_hash ||
      head.investigation_id !== content.investigationId ||
      Number(head.target_id) !== content.target.id ||
      head.target_type !== content.target.type ||
      Number(head.author_id) !== content.author.id ||
      Number(head.requester_id) !== content.requester.id ||
      head.author_kind !== content.author.kind ||
      head.requester_kind !== content.requester.kind ||
      row.policy_version !== content.policyVersion ||
      Number(row.result_version) !== content.resultVersion ||
      new Date(row.valid_from).getTime() !== Date.parse(content.validFrom) ||
      new Date(row.valid_until).getTime() !== Date.parse(content.validUntil)
    )
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    return {
      id,
      version: Number(row.version),
      schemaVersion: 1,
      contentHash: row.content_hash,
      state: row.state,
      content,
    };
  }
  async insert(c: PlanConnection, plan: ActionPlanVersion, previous?: ActionPlanVersion): Promise<void> {
    const v = plan.content;
    if (!previous)
      await c.execute(
        `INSERT INTO action_plans
      (id,investigation_id,author_kind,author_id,requester_kind,requester_id,target_type,target_id)
      VALUES(?,?,?,?,?,?,?,?)`,
        [
          plan.id,
          v.investigationId,
          v.author.kind,
          v.author.id,
          v.requester.kind,
          v.requester.id,
          v.target.type,
          v.target.id,
        ],
      );
    else {
      await c.execute("UPDATE action_plan_versions SET state='superseded' WHERE plan_id=? AND version=?", [
        plan.id,
        previous.version,
      ]);
      // Retain all approval/audit records; only their ability to authorize expires.
      await c.execute(
        `UPDATE agent_tool_approvals a JOIN action_approval_bindings b ON b.approval_id=a.id
        SET a.status='expired' WHERE b.plan_id=? AND b.plan_version=? AND a.status IN ('pending','approved')`,
        [plan.id, previous.version],
      );
      // Pending approvals have no reviewer/binding row until reviewed.
      await c.execute(
        `UPDATE agent_tool_approvals SET status='expired'
        WHERE requester_id=? AND tool_name='operations_action_plan' AND JSON_UNQUOTE(JSON_EXTRACT(args_redacted,'$.planId'))=?
        AND status IN ('pending','approved')`,
        [previous.content.requester.id, plan.id],
      );
      const [changed] = (await c.execute(
        `UPDATE action_plans SET version=version+1,current_version=?,
        author_kind=?,author_id=?,requester_kind=?,requester_id=?,target_type=?,target_id=?,updated_at=UTC_TIMESTAMP(3)
        WHERE id=? AND current_version=?`,
        [
          plan.version,
          v.author.kind,
          v.author.id,
          v.requester.kind,
          v.requester.id,
          v.target.type,
          v.target.id,
          plan.id,
          previous.version,
        ],
      )) as [any];
      if (Number(changed.affectedRows) !== 1) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
    }
    await c.execute(
      `INSERT INTO action_plan_versions
      (plan_id,version,result_version,content_hash,content,policy_version,state,valid_from,valid_until)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        plan.id,
        plan.version,
        v.resultVersion,
        plan.contentHash,
        JSON.stringify(v),
        v.policyVersion,
        plan.state,
        new Date(v.validFrom),
        new Date(v.validUntil),
      ],
    );
  }
}

/** Cross-domain live checks run on the SAME transaction. P10 supplies the
 * environment port below; missing composition never grants pilot eligibility. */
export interface ActionEnvironment {
  /** Lock/read actual allowlist, host identity/config, tool implementation,
   * policy and preconditions. References/scopes are checked by PlanSources. Throw on
   * mismatch, missing data, stale evidence or unavailable dependency. No sends. */
  validate(c: PlanConnection, content: Readonly<ActionPlanContent>, now: Date): Promise<void>;
}
export class PlanSources {
  constructor(
    private readonly environment: ActionEnvironment,
    private readonly investigations = new InvestigationAuthorization(),
  ) {}
  private async references(
    c: PlanConnection,
    content: Readonly<ActionPlanContent>,
    now?: Date,
  ): Promise<ResourceRef[]> {
    const resources: ResourceRef[] = [];
    for (const kind of ['relations', 'baselines'] as const)
      for (const ref of content[kind]) {
        const relation = kind === 'relations';
        if (relation && !/^[1-9]\d{0,19}$/.test(ref.id))
          throw new OperationsError('OPERATIONS_INPUT_INVALID');
        const table = relation ? 'resource_relation_revisions' : 'behavior_baseline_versions';
        const key = relation ? 'relation_id' : 'id';
        // Table/column names above are a fixed server-owned allowlist.
        const [row] = await planRows(c, `SELECT * FROM ${table} WHERE ${key}=? AND version=? FOR SHARE`, [
          ref.id,
          ref.version,
        ]);
        if (!row) throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
        if (relation)
          resources.push(
            { type: row.source_type, id: Number(row.source_id) },
            { type: row.target_type, id: Number(row.target_id) },
          );
        else resources.push({ type: row.resource_type, id: Number(row.resource_id) });
        if (now) {
          const [latest] = await planRows(
            c,
            `SELECT version FROM ${table} WHERE ${key}=? ORDER BY version DESC LIMIT 1 FOR SHARE`,
            [ref.id],
          );
          if (
            Number(latest?.version) !== ref.version ||
            row.content_hash !== ref.hash ||
            row.state !== (relation ? 'confirmed' : 'qualified') ||
            (relation &&
              (new Date(row.valid_from).getTime() > now.getTime() ||
                (row.valid_until &&
                  (new Date(row.valid_until).getTime() <= now.getTime() ||
                    Date.parse(ref.validUntil) > new Date(row.valid_until).getTime()))))
          )
            throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
        }
      }
    return resources;
  }
  async scope(
    c: PlanConnection,
    actor: ActorContext,
    content: Readonly<ActionPlanContent>,
  ): Promise<readonly ResourceRef[]> {
    const investigation = await this.investigations.load(c, content.investigationId);
    const resources: ResourceRef[] = [...investigation.resources];
    for (const ref of content.evidence) {
      const [row] = await planRows(
        c,
        'SELECT metadata_json FROM investigation_evidence WHERE id=? AND investigation_id=? FOR SHARE',
        [ref.id, content.investigationId],
      );
      if (!row) throw new OperationsError('OPERATIONS_NOT_FOUND');
      const metadata = decodePlanJson(row.metadata_json);
      if (!Array.isArray(metadata?.resources) || !metadata.resources.length)
        throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      resources.push(...metadata.resources);
    }
    resources.push(...(await this.references(c, content)));
    await this.investigations.authorize(c, actor, investigation, 'content', resources);
    return [
      ...new Map(resources.map((ref) => [ref.type + ':' + ref.id, { type: ref.type, id: ref.id }])).values(),
    ];
  }
  async check(
    c: PlanConnection,
    actor: ActorContext,
    content: Readonly<ActionPlanContent>,
    now: Date,
  ): Promise<readonly ResourceRef[]> {
    const investigation = await this.investigations.load(c, content.investigationId);
    if (investigation.lifecycle === 'closed' || investigation.lifecycle === 'archived')
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    if (!investigation.resources.some((r) => r.type === content.target.type && r.id === content.target.id))
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    // Membership/complete source ACL is checked before returning any content.
    await this.investigations.authorize(c, actor, investigation, 'content');
    const [result] = await planRows(
      c,
      `SELECT version FROM investigation_results WHERE investigation_id=?
      ORDER BY version DESC LIMIT 1 FOR SHARE`,
      [content.investigationId],
    );
    if (Number(result?.version) !== content.resultVersion)
      throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
    const resources: ResourceRef[] = [...investigation.resources];
    for (const ref of content.evidence) {
      const [row] = await planRows(
        c,
        `SELECT * FROM investigation_evidence WHERE id=? AND investigation_id=? FOR SHARE`,
        [ref.id, content.investigationId],
      );
      if (
        !row ||
        ref.version !== 1 ||
        row.content_hash !== ref.hash ||
        row.expired_at ||
        new Date(row.expires_at).getTime() <= now.getTime() ||
        Date.parse(ref.validUntil) > new Date(row.expires_at).getTime()
      )
        throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      const metadata = decodePlanJson(row.metadata_json);
      if (!Array.isArray(metadata?.resources) || !metadata.resources.length)
        throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      resources.push(...metadata.resources);
    }
    if (!this.environment) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    resources.push(...(await this.references(c, content, now)));
    await this.environment.validate(c, content, now);
    await this.investigations.authorize(c, actor, investigation, 'content', resources);
    return [
      ...new Map(resources.map((ref) => [`${ref.type}:${ref.id}`, { type: ref.type, id: ref.id }])).values(),
    ];
  }
}
