import { createHmac } from 'node:crypto';
import { dbConnection } from '../db-connection.js';
import type { ActorContext } from '../auth/actor-context.js';
import { getToolSecurityDefinition } from '../tools/security-catalog.js';
import type { AnyAgentTool, ToolPolicyResource } from '../tools/types.js';
import { redactSensitiveData, stableJson } from './sensitive-data.js';
import type { ExecuteCodeApprovalScope, ExecuteCodeRiskLevel } from './execute-code-risk.js';

interface ApprovalExecutor {
  execute(sql: string, values?: unknown[]): Promise<[any, unknown?]>;
}

export interface AgentToolPolicySnapshot {
  actorId: number;
  sessionVersion: number;
  roles: readonly string[];
  permissions: readonly string[];
  toolName: string;
  ownerOnly: boolean;
  requiredPermissions: readonly string[];
  security: ReturnType<typeof getToolSecurityDefinition>;
}

export interface AgentToolApprovalBinding {
  bindingHash: string;
  redactedArgs: unknown;
  policySnapshot: AgentToolPolicySnapshot;
}

export interface ApprovalRequestOptions {
  expiresInMs?: number;
  scope?: ExecuteCodeApprovalScope;
  sessionKey?: string;
  riskLevel?: ExecuteCodeRiskLevel;
  maxUses?: number;
}

export interface ApprovalConsumeOptions {
  sessionKey?: string;
  riskLevel?: ExecuteCodeRiskLevel;
}

export type ApprovalConsumeFailure = 'APPROVAL_PENDING' | 'APPROVAL_EXPIRED' | 'INVALID_APPROVAL';
export interface ApprovalConsumeResult {
  approved: boolean;
  failure?: ApprovalConsumeFailure;
}

function normalizeApprovalScope(
  requestedScope: ExecuteCodeApprovalScope | undefined,
  riskLevel: ExecuteCodeRiskLevel,
  sessionKey: string | undefined,
): Exclude<ExecuteCodeApprovalScope, 'none'> {
  // High-risk execution is always a one-shot approval. A session/window grant
  // would make a network or destructive command reusable after review.
  if (riskLevel === 'high') return 'once';
  if (riskLevel === 'medium' && (requestedScope === 'window' || requestedScope === 'session') && sessionKey) {
    return requestedScope;
  }
  return 'once';
}

function approvalArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'approvalId'));
}

export function buildApprovalBinding(
  hmacKey: string,
  actor: ActorContext,
  tool: AnyAgentTool,
  args: Record<string, unknown>,
  resource: ToolPolicyResource,
): AgentToolApprovalBinding {
  const security = getToolSecurityDefinition(tool.name);
  if (!security) throw new Error('SECURITY_METADATA_MISSING');
  if (hmacKey.length < 8) throw new Error('AGENT_APPROVAL_HMAC_KEY_INVALID');

  const rawArgs = approvalArgs(args);
  const policySnapshot: AgentToolPolicySnapshot = Object.freeze({
    actorId: actor.userId,
    sessionVersion: actor.sessionVersion,
    roles: Object.freeze([...actor.roles].sort()),
    permissions: Object.freeze([...actor.permissions].sort()),
    toolName: tool.name,
    ownerOnly: Boolean(tool.ownerOnly),
    requiredPermissions: Object.freeze([
      ...new Set([...security.permissions, ...(tool.requiredPermissions ?? [])]),
    ].sort()),
    security,
  });
  const bindingHash = createHmac('sha256', hmacKey)
    .update(stableJson({ toolName: tool.name, args: rawArgs, resource, policySnapshot }))
    .digest('hex');

  return {
    bindingHash,
    redactedArgs: redactSensitiveData(rawArgs),
    policySnapshot,
  };
}

function configuredHmacKey(): string {
  const key = process.env.AGENT_APPROVAL_HMAC_KEY || process.env.JWT_SECRET_KEY || '';
  if (key.length < 32) throw new Error('AGENT_APPROVAL_HMAC_KEY_INVALID');
  return key;
}

export class AgentToolApprovalService {
  constructor(
    private readonly executorProvider: () => ApprovalExecutor | null = () => dbConnection.getPool() as ApprovalExecutor | null,
    private readonly hmacKey: string = configuredHmacKey(),
  ) {}

  binding(
    actor: ActorContext,
    tool: AnyAgentTool,
    args: Record<string, unknown>,
    resource: ToolPolicyResource,
  ): AgentToolApprovalBinding {
    return buildApprovalBinding(this.hmacKey, actor, tool, args, resource);
  }

