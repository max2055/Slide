import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronExecutor } from './cron-executor.js';
import { AgentRunner } from '@slide/agent-core';
import { createCronToolRegistry, getPlatformTool } from '../adapter/get-agent-engine.js';
import { agentToolAuditService } from '../security/agent-tool-audit-service.js';
import { agentExecutionConfigService } from '../security/agent-execution-config-service.js';
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
    const registry = await (createCronToolRegistry as any)({ actor, refreshActor: async () => actor });
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
    const registry = await (createCronToolRegistry as any)({ actor, refreshActor: async () => actor });
    const result = await registry.execute('get_instance_summary', { instance_id: 1 });
    expect(handler).not.toHaveBeenCalled();
    expect(result).toContain('AUDIT_UNAVAILABLE');
  });
});
