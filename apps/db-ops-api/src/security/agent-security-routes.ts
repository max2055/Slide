import type { FastifyInstance } from 'fastify';
import type { ActorContext } from '../auth/actor-context.js';
import { requirePermission } from '../auth/require-permission.js';
import { agentManagementService } from '../agent-management-service.js';
import { agentSecurityPolicyService, DEFAULT_AGENT_ID, type AgentSecurityPolicyUpdate } from './agent-security-policy-service.js';
import { agentToolAuditService, type AgentToolAuditFilters } from './agent-tool-audit-service.js';
import { sandboxClient } from './sandbox-client.js';
import { agentSandboxConfigService } from './agent-sandbox-config-service.js';
import { auditLogManager } from '../audit/audit-log.js';
import { securityEventService } from './security-event-service.js';
import { agentExecutionConfigService, type AgentExecutionConfigUpdate } from './agent-execution-config-service.js';

const SUPPORTED_AGENT_IDS = new Set([DEFAULT_AGENT_ID]);
const CODE_RUNTIMES = new Set(['shell', 'sh', 'bash', 'python', 'python3', 'node', 'nodejs']);

function sandboxReady(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false;
  const value = status as Record<string, any>;
  return value.status === 'ok'
    && value.daemon?.reachable === true
    && value.daemon?.rootless === true
    && Array.isArray(value.policy?.runtimes)
    && value.policy.runtimes.some((runtime: unknown) => typeof runtime === 'string' && CODE_RUNTIMES.has(runtime));
}

function restrictedNetworkReady(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false;
  const value = status as Record<string, any>;
  return value.status === 'ok'
    && value.daemon?.reachable === true
    && value.daemon?.rootless === true
    && value.policy?.network === 'restricted';
}

function strictSandboxConfigBody(value: unknown): value is { enabled: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 1 && entries[0]?.[0] === 'enabled' && typeof entries[0][1] === 'boolean';
}

function strictExecutionConfigBody(value: unknown): value is AgentExecutionConfigUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([key, item]) =>
    !['approvalEnabled', 'restrictedNetworkEnabled'].includes(key) || typeof item !== 'boolean')) return false;
  return true;
}

function validName(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[a-zA-Z0-9._-]+$/.test(value);
}

function safeInt(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : NaN;
}