  async submit(
    actor: ActorContext,
    tool: AnyAgentTool,
    args: Record<string, unknown>,
    resource: ToolPolicyResource,
    expiresInOrOptions: number | ApprovalRequestOptions = {},
  ): Promise<{ id: string; expiresAt: Date }> {
    const executor = this.executor();
    const binding = this.binding(actor, tool, args, resource);
    const options: ApprovalRequestOptions = typeof expiresInOrOptions === 'number'
      ? { expiresInMs: expiresInOrOptions }
      : expiresInOrOptions;
    const riskLevel = options.riskLevel ?? 'high';
    const scope = normalizeApprovalScope(options.scope, riskLevel, options.sessionKey);
    const maxUses = Math.min(Math.max(Math.trunc(options.maxUses ?? (scope === 'once' ? 1 : 100)), 1), 1000);
    const defaultExpiry = scope === 'window' ? 5 * 60_000 : scope === 'session' ? 30 * 60_000 : 30 * 60_000;
    const expiresInMs = options.expiresInMs ?? defaultExpiry;
    const expiresAt = new Date(Date.now() + Math.min(Math.max(expiresInMs, 60_000), 24 * 60 * 60_000));
    const [pendingRows] = await executor.execute(
      `SELECT id, expires_at
       FROM agent_tool_approvals
       WHERE requester_id = ? AND tool_name = ? AND binding_hash = ?
         AND status = 'pending' AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [actor.userId, tool.name, binding.bindingHash],
    );
    const pending = Array.isArray(pendingRows) ? pendingRows[0] : undefined;
    if (pending?.id !== undefined) {
      return { id: String(pending.id), expiresAt: new Date(pending.expires_at) };
    }
    const [result] = await executor.execute(
      `INSERT INTO agent_tool_approvals
       (tool_name, requester_id, binding_hash, args_redacted, resource_json, policy_snapshot,
        status, scope, session_key, risk_level, max_uses, used_count, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?)`,
      [
        tool.name,
        actor.userId,
        binding.bindingHash,
        JSON.stringify(binding.redactedArgs),
        JSON.stringify(resource),
        JSON.stringify(binding.policySnapshot),
        scope,
        options.sessionKey ?? null,
        riskLevel,
        maxUses,
        expiresAt,
      ],
    );
    if (!result?.insertId) throw new Error('AGENT_APPROVAL_CREATE_FAILED');
    return { id: String(result.insertId), expiresAt };
  }

  async review(
    id: string,
    reviewerId: number,
    action: 'approve' | 'reject',
    note?: string,
    scope?: Exclude<ExecuteCodeApprovalScope, 'none'>,
  ): Promise<boolean> {
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(reviewerId) || reviewerId <= 0) return false;
    if (action === 'reject') {
      const [result] = await this.executor().execute(
        `UPDATE agent_tool_approvals
         SET status = 'rejected', reviewer_id = ?, review_note = ?, reviewed_at = NOW()
         WHERE id = ? AND status = 'pending' AND expires_at > NOW()`,
        [reviewerId, note?.slice(0, 1000) ?? null, id],
      );
      return Number(result?.affectedRows) === 1;
    }
    const [result] = await this.executor().execute(
      `UPDATE agent_tool_approvals
       SET status = 'approved', reviewer_id = ?, review_note = ?, reviewed_at = NOW(),
           scope = CASE
             WHEN risk_level = 'high' THEN 'once'
             WHEN risk_level = 'medium' AND ? = 'window' AND session_key IS NOT NULL THEN 'window'
             WHEN risk_level = 'medium' AND ? = 'session' AND session_key IS NOT NULL AND scope = 'session' THEN 'session'
             ELSE 'once'
           END,
           expires_at = CASE
             WHEN risk_level = 'medium' AND ? = 'window' AND session_key IS NOT NULL
               THEN LEAST(expires_at, DATE_ADD(NOW(), INTERVAL 5 MINUTE))
             ELSE expires_at
           END,
           max_uses = CASE WHEN risk_level = 'high' OR ? = 'once' THEN 1 ELSE max_uses END
       WHERE id = ? AND status = 'pending' AND expires_at > NOW()`,
      [reviewerId, note?.slice(0, 1000) ?? null, scope ?? 'once', scope ?? 'once', scope ?? 'once', scope ?? 'once', id],
    );
    return Number(result?.affectedRows) === 1;
  }

  async consumeApproved(
    id: string,
    bindingHash: string,
    requesterId: number,
    options?: ApprovalConsumeOptions,
  ): Promise<boolean> {
    return (await this.consumeApprovedDetailed(id, bindingHash, requesterId, options)).approved;
  }

  async consumeApprovedDetailed(
    id: string,
    bindingHash: string,
    requesterId: number,
    options?: ApprovalConsumeOptions,
  ): Promise<ApprovalConsumeResult> {
    if (!/^\d+$/.test(id) || !/^[a-f0-9]{64}$/.test(bindingHash) || !Number.isSafeInteger(requesterId)) {
      return { approved: false, failure: 'INVALID_APPROVAL' };
    }
    if (options) {
      const [rows] = await this.executor().execute(
        `SELECT binding_hash, status, scope, session_key, risk_level, used_count, max_uses, expires_at
         FROM agent_tool_approvals WHERE id = ? AND requester_id = ? LIMIT 1`,
        [id, requesterId],
      );
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (!row) return { approved: false, failure: 'INVALID_APPROVAL' };
      if (row.status === 'pending') return { approved: false, failure: 'APPROVAL_PENDING' };
      if (row.status !== 'approved' || new Date(row.expires_at).getTime() <= Date.now()) {
        return { approved: false, failure: 'APPROVAL_EXPIRED' };
      }
      const riskRank: Record<ExecuteCodeRiskLevel, number> = { low: 1, medium: 2, high: 3 };
      const storedRisk = riskRank[row.risk_level as ExecuteCodeRiskLevel] ?? 3;
      const requestedRisk = riskRank[options.riskLevel ?? 'high'] ?? 3;
      if (requestedRisk > storedRisk) return { approved: false, failure: 'INVALID_APPROVAL' };
      if (row.scope === 'once') {
        if (row.binding_hash !== bindingHash) return { approved: false, failure: 'INVALID_APPROVAL' };
        const [result] = await this.executor().execute(
          `UPDATE agent_tool_approvals SET status = 'consumed', consumed_at = NOW()
           WHERE id = ? AND requester_id = ? AND binding_hash = ? AND status = 'approved' AND expires_at > NOW()`,
          [id, requesterId, bindingHash],
        );
        return Number(result?.affectedRows) === 1
          ? { approved: true }
          : { approved: false, failure: 'INVALID_APPROVAL' };
      }
      if (!options.sessionKey || !row.session_key || options.sessionKey !== row.session_key) {
        return { approved: false, failure: 'INVALID_APPROVAL' };
      }
      if (Number(row.used_count ?? 0) === 0 && row.binding_hash !== bindingHash) {
        return { approved: false, failure: 'INVALID_APPROVAL' };
      }
      const [result] = await this.executor().execute(
        `UPDATE agent_tool_approvals SET used_count = used_count + 1, consumed_at = NOW()
         WHERE id = ? AND requester_id = ? AND status = 'approved' AND session_key = ?
           AND used_count < max_uses AND expires_at > NOW()`,
        [id, requesterId, options.sessionKey],
      );
      return Number(result?.affectedRows) === 1
        ? { approved: true }
        : { approved: false, failure: 'INVALID_APPROVAL' };
    }
    const [result] = await this.executor().execute(
      `UPDATE agent_tool_approvals
       SET status = 'consumed', consumed_at = NOW()
       WHERE binding_hash = ? AND id = ? AND requester_id = ?
         AND status = 'approved' AND expires_at > NOW()`,
      [bindingHash, id, requesterId],
    );
    return Number(result?.affectedRows) === 1
      ? { approved: true }
      : { approved: false, failure: 'INVALID_APPROVAL' };
  }

  async pending(limit = 100): Promise<unknown[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const [rows] = await this.executor().execute(
      `SELECT id, tool_name, requester_id, args_redacted, resource_json, policy_snapshot,
              status, scope, session_key, risk_level, max_uses, used_count, expires_at, created_at
       FROM agent_tool_approvals
       WHERE status = 'pending' AND expires_at > NOW()
       ORDER BY created_at ASC LIMIT ?`,
      [safeLimit],
    );
    return Array.isArray(rows) ? rows : [];
  }

  private executor(): ApprovalExecutor {
    const executor = this.executorProvider();
    if (!executor) throw new Error('AGENT_APPROVAL_STORE_UNAVAILABLE');
    return executor;
  }
}

let singleton: AgentToolApprovalService | undefined;

export function getAgentToolApprovalService(): AgentToolApprovalService {
  singleton ??= new AgentToolApprovalService();
  return singleton;
}
