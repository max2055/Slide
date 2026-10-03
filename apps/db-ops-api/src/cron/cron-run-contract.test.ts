import { describe, expect, it } from 'vitest';
import { AgentRunner, ToolRegistry } from '@slide/agent-core';
import { completeCronTool } from './cron-completion-tool.js';
import { CronExecutor } from './cron-executor.js';

describe('Cron completion evidence', () => {
  it('never claims saved outside a bound run', async () => {
    expect(await completeCronTool.handler({ status: 'success', summary: 'done' })).toMatchObject({ success: false });
  });
  it('does not infer business success from a normal final answer', async () => {
    const provider = { getDefaultModel: () => 'fixture', chat: async () => ({ content: 'done', finishReason: 'stop', usage: {}, toolCalls: [], hasToolCalls: false, shouldExecuteTools: false }) };
    const result = await new CronExecutor(new AgentRunner(provider as any), new ToolRegistry(), provider as any).execute(1, 'test');
    expect(result).toMatchObject({ businessStatus: 'unknown', structuredResult: null });
  });
});
