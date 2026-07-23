import { approvalFlowManager } from '../auth/approval-flow.js';
import type { ActorContext } from '../auth/actor-context.js';
import type { AnyAgentTool, PolicyDecision, RoleToolPolicy, ToolExecutionContext, ToolPolicy, ToolPolicyReasonCode, ToolResult } from './types.js';

/** Backward-compatible catalog filtering helpers. Runtime authorization uses decideToolPolicy. */
export function isToolAllowed(name: string, policy: ToolPolicy): boolean {
  const allow = policy.allow ?? ['*'];
  const deny = policy.deny ?? [];
  if (deny.includes(name)) return false;
  return allow.includes('*') || allow.includes(name);
}

export function resolveToolPolicy(policy: ToolPolicy): { allowAll: boolean; allowed: Set<string>; denied: Set<string> } {
  const allow = policy.allow ?? ['*'];
  return { allowAll: allow.includes('*'), allowed: new Set(allow), denied: new Set(policy.deny ?? []) };
}

export function applyToolPolicy(tools: AnyAgentTool[], roleName: string, isOwner: boolean, policy: ToolPolicy = { allow: ['*'], deny: [] }): AnyAgentTool[] {
  return tools.filter((tool) => isToolAllowed(tool.name, policy) && (!tool.ownerOnly || (isOwner && roleName === 'admin')));
}

function instanceIdFrom(args: Record<string, unknown>): number | undefined {
  const value = args.instance_id;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function deny(
  reasonCode: Exclude<ToolPolicyReasonCode, 'ALLOW'>,
  actor: ActorContext | undefined,
  tool: AnyAgentTool,
  args: Record<string, unknown>,
): PolicyDecision {
  return {
    allow: false,
    reasonCode,
    actor: actor ? { userId: actor.userId, username: actor.username, roles: actor.roles } : null,
    tool: tool.name,
    resource: { instanceId: instanceIdFrom(args) },
    approvalId: typeof args.approvalId === 'string' ? args.approvalId : undefined,
    requestId: actor?.requestId,
  };
}

/**
 * Deterministic, fail-closed policy check for an LLM tool call. The caller must
 * invoke this immediately before the handler; it is deliberately independent
 * from the model-provided context.
 */
export function decideToolPolicy(
  actor: ActorContext | undefined,
  tool: AnyAgentTool,
  args: Record<string, unknown>,
): PolicyDecision {
  if (!actor) return deny('MISSING_ACTOR', actor, tool, args);
  if (tool.ownerOnly && !actor.roles.includes('admin')) return deny('OWNER_REQUIRED', actor, tool, args);
  if ((tool.requiredPermissions ?? []).some((permission) => !actor.permissions.includes(permission))) {
    return deny('MISSING_PERMISSION', actor, tool, args);
  }
  const instanceId = instanceIdFrom(args);
  if (instanceId !== undefined && actor.instanceScopes[instanceId] === undefined) {
    return deny('INSTANCE_SCOPE_DENIED', actor, tool, args);
  }
  if (tool.requiresApproval) {
    const approvalId = typeof args.approvalId === 'string' ? args.approvalId : '';
    const approval = approvalId ? approvalFlowManager.getRequest(approvalId) : undefined;
    if (!approvalId) return deny('APPROVAL_REQUIRED', actor, tool, args);
    const approvalArgs = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'approvalId'));
    if (
      !approval || approval.status !== 'approved' || approval.operationName !== tool.name ||
      approval.requesterId !== String(actor.userId) ||
      JSON.stringify(approval.operationParams) !== JSON.stringify(approvalArgs)
    ) return deny('INVALID_APPROVAL', actor, tool, args);
  }
  return {
    allow: true,
    reasonCode: 'ALLOW',
    actor: { userId: actor.userId, username: actor.username, roles: actor.roles },
    tool: tool.name,
    resource: { instanceId },
    approvalId: typeof args.approvalId === 'string' ? args.approvalId : undefined,
    requestId: actor.requestId,
  };
}

export async function executeToolWithPolicy(
  actor: ActorContext | undefined,
  tool: AnyAgentTool,
  args: Record<string, unknown>,
): Promise<{ decision: PolicyDecision; result: ToolResult }> {
  const decision = decideToolPolicy(actor, tool, args);
  if (!decision.allow || !actor) {
    return { decision, result: { success: false, errorCode: decision.reasonCode, error: 'Tool access denied' } };
  }
  const context: ToolExecutionContext = {
    actor,
    userId: actor.userId,
    userRole: actor.roles[0],
    instanceId: decision.resource.instanceId,
    policyDecision: decision,
  };
  return { decision, result: await tool.handler(args, context) };
}
