import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import { agentManagementService } from '../agent-management-service.js';
import { registerAgentSecurityRoutes } from './agent-security-routes.js';
import { agentSecurityPolicyService, DEFAULT_AGENT_ID } from './agent-security-policy-service.js';
import { agentToolAuditService } from './agent-tool-audit-service.js';
import { sandboxClient } from './sandbox-client.js';
import { agentSandboxConfigService } from './agent-sandbox-config-service.js';
import { auditLogManager } from '../audit/audit-log.js';

const policy = {
  agentId: DEFAULT_AGENT_ID,
  toolAllowlist: null,
  skillAllowlist: null,
  allowedEffects: ['read'] as const,
  resourceScope: { instanceIds: null, serverIds: null },
  version: 1,
  updatedBy: null,
  updatedAt: null,
};

function actor(permissions: string[]): ActorContext {
  return {
    userId: 7,
    username: 'alice',
    roles: ['admin'],
    permissions,
    sessionVersion: 1,
    instanceScopes: {},
    requestId: 'security-route-test',
  };
}

async function appFor(permissions: string[]) {
  const app = Fastify();
  await registerAgentSecurityRoutes(app, async (request) => { request.user = actor(permissions); });
  return app;
}

describe('Agent security routes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enforces read, audit, and admin permissions at route boundaries', async () => {
    vi.spyOn(agentManagementService, 'listTools').mockResolvedValue([]);
    vi.spyOn(agentManagementService, 'listSkills').mockReturnValue([]);
    vi.spyOn(agentSecurityPolicyService, 'get').mockReturnValue(policy as any);
    const app = await appFor(['ai:view']);

    expect((await app.inject({ method: 'GET', url: '/api/agent/security/policies' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/agent/security/audit' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/agent/security/sandbox' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/agent/security/sandbox/config' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/agent/security/sandbox/config', payload: { enabled: true } })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'PUT',
      url: `/api/agent/security/policies/${DEFAULT_AGENT_ID}`,
      payload: { toolAllowlist: null, skillAllowlist: null, allowedEffects: ['read'], resourceScope: { instanceIds: null, serverIds: null }, changeNote: 'test' },
    })).statusCode).toBe(403);
    await app.close();
  });

  it('validates audit filters before querying storage', async () => {
    const list = vi.spyOn(agentToolAuditService, 'list').mockResolvedValue({ records: [], nextCursor: null });
    const app = await appFor(['audit:view']);

    for (const query of ['limit=0', 'actorId=1.5', 'phase=other', 'allowed=yes', 'from=invalid', 'from=2026-02-02&to=2026-01-01']) {
      expect((await app.inject({ method: 'GET', url: `/api/agent/security/audit?${query}` })).statusCode).toBe(400);
    }
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns status without leaking controller errors', async () => {
    vi.spyOn(sandboxClient, 'configured').mockReturnValue(true);
    vi.spyOn(sandboxClient, 'status').mockRejectedValue(new Error('internal address'));
    const app = await appFor(['audit:view']);

    const response = await app.inject({ method: 'GET', url: '/api/agent/security/sandbox' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: true, reachable: false });
    await app.close();
  });

  it('returns the authoritative global config to administrators', async () => {
    vi.spyOn(agentSandboxConfigService, 'get').mockResolvedValue({ enabled: false, reasonCode: 'SANDBOX_DISABLED' });
    const app = await appFor(['admin:*']);

    const response = await app.inject({ method: 'GET', url: '/api/agent/security/sandbox/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: false, reasonCode: 'SANDBOX_DISABLED' });
    await app.close();
  });

  it.each([
    {},
    { enabled: 'true' },
    { enabled: 1 },
    { enabled: true, fallback: 'host' },
  ])('rejects invalid config mutation body %j', async (payload) => {
    const set = vi.spyOn(agentSandboxConfigService, 'set');
    const app = await appFor(['admin:*']);

    const response = await app.inject({ method: 'PUT', url: '/api/agent/security/sandbox/config', payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ reasonCode: 'SANDBOX_CONFIG_UPDATE_INVALID' });
    expect(set).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    { status: 'ok', daemon: { reachable: false, rootless: true }, policy: { runtimes: ['node'] } },
    { status: 'ok', daemon: { reachable: true, rootless: false }, policy: { runtimes: ['node'] } },
    { status: 'ok', daemon: { reachable: true, rootless: true }, policy: { runtimes: ['ruby'] } },
  ])('fails closed when controller readiness is insufficient', async (status) => {
    vi.spyOn(agentSandboxConfigService, 'get').mockResolvedValue({ enabled: false, reasonCode: 'SANDBOX_DISABLED' });
    const set = vi.spyOn(agentSandboxConfigService, 'set');
    vi.spyOn(sandboxClient, 'configured').mockReturnValue(true);
    vi.spyOn(sandboxClient, 'status').mockResolvedValue(status);
    const app = await appFor(['admin:*']);

    const response = await app.inject({ method: 'PUT', url: '/api/agent/security/sandbox/config', payload: { enabled: true } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ reasonCode: 'SANDBOX_NOT_READY' });
    expect(set).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects enabling when controller is unconfigured or unreachable', async () => {
    vi.spyOn(agentSandboxConfigService, 'get').mockResolvedValue({ enabled: false, reasonCode: 'SANDBOX_DISABLED' });
    const set = vi.spyOn(agentSandboxConfigService, 'set');
    vi.spyOn(sandboxClient, 'configured').mockReturnValue(false);
    const app = await appFor(['admin:*']);

    const response = await app.inject({ method: 'PUT', url: '/api/agent/security/sandbox/config', payload: { enabled: true } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ reasonCode: 'SANDBOX_NOT_READY' });
    expect(set).not.toHaveBeenCalled();
    await app.close();
  });

  it('enables only after readiness and audits the change', async () => {
    vi.spyOn(agentSandboxConfigService, 'get').mockResolvedValue({ enabled: false, reasonCode: 'SANDBOX_DISABLED' });
    vi.spyOn(agentSandboxConfigService, 'set').mockResolvedValue({ enabled: true, reasonCode: 'SANDBOX_ENABLED' });
    vi.spyOn(sandboxClient, 'configured').mockReturnValue(true);
    vi.spyOn(sandboxClient, 'status').mockResolvedValue({
      status: 'ok', daemon: { reachable: true, rootless: true }, policy: { runtimes: ['node'] },
    });
    const audit = vi.spyOn(auditLogManager, 'logConfigChange').mockResolvedValue();
    const app = await appFor(['admin:*']);

    const response = await app.inject({ method: 'PUT', url: '/api/agent/security/sandbox/config', payload: { enabled: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: true, reasonCode: 'SANDBOX_ENABLED' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ configKey: 'agent_sandbox_enabled', oldValue: false, newValue: true }));
    await app.close();
  });

  it('disables without contacting an unavailable controller', async () => {
    vi.spyOn(agentSandboxConfigService, 'get').mockResolvedValue({ enabled: true, reasonCode: 'SANDBOX_ENABLED' });
    vi.spyOn(agentSandboxConfigService, 'set').mockResolvedValue({ enabled: false, reasonCode: 'SANDBOX_DISABLED' });
    const status = vi.spyOn(sandboxClient, 'status');
    vi.spyOn(auditLogManager, 'logConfigChange').mockResolvedValue();
    const app = await appFor(['admin:*']);

    const response = await app.inject({ method: 'PUT', url: '/api/agent/security/sandbox/config', payload: { enabled: false } });
    expect(response.statusCode).toBe(200);
    expect(status).not.toHaveBeenCalled();
    await app.close();
  });

  it('audits a failed sandbox configuration mutation', async () => {
    vi.spyOn(agentSandboxConfigService, 'get').mockResolvedValue({ enabled: true, reasonCode: 'SANDBOX_ENABLED' });
    vi.spyOn(agentSandboxConfigService, 'set').mockRejectedValue(new Error('SANDBOX_CONFIG_UPDATE_FAILED'));
    const audit = vi.spyOn(auditLogManager, 'logConfigChange').mockResolvedValue();
    const app = await appFor(['admin:*']);

    const response = await app.inject({ method: 'PUT', url: '/api/agent/security/sandbox/config', payload: { enabled: false } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ reasonCode: 'SANDBOX_CONFIG_UPDATE_FAILED' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      configKey: 'agent_sandbox_enabled',
      oldValue: true,
      newValue: false,
      result: 'failure',
      errorMessage: 'SANDBOX_CONFIG_UPDATE_FAILED',
    }));
    await app.close();
  });
});
