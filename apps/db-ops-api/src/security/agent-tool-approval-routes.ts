import type { FastifyInstance } from 'fastify';
import type { ActorContext } from '../auth/actor-context.js';
import { requirePermission } from '../auth/require-permission.js';
import { getPlatformTool } from '../adapter/get-agent-engine.js';
import { canActorDiscoverTool, decideToolPolicy } from '../tools/policy.js';
import { resolveToolResource } from '../tools/resource-resolver.js';
import { getAgentToolApprovalService } from './agent-tool-approval-service.js';
import { credentialReferenceService } from './credential-reference-service.js';
import { getToolSecurityDefinition } from '../tools/security-catalog.js';
import { classifyExecuteCodeRisk } from './execute-code-risk.js';
import { agentExecutionConfigService } from './agent-execution-config-service.js';

export async function registerAgentToolApprovalRoutes(
  fastify: FastifyInstance,
  verifyToken: (request: any, reply: any) => Promise<unknown>,
): Promise<void> {
  fastify.post('/api/agent/credentials', {
    preHandler: [verifyToken],
  }, async (request, reply) => {
    const actor = (request as any).user as ActorContext;
    const body = request.body as { toolName?: unknown; secret?: unknown; expiresInMs?: unknown };
    if (typeof body?.toolName !== 'string' || typeof body.secret !== 'string' || !body.secret) {
      return reply.code(400).send({ reasonCode: 'CREDENTIAL_REFERENCE_INPUT_INVALID' });
    }
    const tool = await getPlatformTool(body.toolName);
    const security = tool ? getToolSecurityDefinition(tool.name) : undefined;
    if (!tool || !security || security.credentials !== 'use' || !canActorDiscoverTool(actor, tool)) {
      return reply.code(403).send({ reasonCode: 'TOOL_NOT_AVAILABLE' });
    }
    const expiresInMs = Number.isSafeInteger(body.expiresInMs) ? Number(body.expiresInMs) : undefined;
    const credential = await credentialReferenceService.create(
      actor.userId,
      tool.name,
      body.secret,
      expiresInMs,
    );
    return reply.code(201).send({
      credentialRef: credential.ref,
      toolName: tool.name,
      expiresAt: credential.expiresAt.toISOString(),
    });
  });

  fastify.post('/api/agent/approvals', {
    preHandler: [verifyToken, requirePermission('approval:view')],
  }, async (request, reply) => {
    const actor = (request as any).user as ActorContext;
    const body = request.body as { toolName?: unknown; args?: unknown; expiresInMs?: unknown };
    if (typeof body?.toolName !== 'string' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) {
      return reply.code(400).send({ reasonCode: 'AGENT_APPROVAL_INPUT_INVALID' });
    }
    const args = body.args as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(args, 'approvalId')) {
      return reply.code(400).send({ reasonCode: 'AGENT_APPROVAL_INPUT_INVALID' });
    }

    const tool = await getPlatformTool(body.toolName);
    if (!tool || !canActorDiscoverTool(actor, tool)) {
      return reply.code(403).send({ reasonCode: 'TOOL_NOT_AVAILABLE' });
    }
    const security = getToolSecurityDefinition(tool.name);
    const resource = await resolveToolResource(tool.name, args);
    const risk = tool.name === 'execute_code'
      ? classifyExecuteCodeRisk({
        runtime: String(args.runtime ?? ''),
        code: String(args.code ?? ''),
        files: Array.isArray(args.files) ? args.files : undefined,
      })
      : undefined;
    const approvalConfigEnabled = (await agentExecutionConfigService.get()).approvalEnabled;
    const approvalBaseRequired = risk?.requiresApproval
      ?? Boolean(tool.requiresApproval || (security && security.approval !== 'never'));
    const decision = decideToolPolicy(
      actor,
      tool,
      args,
      resource,
      false,
      Boolean(approvalConfigEnabled && approvalBaseRequired),
    );
    if (decision.reasonCode !== 'APPROVAL_REQUIRED') {
      const status = decision.allow ? 409 : 403;
      return reply.code(status).send({
        reasonCode: decision.allow ? 'APPROVAL_NOT_REQUIRED' : decision.reasonCode,
      });
    }

    const expiresInMs = Number.isSafeInteger(body.expiresInMs) ? Number(body.expiresInMs) : undefined;
    const approval = await getAgentToolApprovalService().submit(actor, tool, args, resource, {
      expiresInMs,
      scope: risk?.scope,
      riskLevel: risk?.level,
    });
    return reply.code(201).send({
      approvalId: approval.id,
      toolName: tool.name,
      resource,
      ...(risk ? { riskLevel: risk.level, approvalScope: risk.scope } : {}),
      expiresAt: approval.expiresAt.toISOString(),
    });
  });

  fastify.get('/api/agent/approvals/pending', {
    preHandler: [verifyToken, requirePermission('approval:view')],
  }, async (_request, reply) => {
    try {
      return reply.send({ approvals: await getAgentToolApprovalService().pending() });
    } catch (error) {
      console.error('[AgentToolApproval] Failed to load pending approvals:', error instanceof Error ? error.message : String(error));
      return reply.code(503).send({ reasonCode: 'AGENT_APPROVAL_LIST_UNAVAILABLE' });
    }
  });

  fastify.post('/api/agent/approvals/:id/review', {
    preHandler: [verifyToken, requirePermission('approval:approve')],
  }, async (request, reply) => {
    const actor = (request as any).user as ActorContext;
    const id = String((request.params as { id?: unknown }).id ?? '');
    const body = request.body as { action?: unknown; note?: unknown; scope?: unknown };
    if (body?.action !== 'approve' && body?.action !== 'reject') {
      return reply.code(400).send({ reasonCode: 'AGENT_APPROVAL_REVIEW_INVALID' });
    }
    const reviewed = await getAgentToolApprovalService().review(
      id,
      actor.userId,
      body.action,
      typeof body.note === 'string' ? body.note : undefined,
      body.scope === 'once' || body.scope === 'window' || body.scope === 'session' ? body.scope : undefined,
    );
    return reviewed
      ? reply.send({ success: true, approvalId: id, status: body.action === 'approve' ? 'approved' : 'rejected' })
      : reply.code(409).send({ reasonCode: 'AGENT_APPROVAL_NOT_PENDING' });
  });

  fastify.post('/api/agent/approvals/batch-review', {
    preHandler: [verifyToken, requirePermission('approval:approve')],
  }, async (request, reply) => {
    const actor = (request as any).user as ActorContext;
    const body = request.body as { toolName?: unknown; action?: unknown; note?: unknown; scope?: unknown };
    if (typeof body?.toolName !== 'string' || !body.toolName || body.toolName.length > 128
      || (body.action !== 'approve' && body.action !== 'reject')) {
      return reply.code(400).send({ reasonCode: 'AGENT_APPROVAL_BATCH_REVIEW_INVALID' });
    }
    const approvalIds = await getAgentToolApprovalService().reviewPendingByTool(
      body.toolName,
      actor.userId,
      body.action,
      typeof body.note === 'string' ? body.note : undefined,
      body.scope === 'once' || body.scope === 'window' || body.scope === 'session' ? body.scope : undefined,
    );
    return approvalIds.length > 0
      ? reply.send({
        success: true,
        toolName: body.toolName,
        status: body.action === 'approve' ? 'approved' : 'rejected',
        approvalIds,
        count: approvalIds.length,
      })
      : reply.code(409).send({ reasonCode: 'AGENT_APPROVAL_NOT_PENDING' });
  });
}
