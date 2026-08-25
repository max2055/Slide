import type { ActorContext } from '../auth/actor-context.js';
import type { AnyAgentTool, PolicyDecision, ToolExecutionContext, ToolPolicy, ToolPolicyReasonCode, ToolResult } from './types.js';
import { getToolSecurityDefinition } from './security-catalog.js';
import { hasPermission } from '../auth/require-permission.js';
import { resolveToolResource, resolveToolResourceFromArgs } from './resource-resolver.js';
import type { ToolPolicyResource } from './types.js';
import { getAgentToolApprovalService } from '../security/agent-tool-approval-service.js';
import type { ApprovalConsumeOptions, ApprovalConsumeResult, ApprovalRequestOptions } from '../security/agent-tool-approval-service.js';
import { agentToolAuditService, type AgentToolAuditRecord } from '../security/agent-tool-audit-service.js';
import { agentSecurityPolicyService } from '../security/agent-security-policy-service.js';
import { classifyExecuteCodeRisk, type ExecuteCodeRisk } from '../security/execute-code-risk.js';

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

function deny(
  reasonCode: Exclude<ToolPolicyReasonCode, 'ALLOW'>,
  actor: ActorContext | undefined,
  tool: AnyAgentTool,
  args: Record<string, unknown>,
  resource: ToolPolicyResource = resolveToolResourceFromArgs(tool.name, args),
): PolicyDecision {
  return {
    allow: false,
    reasonCode,
    actor: actor ? { userId: actor.userId, username: actor.username, roles: actor.roles } : null,
    tool: tool.name,
    resource,
    approvalId: typeof args.approvalId === 'string' ? args.approvalId : undefined,
    requestId: actor?.requestId,
  };
}

function actorHasPermission(actor: ActorContext, permission: string): boolean {
  return hasPermission(new Set(actor.permissions), permission);
}

function hasGlobalInstanceAccess(actor: ActorContext): boolean {
  return actorHasPermission(actor, 'instance:*');
}

function hasRequiredInstanceLevel(
  actor: ActorContext,
  instanceId: number,
  writeRequired: boolean,
): boolean {
  if (hasGlobalInstanceAccess(actor)) return true;
  const level = actor.instanceScopes[instanceId];
  if (!level) return false;
  return !writeRequired || level === 'read-write' || level === 'admin';
}

export function canActorDiscoverTool(actor: ActorContext, tool: AnyAgentTool): boolean {
  const security = getToolSecurityDefinition(tool.name);
  if (!security || security.audience !== 'actor') return false;
  if (tool.ownerOnly && !actor.roles.includes('admin')) return false;
  const permissions = new Set([...security.permissions, ...(tool.requiredPermissions ?? [])]);
  return [...permissions].every((permission) => actorHasPermission(actor, permission));
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
  resolvedResource: ToolPolicyResource = resolveToolResourceFromArgs(tool.name, args),
  approvalConsumed = false,
  approvalRequiredOverride?: boolean,
): PolicyDecision {
  const security = getToolSecurityDefinition(tool.name);
  if (!security) return deny('SECURITY_METADATA_MISSING', actor, tool, args, resolvedResource);
  if (!actor) return deny('MISSING_ACTOR', actor, tool, args, resolvedResource);
  if (security.audience !== 'actor') return deny('INTERNAL_TOOL_DENIED', actor, tool, args, resolvedResource);
  if (tool.ownerOnly && !actor.roles.includes('admin')) return deny('OWNER_REQUIRED', actor, tool, args, resolvedResource);
  const requiredPermissions = new Set([
    ...security.permissions,
    ...(tool.requiredPermissions ?? []),
  ]);
  if ([...requiredPermissions].some((permission) => !actorHasPermission(actor, permission))) {
    return deny('MISSING_PERMISSION', actor, tool, args, resolvedResource);
  }
  if (resolvedResource.error) {
    return deny(resolvedResource.error, actor, tool, args, resolvedResource);
  }
  const instanceId = resolvedResource.instanceId;
  if (instanceId !== undefined && !hasRequiredInstanceLevel(actor, instanceId, false)) {
    return deny('INSTANCE_SCOPE_DENIED', actor, tool, args, resolvedResource);
  }
  if (instanceId !== undefined && security.effect === 'write' && !hasRequiredInstanceLevel(actor, instanceId, true)) {
    return deny('INSTANCE_SCOPE_LEVEL_DENIED', actor, tool, args, resolvedResource);
  }
  if (approvalRequiredOverride ?? (tool.requiresApproval || security.approval !== 'never')) {
    const approvalId = typeof args.approvalId === 'string' ? args.approvalId : '';
    if (!approvalId) return deny('APPROVAL_REQUIRED', actor, tool, args, resolvedResource);
    if (!approvalConsumed) return deny('INVALID_APPROVAL', actor, tool, args, resolvedResource);
  }
  return {
    allow: true,
    reasonCode: 'ALLOW',
    actor: { userId: actor.userId, username: actor.username, roles: actor.roles },
    tool: tool.name,
    resource: resolvedResource,
    approvalId: typeof args.approvalId === 'string' ? args.approvalId : undefined,
    requestId: actor.requestId,
  };
}

