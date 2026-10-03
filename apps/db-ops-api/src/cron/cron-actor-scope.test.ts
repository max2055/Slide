import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronExecutor } from './cron-executor.js';
import { AgentRunner } from '@slide/agent-core';
import { createCronToolRegistry, getPlatformTool } from '../adapter/get-agent-engine.js';
import { agentToolAuditService } from '../security/agent-tool-audit-service.js';
import { agentExecutionConfigService } from '../security/agent-execution-config-service.js';
import { actorContextService } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { cronJobService } from './cron-job-service.js';
import { CronAuthorityService } from './cron-authority.js';
import { CronManager } from './cron-manager.js';
import type { CronJobConfig } from './types.js';
import { instanceDatabaseService } from '../instance-database-service.js';
import type { ActorContext } from '../auth/actor-context.js';

const actor: ActorContext = { userId: 7, username: 'limited', roles: ['operator'],
  permissions: ['instance:view', 'metric:view', 'alert:view'], sessionVersion: 1,
  instanceScopes: { 1: 'read-only' }, requestId: 'cron:7:run' };
afterEach(() => vi.restoreAllMocks());

describe('Cron execution authority', () => {
  it('rejects a deterministic Agent requesting B before handler entry and durably audits the owner', async () => {
    vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({ approvalEnabled: false } as any);
    const audit = vi.spyOn(agentToolAuditService, 'record').mockResolvedValue();
    const tool = (await getPlatformTool('get_instance_summary'))!;
    const handler = vi.spyOn(tool, 'handler').mockResolvedValue({ success: true, data: { secret: 'B' } });
    const registry = await createCronToolRegistry({ actor, refreshActor: async () => actor });
    const provider = { getDefaultModel: () => 'fixture', chat: vi.fn(async (messages: any[]) => messages.some(m => m.role === 'tool')
      ? { content: 'done', finishReason: 'stop', usage: {}, toolCalls: [], hasToolCalls: false, shouldExecuteTools: false }
      : { content: null, finishReason: 'tool_calls', usage: {}, hasToolCalls: true, shouldExecuteTools: true,
          toolCalls: [{ id: 'B', name: 'get_instance_summary', arguments: { instance_id: 2 } }] }) };
    const result = await new CronExecutor(new AgentRunner(provider as any), registry, provider as any).execute(7, 'read B');
    expect(result.toolsUsed).toContain('get_instance_summary');
    expect(handler).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'decision', actor: expect.objectContaining({ userId: 7 }),
      decision: expect.objectContaining({ allow: false, reasonCode: 'INSTANCE_SCOPE_DENIED' }) }));
  });

  it('closes execution when persistent decision audit fails', async () => {
    vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({ approvalEnabled: false } as any);
    vi.spyOn(agentToolAuditService, 'record').mockRejectedValue(new Error('audit unavailable'));
    const handler = vi.spyOn((await getPlatformTool('get_instance_summary'))!, 'handler').mockResolvedValue({ success: true });
    const registry = await createCronToolRegistry({ actor, refreshActor: async () => actor });
    const result = await registry.execute('get_instance_summary', { instance_id: 1 });
    expect(handler).not.toHaveBeenCalled();
    expect(String(result)).toContain('AUDIT_UNAVAILABLE');
  });
  async function fixture(overrides: Partial<CronJobConfig> = {}) {
    let currentActor: ActorContext = { ...actor, permissions: [...actor.permissions, 'cron:manage'] };
    let active = true;
    const existing = new Set([1, 2]);
    const job = { id: 7, name: 'scope', task_type: 'agent', handler_key: null, enabled: true, target_instance_id: 1,
      owner_user_id: 7, principal_type: 'user', identity_status: 'bound',
      resource_scope: { version: 1, targetInstanceId: 1, instanceIds: [1], serverIds: [], networkDeviceIds: [] }, ...overrides } as CronJobConfig;
    vi.spyOn(actorContextService, 'loadActiveActor').mockImplementation(async (_id, _version, requestId) => {
      if (!active) throw new Error('Authentication failed');
      return { ...currentActor, requestId: requestId ?? currentActor.requestId };
    });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: async (_sql: string, ids: number[]) => [ids.filter(id => existing.has(id)).map(id => ({ id }))] } as any);
    const persisted = vi.spyOn(cronJobService, 'getJobById').mockResolvedValue(job);
    vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({ approvalEnabled: false } as any);
    vi.spyOn(agentToolAuditService, 'record').mockResolvedValue();
    const authority = await new CronAuthorityService().authorize(job);
    return { authority, job, existing, persisted, revoke: () => { currentActor = { ...currentActor, instanceScopes: {} }; },
      disable: () => { active = false; }, setActor: (value: ActorContext) => { currentActor = value; } };
  }

  it.each(['revoked', 'disabled', 'target-deleted', 'job-deleted', 'rebound', 'target-nulled', 'suspended'])('rechecks %s between sensitive calls', async change => {
    const f = await fixture();
    const handler = vi.spyOn((await getPlatformTool('get_instance_summary'))!, 'handler').mockResolvedValue({ success: true });
    const registry = await createCronToolRegistry(f.authority);
    expect(await registry.execute('get_instance_summary', { instance_id: 1 })).toMatchObject({ success: true });
    if (change === 'revoked') f.revoke();
    if (change === 'disabled') f.disable();
    if (change === 'target-deleted') f.existing.delete(1);
    if (change === 'job-deleted') f.persisted.mockResolvedValue(null);
    if (change === 'target-nulled') f.persisted.mockResolvedValue({ ...f.job, target_instance_id: null });
    if (change === 'suspended') f.persisted.mockResolvedValue({ ...f.job, enabled: false });
    if (change === 'rebound') f.persisted.mockResolvedValue({ ...f.job, owner_user_id: 8 });
    expect(String(await registry.execute('get_instance_summary', { instance_id: 1 }))).toContain('Error');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('filters all collections to the task ceiling even when its owner has global admin permissions', async () => {
    const f = await fixture();
    f.setActor({ ...actor, username: 'admin', roles: ['admin'], permissions: ['*'] });
    vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([{ id: 1, name: 'A' }, { id: 2, name: 'B' }] as any);
    const registry = await createCronToolRegistry(f.authority);
    expect(await registry.execute('list_database_instances', {})).toMatchObject({ data: [{ id: 1 }] });
    expect(await registry.execute('get_instance_summary', {})).toMatchObject({ data: { count: 1, instances: [{ id: 1 }] } });
    const handler = vi.spyOn((await getPlatformTool('get_instance_summary'))!, 'handler').mockResolvedValue({ success: true });
    expect(await registry.execute('get_instance_summary', { instance_id: 2 })).toMatchObject({ errorCode: 'INSTANCE_SCOPE_DENIED' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates concurrent registries and never inherits server/network/system tools', async () => {
    vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({ approvalEnabled: false } as any);
    vi.spyOn(agentToolAuditService, 'record').mockResolvedValue();
    const b = { ...actor, userId: 8, instanceScopes: { 2: 'read-only' as const }, requestId: 'cron:8' };
    const [aTools, bTools] = await Promise.all([createCronToolRegistry({ actor, refreshActor: async () => actor }), createCronToolRegistry({ actor: b, refreshActor: async () => b })]);
    const handler = vi.spyOn((await getPlatformTool('get_instance_summary'))!, 'handler').mockResolvedValue({ success: true });
    expect(await aTools.execute('get_instance_summary', { instance_id: 2 })).toMatchObject({ errorCode: 'INSTANCE_SCOPE_DENIED' });
    expect(await bTools.execute('get_instance_summary', { instance_id: 2 })).toMatchObject({ success: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]?.actor?.userId).toBe(8);
    expect(aTools).not.toBe(bTools);
    expect(aTools.toolNames).not.toContain('list_server_instances');
    expect(aTools.toolNames).not.toContain('list_resources');
    expect(aTools.toolNames).not.toContain('execute_code');
    const metrics = vi.spyOn((await getPlatformTool('query_metrics'))!, 'handler').mockResolvedValue({ success: true });
    for (const resourceType of ['server', 'network_device']) expect(await aTools.execute('query_metrics', { resourceType, resourceId: 2 })).toMatchObject({ success: false });
    expect(metrics).not.toHaveBeenCalled();
  });

  it('a result-audit outage latches the entire run closed, including completion', async () => {
    vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({ approvalEnabled: false } as any);
    vi.spyOn(agentToolAuditService, 'record').mockImplementation(async record => { if (record.phase === 'result') throw new Error('result audit failed'); });
    const handler = vi.spyOn((await getPlatformTool('get_instance_summary'))!, 'handler').mockResolvedValue({ success: true });
    const registry = await createCronToolRegistry({ actor, refreshActor: async () => actor });
    expect(String(await registry.execute('get_instance_summary', { instance_id: 1 }))).toContain('AUDIT_UNAVAILABLE');
    expect(String(await registry.execute('get_instance_summary', { instance_id: 1 }))).toContain('AUDIT_UNAVAILABLE');
    expect(String(await registry.execute('slide_complete_cron', { status: 'success', summary: 'must fail' }))).toContain('AUDIT_UNAVAILABLE');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('honors revocation that happens while the pre-execution audit is being persisted', async () => {
    const f = await fixture();
    vi.spyOn(agentToolAuditService, 'record').mockImplementation(async record => { if (record.phase === 'decision') f.revoke(); });
    const handler = vi.spyOn((await getPlatformTool('get_instance_summary'))!, 'handler').mockResolvedValue({ success: true });
    const registry = await createCronToolRegistry(f.authority);
    expect(String(await registry.execute('get_instance_summary', { instance_id: 1 }))).toContain('CRON_TARGET_ACCESS_REVOKED');
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['user', 'arbitrary-handler', 'audit-failure', 'trusted'])('permits only durably audited fixed maintenance capabilities: %s', async mode => {
    const job = { id: 4, enabled: true, principal_type: mode === 'user' ? 'user' : 'system-maintenance',
      identity_status: 'bound', handler_key: mode === 'arbitrary-handler' ? 'arbitrary' : 'baseline.cleanup' } as CronJobConfig;
    const service = { getJobById: async () => job, startLog: async () => 10,
      recordExecutionAuthority: vi.fn(async () => mode !== 'audit-failure'), completeLog: vi.fn(async () => true), updateRunResult: vi.fn() };
    const workflow = { enqueue: vi.fn(async () => {}) };
    await new CronManager(service as any, {} as any, workflow).executeJob(job);
    expect(workflow.enqueue).toHaveBeenCalledTimes(mode === 'trusted' ? 1 : 0);
    if (mode === 'trusted') expect(service.recordExecutionAuthority).toHaveBeenCalledWith(10,
      { principal_type: 'system-maintenance', capability: 'baseline.cleanup', triggered_by: null });
  });

});
