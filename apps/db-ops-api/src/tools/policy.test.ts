import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import type { AnyAgentTool } from './types.js';
import { canActorDiscoverTool, decideToolPolicy, executeToolWithPolicy } from './policy.js';

const actor = (roles: string[], permissions: string[] = [], scopes: Record<number, 'read-only' | 'read-write' | 'admin'> = {}): ActorContext => Object.freeze({
  userId: 7,
  username: 'alice',
  roles: Object.freeze(roles),
  permissions: Object.freeze(permissions),
  sessionVersion: 1,
  instanceScopes: Object.freeze(scopes),
  requestId: 'policy-test',
});

const tool = (overrides: Partial<AnyAgentTool> = {}): AnyAgentTool => ({
  name: 'list_database_instances',
  description: 'test',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ success: true }),
  ...overrides,
});

describe('actor tool policy', () => {
  it('hides tools from the model when the actor cannot pass static policy', () => {
    expect(canActorDiscoverTool(actor(['viewer']), tool())).toBe(false);
    expect(canActorDiscoverTool(actor(['viewer'], ['instance:view']), tool())).toBe(true);
    expect(canActorDiscoverTool(
      actor(['dba'], ['instance:view']),
      tool({ name: 'get_instance_connection', ownerOnly: true }),
    )).toBe(false);
    expect(canActorDiscoverTool(actor(['admin']), tool({ name: 'slide_complete_analysis' }))).toBe(false);
    expect(canActorDiscoverTool(actor(['dba'], ['config:view']), tool({ name: 'spawn_subagent' }))).toBe(false);
    expect(canActorDiscoverTool(actor(['admin'], ['config:manage']), tool({ name: 'spawn_subagent' }))).toBe(true);
  });

  it('fails closed for tools without operator-owned security metadata', () => {
    const decision = decideToolPolicy(actor(['admin']), tool({ name: 'unclassified_tool' }), {});
    expect(decision).toMatchObject({
      allow: false,
      reasonCode: 'SECURITY_METADATA_MISSING',
      tool: 'unclassified_tool',
    });
  });

  it('does not allow actor calls to internal-only tools', () => {
    const decision = decideToolPolicy(actor(['admin']), tool({ name: 'slide_complete_analysis' }), {});
    expect(decision).toMatchObject({ allow: false, reasonCode: 'INTERNAL_TOOL_DENIED' });
  });

  it('rejects viewer owner-only actions before a handler can run', () => {
    const decision = decideToolPolicy(actor(['viewer']), tool({ name: 'get_instance_connection', ownerOnly: true }), {});
    expect(decision).toMatchObject({ allow: false, reasonCode: 'OWNER_REQUIRED', tool: 'get_instance_connection' });
  });

  it('requires declared permissions for DBA and allows an authorized administrator', () => {
    expect(decideToolPolicy(actor(['dba']), tool({ requiredPermissions: ['instances:write'] }), {}).reasonCode)
      .toBe('MISSING_PERMISSION');
    expect(decideToolPolicy(actor(['admin'], ['instance:view', 'instances:write']), tool({ requiredPermissions: ['instances:write'] }), {}))
      .toMatchObject({ allow: true, reasonCode: 'ALLOW' });
  });

  it('denies an instance outside the server-side actor scope', () => {
    expect(decideToolPolicy(actor(['dba'], ['instance:view'], { 12: 'read-only' }), tool(), { instance_id: 13 }))
      .toMatchObject({ allow: false, reasonCode: 'INSTANCE_SCOPE_DENIED' });
  });

  it('enforces resource aliases and minimum write scope after name resolution', async () => {
    const serverDecision = decideToolPolicy(
      actor(['dba'], ['servers:view']),
      tool({ name: 'get_server_metrics' }),
      { serverId: 44 },
    );
    expect(serverDecision).toMatchObject({
      allow: true,
      resource: { type: 'server', serverId: 44 },
    });

    const handler = vi.fn().mockResolvedValue({ success: true });
    const result = await executeToolWithPolicy(
      actor(['dba'], ['instance:update'], { 21: 'read-only' }),
      tool({ name: 'slide_update_db_config', handler }),
      { instance_name: 'orders-prod' },
      async () => ({ type: 'instance', instanceId: 21 }),
    );
    expect(result.decision.reasonCode).toBe('INSTANCE_SCOPE_LEVEL_DENIED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('honors wildcard permissions consistently with REST authorization', () => {
    expect(decideToolPolicy(
      actor(['dba'], ['instance:*'], {}),
      tool(),
      { instance_id: 99 },
    )).toMatchObject({ allow: true, reasonCode: 'ALLOW' });
  });

  it('denies missing and forged approval ids', () => {
    const dangerous = tool({ name: 'slide_update_db_config', requiresApproval: true });
    const admin = actor(['admin'], ['instance:update'], { 12: 'admin' });
    expect(decideToolPolicy(admin, dangerous, { instance_id: 12 }))
      .toMatchObject({ allow: false, reasonCode: 'APPROVAL_REQUIRED' });
    expect(decideToolPolicy(admin, dangerous, { instance_id: 12, approvalId: 'forged' }))
      .toMatchObject({ allow: false, reasonCode: 'INVALID_APPROVAL' });
  });

  it('accepts only a server-approved request bound to the same actor and arguments', () => {
    const dangerous = tool({ name: 'slide_update_db_config', requiresApproval: true });
    const admin = actor(['admin'], ['instance:update'], { 12: 'admin' });
    expect(decideToolPolicy(admin, dangerous, { instance_id: 12, approvalId: '42' }, undefined, true))
      .toMatchObject({ allow: true, reasonCode: 'ALLOW' });
    expect(decideToolPolicy(admin, dangerous, { instance_id: 13, approvalId: '42' }, undefined, true))
      .toMatchObject({ allow: false, reasonCode: 'INSTANCE_SCOPE_DENIED' });
  });

  it('consumes a persistent approval before invoking a handler and rejects replay', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true });
    const dangerous = tool({ name: 'slide_update_db_config', requiresApproval: true, handler });
    const admin = actor(['admin'], ['instance:update'], { 12: 'admin' });
    let available = true;
    const authorizer = {
      consume: vi.fn(async () => {
        if (!available) return false;
        available = false;
        return true;
      }),
    };
    const args = { instance_id: 12, approvalId: '42' };

    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const first = await executeToolWithPolicy(admin, dangerous, args, undefined, authorizer, audit);
    const replay = await executeToolWithPolicy(admin, dangerous, args, undefined, authorizer, audit);

    expect(first.decision.reasonCode).toBe('ALLOW');
    expect(replay.decision.reasonCode).toBe('INVALID_APPROVAL');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('requires a consumed approval and audit before arbitrary code execution', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, data: { jobId: 'job-1' } });
    const codeTool = tool({
      name: 'execute_code',
      requiredPermissions: ['ai:execute'],
      requiresApproval: true,
      handler,
    });
    const operator = actor(['admin'], ['ai:execute']);
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const args = { runtime: 'node', code: 'console.log(1)', approvalId: '42' };

    const denied = await executeToolWithPolicy(
      operator, codeTool, args, undefined, { consume: async () => false }, audit,
    );
    expect(denied.decision.reasonCode).toBe('INVALID_APPROVAL');
    expect(handler).not.toHaveBeenCalled();

    const allowed = await executeToolWithPolicy(
      operator, codeTool, args, undefined, { consume: async () => true }, audit,
    );
    expect(allowed.decision.reasonCode).toBe('ALLOW');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls.map(([record]) => record.phase)).toEqual(['decision', 'decision', 'result']);
  });

  it('executes a low-risk shell command without creating or consuming approval', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, data: { stdout: 'workspace' } });
    const consume = vi.fn(async () => true);
    const requester = { submit: vi.fn() };
    const result = await executeToolWithPolicy(
      actor(['admin'], ['ai:execute']),
      tool({ name: 'execute_code', requiredPermissions: ['ai:execute'], requiresApproval: true, handler }),
      { runtime: 'shell', code: 'pwd' },
      undefined,
      { consume },
      { record: vi.fn().mockResolvedValue(undefined) },
      undefined,
      { approvalRequester: requester },
    );

    expect(result.decision).toMatchObject({ allow: true, riskLevel: 'low', approvalScope: 'none' });
    expect(handler).toHaveBeenCalledOnce();
    expect(consume).not.toHaveBeenCalled();
    expect(requester.submit).not.toHaveBeenCalled();
  });

  it('creates an approval on the first medium-risk call and preserves session context', async () => {
    const requester = {
      submit: vi.fn().mockResolvedValue({ id: '73', expiresAt: new Date('2026-08-24T00:05:00.000Z') }),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const result = await executeToolWithPolicy(
      actor(['admin'], ['ai:execute']),
      tool({ name: 'execute_code', requiredPermissions: ['ai:execute'], requiresApproval: true }),
      { runtime: 'shell', code: 'echo report > report.txt' },
      undefined,
      { consume: vi.fn(async () => false) },
      audit,
      undefined,
      { sessionKey: 'agent-session-1', approvalRequester: requester },
    );

    expect(result).toMatchObject({
      decision: { reasonCode: 'APPROVAL_REQUIRED', approvalId: '73', riskLevel: 'medium', approvalScope: 'window' },
      result: { success: false, data: { approvalId: '73', riskLevel: 'medium', approvalScope: 'window' } },
    });
    expect(requester.submit).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      { scope: 'window', sessionKey: 'agent-session-1', riskLevel: 'medium' },
    );
    expect(JSON.stringify(audit.record.mock.calls[0][0])).toContain('"riskLevel":"medium"');
  });

  it('passes the session and risk ceiling to approval consumption on retry', async () => {
    const consume = vi.fn(async (_actor, _tool, _args, _resource, options) => {
      expect(options).toEqual({ sessionKey: 'agent-session-1', riskLevel: 'medium' });
      return true;
    });
    const handler = vi.fn().mockResolvedValue({ success: true });
    const result = await executeToolWithPolicy(
      actor(['admin'], ['ai:execute']),
      tool({ name: 'execute_code', requiredPermissions: ['ai:execute'], requiresApproval: true, handler }),
      { runtime: 'shell', code: 'echo report > report.txt', approvalId: '73' },
      undefined,
      { consume },
      { record: vi.fn().mockResolvedValue(undefined) },
      undefined,
      { sessionKey: 'agent-session-1' },
    );

    expect(result.decision).toMatchObject({ allow: true, riskLevel: 'medium', approvalScope: 'window' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('fails closed before a side effect when the persistent audit store is unavailable', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true });
    const writeTool = tool({ name: 'slide_update_db_config', handler });
    const result = await executeToolWithPolicy(
      actor(['admin'], ['instance:update'], { 12: 'admin' }),
      writeTool,
      { instance_id: 12, approvalId: '42' },
      undefined,
      { consume: async () => true },
      { record: async () => { throw new Error('database unavailable'); } },
    );

    expect(result.decision.reasonCode).toBe('AUDIT_UNAVAILABLE');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not return execute_code output when result audit persistence fails', async () => {
    const handler = vi.fn().mockResolvedValue({
      success: true,
      data: { jobId: 'job-1', stdout: 'sensitive execution output' },
    });
    const audit = {
      record: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('database unavailable')),
    };
    const result = await executeToolWithPolicy(
      actor(['admin'], ['ai:execute']),
      tool({ name: 'execute_code', requiredPermissions: ['ai:execute'], requiresApproval: true, handler }),
      { runtime: 'node', code: 'console.log(1)', approvalId: '42' },
      undefined,
      { consume: async () => true },
      audit,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(result.result).toEqual({
      success: false,
      errorCode: 'AUDIT_UNAVAILABLE',
      error: 'Tool result unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('sensitive execution output');
  });

  it('does not invoke a handler when policy denies the call', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true });
    const result = await executeToolWithPolicy(
      actor(['viewer']),
      tool({ name: 'get_instance_connection', ownerOnly: true, handler }),
      {},
    );
    expect(result.decision.allow).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('records a sanitized result when an allowed handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('password=do-not-leak'));
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const result = await executeToolWithPolicy(
      actor(['dba'], ['instance:view', 'instance:*']),
      tool({ handler }),
      {},
      undefined,
      undefined,
      audit,
    );

    expect(result.result).toEqual({
      success: false,
      errorCode: 'TOOL_EXECUTION_FAILED',
      error: 'Tool execution failed',
    });
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'result',
      result: expect.objectContaining({ errorCode: 'TOOL_EXECUTION_FAILED' }),
    }));
  });
});