export interface ToolApprovalAuthorizer {
  consume(
    actor: ActorContext,
    tool: AnyAgentTool,
    args: Record<string, unknown>,
    resource: ToolPolicyResource,
    options?: ApprovalConsumeOptions,
  ): Promise<boolean | ApprovalConsumeResult>;
}

export interface ToolApprovalRequester {
  submit(
    actor: ActorContext,
    tool: AnyAgentTool,
    args: Record<string, unknown>,
    resource: ToolPolicyResource,
    options?: ApprovalRequestOptions,
  ): Promise<{ id: string; expiresAt: Date }>;
}

export interface ToolExecutionOptions {
  sessionKey?: string;
  approvalRequester?: ToolApprovalRequester;
}

export interface ToolAuditRecorder {
  record(record: AgentToolAuditRecord): Promise<void>;
}

const persistentApprovalAuthorizer: ToolApprovalAuthorizer = {
  async consume(actor, tool, args, resource, options): Promise<boolean | ApprovalConsumeResult> {
    const approvalId = typeof args.approvalId === 'string' ? args.approvalId : '';
    if (!approvalId) return false;
    try {
      const service = getAgentToolApprovalService();
      const binding = service.binding(actor, tool, args, resource);
      return await service.consumeApprovedDetailed(approvalId, binding.bindingHash, actor.userId, options);
    } catch {
      return false;
    }
  },
};