function safeDate(value: unknown): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export async function registerAgentSecurityRoutes(
  fastify: FastifyInstance,
  verifyToken: (request: any, reply: any) => Promise<unknown>,
): Promise<void> {
  fastify.get('/api/agent/security/policies', {
    preHandler: [verifyToken, requirePermission('ai:view')],
  }, async (_request, reply) => {
    const [tools] = await Promise.all([agentManagementService.listTools()]);
    return reply.send({
      agents: [{ id: DEFAULT_AGENT_ID, name: 'Slide' }],
      policies: [agentSecurityPolicyService.get(DEFAULT_AGENT_ID)],
      tools,
      skills: agentManagementService.listSkills(),
    });
  });

  fastify.put('/api/agent/security/policies/:agentId', {
    preHandler: [verifyToken, requirePermission('admin:*')],
  }, async (request, reply) => {
    const actor = (request as any).user as ActorContext;
    const agentId = String((request.params as { agentId?: unknown }).agentId ?? '');
    if (!SUPPORTED_AGENT_IDS.has(agentId)) return reply.code(404).send({ reasonCode: 'AGENT_NOT_FOUND' });
    const body = request.body as AgentSecurityPolicyUpdate;
    try {
      const [tools] = await Promise.all([agentManagementService.listTools()]);
      const toolNames = new Set(tools.map((tool) => tool.name));
      const skillNames = new Set(agentManagementService.listSkills().map((skill) => skill.name));
      if (body?.toolAllowlist !== null && (!Array.isArray(body?.toolAllowlist)
        || body.toolAllowlist.some((name) => !toolNames.has(name)))) {
        return reply.code(400).send({ reasonCode: 'AGENT_TOOL_ALLOWLIST_INVALID' });
      }
      if (body?.skillAllowlist !== null && (!Array.isArray(body?.skillAllowlist)
        || body.skillAllowlist.some((name) => !skillNames.has(name)))) {
        return reply.code(400).send({ reasonCode: 'AGENT_SKILL_ALLOWLIST_INVALID' });
      }
      const policy = await agentSecurityPolicyService.update(agentId, body, actor.userId);
      return reply.send({ policy });
    } catch (error) {
      const reasonCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'AGENT_POLICY_UPDATE_FAILED';
      return reply.code(reasonCode === 'AGENT_POLICY_UPDATE_FAILED' ? 500 : 400).send({ reasonCode });
    }
  });

  fastify.get('/api/agent/security/policies/:agentId/history', {
    preHandler: [verifyToken, requirePermission('audit:view')],
  }, async (request, reply) => {
    const agentId = String((request.params as { agentId?: unknown }).agentId ?? '');
    if (!SUPPORTED_AGENT_IDS.has(agentId)) return reply.code(404).send({ reasonCode: 'AGENT_NOT_FOUND' });
    return reply.send({ records: await agentSecurityPolicyService.history(agentId) });
  });

  fastify.get('/api/agent/security/audit', {
    preHandler: [verifyToken, requirePermission('audit:view')],
  }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const actorId = safeInt(query.actorId);
    const cursor = safeInt(query.cursor);
    const limit = safeInt(query.limit);
    if (Number.isNaN(actorId) || Number.isNaN(cursor) || Number.isNaN(limit)
      || (query.agentId !== undefined && !validName(query.agentId, 64))
      || (query.toolName !== undefined && !validName(query.toolName))
      || (query.reasonCode !== undefined && !validName(query.reasonCode, 64))
      || (query.phase !== undefined && query.phase !== 'decision' && query.phase !== 'result')
      || (query.allowed !== undefined && query.allowed !== 'true' && query.allowed !== 'false')) {
      return reply.code(400).send({ reasonCode: 'AGENT_AUDIT_QUERY_INVALID' });
    }
    const from = safeDate(query.from);
    const to = safeDate(query.to);
    if ((query.from !== undefined && !from) || (query.to !== undefined && !to) || (from && to && from > to)) {
      return reply.code(400).send({ reasonCode: 'AGENT_AUDIT_QUERY_INVALID' });
    }
    const filters: AgentToolAuditFilters = {
      agentId: query.agentId as string | undefined,
      actorId,
      toolName: query.toolName as string | undefined,
      reasonCode: query.reasonCode as string | undefined,
      phase: query.phase as 'decision' | 'result' | undefined,
      allowed: query.allowed === undefined ? undefined : query.allowed === 'true',
      from,
      to,
      cursor,
      limit,
    };
    return reply.send(await agentToolAuditService.list(filters));
  });

  fastify.get('/api/agent/security/audit/:id', {
    preHandler: [verifyToken, requirePermission('audit:view')],
  }, async (request, reply) => {
    const id = safeInt((request.params as { id?: unknown }).id);
    if (!id || Number.isNaN(id)) return reply.code(400).send({ reasonCode: 'AGENT_AUDIT_ID_INVALID' });
    const record = await agentToolAuditService.detail(id);
    return record ? reply.send({ record }) : reply.code(404).send({ reasonCode: 'AGENT_AUDIT_NOT_FOUND' });
  });

  fastify.get('/api/agent/security/sandbox', {
    preHandler: [verifyToken, requirePermission('audit:view')],
  }, async (_request, reply) => {
    if (!sandboxClient.configured()) return reply.send({ configured: false, reachable: false });
    try {
      const status = await sandboxClient.status(AbortSignal.timeout(4000));
      return reply.send({ configured: true, reachable: true, status });
    } catch {
      return reply.send({ configured: true, reachable: false });
    }
  });

  fastify.get('/api/agent/security/config', {
    preHandler: [verifyToken, requirePermission('admin:*')],
  }, async (_request, reply) => reply.send(await agentExecutionConfigService.get()));

  fastify.put('/api/agent/security/config', {
    preHandler: [verifyToken, requirePermission('admin:*')],
  }, async (request, reply) => {
    const actor = (request as any).user as ActorContext;
    if (!strictExecutionConfigBody(request.body)) {
      return reply.code(400).send({ reasonCode: 'EXECUTION_CONFIG_UPDATE_INVALID' });
    }
    const current = await agentExecutionConfigService.get();
    if (request.body.restrictedNetworkEnabled && !current.restrictedNetworkEnabled) {
      let ready = false;
      if (sandboxClient.configured()) {
        try {
          ready = restrictedNetworkReady(await sandboxClient.status(AbortSignal.timeout(4000)));
        } catch {
          ready = false;
        }
      }
      if (!ready) {
        await securityEventService.record({
          eventType: 'agent_sandbox_config_denied',
          reasonCode: 'SANDBOX_NETWORK_NOT_READY',
          actorId: actor.userId,
          resourceType: 'system-config',
          resourceId: 'agent_sandbox_network_enabled',
          requestId: actor.requestId,
        }).catch(() => undefined);
        return reply.code(503).send({ reasonCode: 'SANDBOX_NETWORK_NOT_READY' });
      }
    }
    try {
      const updated = await agentExecutionConfigService.set(request.body, actor.userId);
      for (const [configKey, oldValue, newValue] of [
        ['agent_tool_approval_enabled', current.approvalEnabled, updated.approvalEnabled],
        ['agent_sandbox_network_enabled', current.restrictedNetworkEnabled, updated.restrictedNetworkEnabled],
      ] as const) {
        if (oldValue !== newValue) {
          await auditLogManager.logConfigChange({
            userId: String(actor.userId),
            username: actor.username,
            configKey,
            oldValue,
            newValue,
            clientIp: request.ip,
          });
        }
      }
      return reply.send(updated);
    } catch (error) {
      const reasonCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'EXECUTION_CONFIG_UPDATE_FAILED';
      return reply.code(reasonCode === 'EXECUTION_CONFIG_UPDATE_INVALID' ? 400 : 500).send({ reasonCode });
    }
  });

  fastify.get('/api/agent/security/sandbox/config', {
    preHandler: [verifyToken, requirePermission('admin:*')],
  }, async (_request, reply) => reply.send(await agentSandboxConfigService.get()));

  fastify.put('/api/agent/security/sandbox/config', {
    preHandler: [verifyToken, requirePermission('admin:*')],
  }, async (request, reply) => {
    const actor = (request as any).user as ActorContext;
    if (!strictSandboxConfigBody(request.body)) {
      return reply.code(400).send({ reasonCode: 'SANDBOX_CONFIG_UPDATE_INVALID' });
    }
    const current = await agentSandboxConfigService.get();
    if (request.body.enabled) {
      let ready = false;
      if (sandboxClient.configured()) {
        try {
          ready = sandboxReady(await sandboxClient.status(AbortSignal.timeout(4000)));
        } catch {
          ready = false;
        }
      }
      if (!ready) {
        await securityEventService.record({
          eventType: 'agent_sandbox_config_denied',
          reasonCode: 'SANDBOX_NOT_READY',
          actorId: actor.userId,
          resourceType: 'system-config',
          resourceId: 'agent_sandbox_enabled',
          requestId: actor.requestId,
        }).catch(() => undefined);
        return reply.code(503).send({ reasonCode: 'SANDBOX_NOT_READY' });
      }
    }
    try {
      const updated = await agentSandboxConfigService.set(request.body.enabled, actor.userId);
      await auditLogManager.logConfigChange({
        userId: String(actor.userId),
        username: actor.username,
        configKey: 'agent_sandbox_enabled',
        oldValue: current.enabled,
        newValue: updated.enabled,
        clientIp: request.ip,
      });
      return reply.send(updated);
    } catch (error) {
      const reasonCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'SANDBOX_CONFIG_UPDATE_FAILED';
      await auditLogManager.logConfigChange({
        userId: String(actor.userId),
        username: actor.username,
        configKey: 'agent_sandbox_enabled',
        oldValue: current.enabled,
        newValue: request.body.enabled,
        clientIp: request.ip,
        result: 'failure',
        errorMessage: reasonCode,
      }).catch((auditError) => console.error('[AgentSecurity] Failed to persist sandbox config failure audit:', auditError));
      return reply.code(reasonCode === 'SANDBOX_CONFIG_UPDATE_INVALID' ? 400 : 500).send({ reasonCode });
    }
  });
}
