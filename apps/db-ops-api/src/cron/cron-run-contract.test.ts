import { describe, expect, it } from 'vitest';
import { AgentRunner, ToolRegistry } from '@slide/agent-core';
import { completeCronTool } from './cron-completion-tool.js';
import { CronExecutor } from './cron-executor.js';
import { cronCompletionContext } from './cron-completion-context.js';
import { vi } from 'vitest';

describe('Cron completion evidence', () => {
  it('never claims saved outside a bound run', async () => {
    expect(await completeCronTool.handler({ status: 'success', summary: 'done' })).toMatchObject({ success: false });
  });
  it('does not infer business success from a normal final answer', async () => {
    const provider = { getDefaultModel: () => 'fixture', chat: async () => ({ content: 'done', finishReason: 'stop', usage: {}, toolCalls: [], hasToolCalls: false, shouldExecuteTools: false }) };
    const result = await new CronExecutor(new AgentRunner(provider as any), new ToolRegistry(), provider as any).execute(1, 'test');
    expect(result).toMatchObject({ businessStatus: 'unknown', structuredResult: null });
  });
  it('does not save schema-invalid output and returns saved only after persistence resolves', async () => {
    const save = vi.fn(async () => {});
    const context = { runId: 'run-a', signal: new AbortController().signal, save,
      outputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } }, additionalProperties: false } };
    const call = (result: unknown) => cronCompletionContext.run(context, () => completeCronTool.handler({ status: 'success', summary: 'done', result }));
    expect(await call({ count: 'wrong' })).toMatchObject({ success: false, error: 'CRON_OUTPUT_SCHEMA_INVALID' });
    expect(save).not.toHaveBeenCalled();
    expect(await call({ count: 2 })).toMatchObject({ data: { saved: true, runId: 'run-a' } });
    save.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(call({ count: 2 })).rejects.toThrow('storage unavailable');
  });
  it('refuses completion after cancellation', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    const save = vi.fn(async () => {});
    await expect(cronCompletionContext.run({ runId: 'run-a', signal: controller.signal, save },
      () => completeCronTool.handler({ status: 'success', summary: 'done' }))).rejects.toThrow('cancelled');
    expect(save).not.toHaveBeenCalled();
  });
  it('enforces legacy field-map schemas rather than treating them as ignored keywords', async () => {
    const save = vi.fn(async () => {});
    const context = { runId: 'legacy-schema', signal: new AbortController().signal, save,
      outputSchema: { count: { type: 'integer' }, failures: { type: 'array', items: { type: 'string' } } } };
    for (const result of [{}, { count: 'wrong', failures: [] }, { count: 2, failures: [1] }]) {
      expect(await cronCompletionContext.run(context, () => completeCronTool.handler({ status: 'success', summary: 'done', result }))).toMatchObject({ success: false });
    }
    expect(save).not.toHaveBeenCalled();
    expect(await cronCompletionContext.run(context, () => completeCronTool.handler({ status: 'partial', summary: 'done', result: { count: 2, failures: ['failed target'] } }))).toMatchObject({ data: { saved: true } });
  });
});