export async function executeToolWithPolicy(
  actor: ActorContext | undefined,
  tool: AnyAgentTool,
  args: Record<string, unknown>,
  resourceResolver: (toolName: string, args: Record<string, unknown>) => Promise<ToolPolicyResource> = resolveToolResource,
  approvalAuthorizer: ToolApprovalAuthorizer = persistentApprovalAuthorizer,
  auditRecorder: ToolAuditRecorder = agentToolAuditService,
  agentId?: string,
  executionOptions?: ToolExecutionOptions,
): Promise<{ decision: PolicyDecision; result: ToolResult }> {
  const resource = await resourceResolver(tool.name, args);
  const security = getToolSecurityDefinition(tool.name);
  const risk: ExecuteCodeRisk | undefined = tool.name === 'execute_code'
    ? classifyExecuteCodeRisk({
      runtime: String(args.runtime ?? ''),
      code: String(args.code ?? ''),
      files: Array.isArray(args.files) ? args.files : undefined,
    })
    : undefined;
  const approvalRequired = risk?.requiresApproval ?? Boolean(tool.requiresApproval || (security && security.approval !== 'never'));
  const approvalOptions: ApprovalConsumeOptions | undefined = risk?.requiresApproval
    ? { sessionKey: executionOptions?.sessionKey, riskLevel: risk.level }
    : undefined;
  const approvalOutcome = actor && approvalRequired && typeof args.approvalId === 'string'
    ? await approvalAuthorizer.consume(actor, tool, args, resource, approvalOptions)
    : false;
  const approvalConsumed = typeof approvalOutcome === 'boolean' ? approvalOutcome : approvalOutcome.approved;
  const agentPolicy = agentId ? agentSecurityPolicyService.get(agentId) : undefined;
  const agentDecision = agentId && security
    ? agentSecurityPolicyService.evaluateTool(agentId, tool.name, security.effect, resource)
    : { allowed: true };
  let decision = agentDecision.allowed
    ? decideToolPolicy(actor, tool, args, resource, approvalConsumed, approvalRequired)
    : deny(agentDecision.reasonCode!, actor, tool, args, resource);
  if (!approvalConsumed && typeof approvalOutcome !== 'boolean' && approvalOutcome.failure) {
    decision = { ...decision, reasonCode: approvalOutcome.failure };
  }
  if (risk) {
    decision = { ...decision, riskLevel: risk.level, approvalScope: risk.scope };
  }
  if (actor) {
    try {
      await auditRecorder.record({ phase: 'decision', actor, decision, args, agentId, agentPolicy });
    } catch {
      if (decision.allow) {
        decision = deny('AUDIT_UNAVAILABLE', actor, tool, args, resource);
        return { decision, result: { success: false, errorCode: decision.reasonCode, error: 'Tool access denied' } };
      }
    }
  }

  // A tool call without an approval id is itself the approval request. Persist
  // it before returning the policy denial so the operator can review it.
  if (actor && decision.reasonCode === 'APPROVAL_REQUIRED') {
    try {
      const requestOptions: ApprovalRequestOptions | undefined = risk?.requiresApproval
        ? {
          scope: risk.scope,
          sessionKey: executionOptions?.sessionKey,
          riskLevel: risk.level,
        }
        : undefined;
      const approval = await (executionOptions?.approvalRequester ?? getAgentToolApprovalService()).submit(
        actor,
        tool,
        args,
        resource,
        requestOptions,
      );
      decision = { ...decision, approvalId: approval.id, requestId: approval.id };
      return {
        decision,
        result: {
          success: false,
          errorCode: decision.reasonCode,
          error: 'Tool access requires approval',
          data: {
            approvalId: approval.id,
            expiresAt: approval.expiresAt.toISOString(),
            ...(risk ? { riskLevel: risk.level, approvalScope: risk.scope } : {}),
          },
        },
      };
    } catch (error) {
      console.error('[AgentToolApproval] Failed to persist approval request:', error);
      return {
        decision: deny('AUDIT_UNAVAILABLE', actor, tool, args, resource),
        result: { success: false, errorCode: 'AUDIT_UNAVAILABLE', error: 'Approval request unavailable' },
      };
    }
  }
  if (!decision.allow && (decision.reasonCode === 'APPROVAL_PENDING' || decision.reasonCode === 'APPROVAL_EXPIRED')) {
    return {
      decision,
      result: {
        success: false,
        errorCode: decision.reasonCode,
        error: decision.reasonCode === 'APPROVAL_PENDING'
          ? 'Approval is pending operator review'
          : 'Approval has expired or was already consumed',
        data: { approvalId: args.approvalId, status: decision.reasonCode === 'APPROVAL_PENDING' ? 'pending' : 'expired' },
      },
    };
  }
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
  let result: ToolResult;
  try {
    result = await tool.handler(args, context);
  } catch {
    console.error(`[AgentTool] Handler failed for ${tool.name}`);
    result = { success: false, errorCode: 'TOOL_EXECUTION_FAILED', error: 'Tool execution failed' };
  }
  try {
    await auditRecorder.record({ phase: 'result', actor, decision, args, result, agentId, agentPolicy });
  } catch (error) {
    console.error('[AgentToolAudit] Failed to persist tool result:', error);
    if (tool.name === 'execute_code') {
      return {
        decision,
        result: { success: false, errorCode: 'AUDIT_UNAVAILABLE', error: 'Tool result unavailable' },
      };
    }
  }
  return { decision, result };
}
