import { createHmac } from 'node:crypto';
import { dbConnection } from '../db-connection.js';
import type { ActorContext } from '../auth/actor-context.js';
import { getToolSecurityDefinition } from '../tools/security-catalog.js';
import type { AnyAgentTool, ToolPolicyResource } from '../tools/types.js';
import { redactSensitiveData, stableJson } from './sensitive-data.js';

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
    expiresInMs = 30 * 60_000,
  ): Promise<{ id: string; expiresAt: Date }> {
    const executor = this.executor();
    const binding = this.binding(actor, tool, args, resource);
    const expiresAt = new Date(Date.now() + Math.min(Math.max(expiresInMs, 60_000), 24 * 60 * 60_000));
    const [result] = await executor.execute(
      `INSERT INTO agent_tool_approvals
       (tool_name, requester_id, binding_hash, args_redacted, resource_json, policy_snapshot, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        tool.name,
        actor.userId,
        binding.bindingHash,
        JSON.stringify(binding.redactedArgs),
        JSON.stringify(resource),
        JSON.stringify(binding.policySnapshot),
        expiresAt,
      ],
    );
    if (!result?.insertId) throw new Error('AGENT_APPROVAL_CREATE_FAILED');
    return { id: String(result.insertId), expiresAt };
  }

  async review(id: string, reviewerId: number, action: 'approve' | 'reject', note?: string): Promise<boolean> {
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(reviewerId) || reviewerId <= 0) return false;
    const status = action === 'approve' ? 'approved' : 'rejected';
    const [result] = await this.executor().execute(
      `UPDATE agent_tool_approvals
       SET status = ?, reviewer_id = ?, review_note = ?, reviewed_at = NOW()
       WHERE id = ? AND status = 'pending' AND expires_at > NOW()`,
      [status, reviewerId, note?.slice(0, 1000) ?? null, id],
    );
    return Number(result?.affectedRows) === 1;
  }

  async consumeApproved(id: string, bindingHash: string, requesterId: number): Promise<boolean> {
    if (!/^\d+$/.test(id) || !/^[a-f0-9]{64}$/.test(bindingHash) || !Number.isSafeInteger(requesterId)) return false;
    const [result] = await this.executor().execute(
      `UPDATE agent_tool_approvals
       SET status = 'consumed', consumed_at = NOW()
       WHERE binding_hash = ? AND id = ? AND requester_id = ?
         AND status = 'approved' AND expires_at > NOW()`,
      [bindingHash, id, requesterId],
    );
    return Number(result?.affectedRows) === 1;
  }

  async pending(limit = 100): Promise<unknown[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const [rows] = await this.executor().execute(
      `SELECT id, tool_name, requester_id, args_redacted, resource_json, policy_snapshot,
              status, expires_at, created_at
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
