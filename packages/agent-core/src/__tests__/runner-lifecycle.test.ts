import { describe, expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { AgentRunSpec, LLMProvider, LLMResponse, Message, StreamCallbacks, ToolSchema } from '../types.js';

class ToolCallingProvider implements LLMProvider {
  getDefaultModel() { return 'test'; }
  async chat(_messages: Message[], _tools: ToolSchema[]): Promise<LLMResponse> {
    return {
      content: null, finishReason: 'tool_calls', usage: {}, shouldExecuteTools: true, hasToolCalls: true,
      toolCalls: [{ id: 'call-1', name: 'wait', arguments: {} }],
    };
  }
  async chatStream(messages: Message[], tools: ToolSchema[], _callbacks: StreamCallbacks): Promise<LLMResponse> {
    return this.chat(messages, tools);
  }
}

function spec(tools: ToolRegistry, signal: AbortSignal): AgentRunSpec {
  return {
    initialMessages: [{ role: 'user', content: 'go' }], tools, model: 'test', maxIterations: 1,
    maxToolResultChars: 1024, hook: new NoopHook(), signal,
  };
}

describe('AgentRunner lifecycle', () => {
  it('passes the run abort signal to tool execution', async () => {
    const tools = new ToolRegistry();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    tools.register({
      name: 'wait', description: 'wait', parameters: { type: 'object', properties: {} },
      readOnly: true, concurrencySafe: false, exclusive: false,
      execute: async (_params: Record<string, unknown>, context?: { signal?: AbortSignal }) => {
        receivedSignal = context?.signal;
        return 'done';
      },
    });

    const outcome = await new AgentRunner(new ToolCallingProvider()).runTool(
      spec(tools, controller.signal),
      { id: 'call-1', name: 'wait', arguments: {} },
      {},
      {},
    );
    expect(outcome.event.status).toBe('ok');
    expect(receivedSignal).toBe(controller.signal);
  });

  it('does not block consecutive calls when the tool arguments differ', async () => {
    const tools = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue('created');
    tools.register({
      name: 'slide_add_database', description: 'add database', parameters: { type: 'object', properties: {} },
      readOnly: false, concurrencySafe: true, exclusive: false, execute,
    });
    const runner = new AgentRunner(new ToolCallingProvider());
    const counts: Record<string, number> = {};

    for (let index = 0; index < 12; index++) {
      const outcome = await runner.runTool(
        { ...spec(tools, new AbortController().signal), failOnToolError: true },
        { id: `call-${index}`, name: 'slide_add_database', arguments: { host: `db-${index}`, port: 3306 } },
        counts,
      );
      expect(outcome.event.status).toBe('ok');
      expect(outcome.error).toBeNull();
    }
    expect(execute).toHaveBeenCalledTimes(12);
  });

  it('keeps a concurrent batch of distinct calls non-fatal', async () => {
    const tools = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue('created');
    tools.register({
      name: 'slide_add_database', description: 'add database', parameters: { type: 'object', properties: {} },
      readOnly: false, concurrencySafe: true, exclusive: false, execute,
    });
    const provider: LLMProvider = {
      getDefaultModel: () => 'test',
      chat: async () => ({
        content: null, finishReason: 'tool_calls', usage: {}, shouldExecuteTools: true, hasToolCalls: true,
        toolCalls: Array.from({ length: 11 }, (_, index) => ({
          id: `call-${index}`, name: 'slide_add_database', arguments: { host: `db-${index}`, port: 3306 },
        })),
      }),
      chatStream: async () => {
        throw new Error('streaming not expected');
      },
    };
    const outcome = await new AgentRunner(provider).run({
      ...spec(tools, new AbortController().signal),
      maxIterations: 1,
      concurrentTools: true,
      failOnToolError: true,
    });
    expect(outcome.error).toBeNull();
    expect(outcome.toolEvents).toHaveLength(11);
    expect(outcome.toolEvents.every((event) => event.status === 'ok')).toBe(true);
    expect(execute).toHaveBeenCalledTimes(11);
  });

  it('blocks only the repeated call and keeps the guard error non-fatal', async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} },
      readOnly: true, concurrencySafe: true, exclusive: false, execute: async () => 'ok',
    });
    const runner = new AgentRunner(new ToolCallingProvider());
    const counts: Record<string, number> = {};
    const runSpec = { ...spec(tools, new AbortController().signal), failOnToolError: true, loopGuardThreshold: 2 };

    expect((await runner.runTool(runSpec, { id: '1', name: 'probe', arguments: { id: 7 } }, counts)).error).toBeNull();
    expect((await runner.runTool(runSpec, { id: '2', name: 'probe', arguments: { id: 7 } }, counts)).error).toBeNull();
    const blocked = await runner.runTool(runSpec, { id: '3', name: 'probe', arguments: { id: 7 } }, counts);
    expect(blocked.event.detail).toBe('repeated identical tool call blocked');
    expect(blocked.result).toContain('same parameters');
    expect(blocked.error).toBeNull();
    expect((await runner.runTool(runSpec, { id: '4', name: 'probe', arguments: { id: 8 } }, counts)).event.status).toBe('ok');
    expect((await runner.runTool(runSpec, { id: '5', name: 'probe', arguments: { id: 7 } }, counts)).event.status).toBe('ok');
  });

  it('redacts sensitive values in loop-guard logs without conflating credential references', async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} },
      readOnly: true, concurrencySafe: true, exclusive: false, execute: async () => 'ok',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new AgentRunner(new ToolCallingProvider());
    const counts: Record<string, number> = {};
    const runSpec = { ...spec(tools, new AbortController().signal), loopGuardThreshold: 1 };
    await runner.runTool(runSpec, { id: '1', name: 'probe', arguments: { credential_ref: 'ref-a' } }, counts);
    await runner.runTool(runSpec, { id: '2', name: 'probe', arguments: { credential_ref: 'ref-b' } }, counts);
    await runner.runTool(runSpec, { id: '3', name: 'probe', arguments: { credential_ref: 'ref-b' } }, counts);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ signature: '{"credential_ref":"[REDACTED]"}' });
  });

  it('closes the checkpoint before stopping on a fatal tool error', async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'mutate', description: 'mutate', parameters: { type: 'object', properties: {} },
      readOnly: false, concurrencySafe: false, exclusive: false, execute: async () => 'ok',
    });
    vi.spyOn(tools, 'execute').mockRejectedValue(new Error('database unavailable'));
    const checkpoints: Record<string, unknown>[] = [];
    const provider: LLMProvider = {
      getDefaultModel: () => 'test',
      chat: async () => ({
        content: null, finishReason: 'tool_calls', usage: {}, shouldExecuteTools: true, hasToolCalls: true,
        toolCalls: [{ id: 'call-1', name: 'mutate', arguments: {} }],
      }),
      chatStream: async () => { throw new Error('streaming not expected'); },
    };
    const outcome = await new AgentRunner(provider).run({
      ...spec(tools, new AbortController().signal),
      failOnToolError: true,
      checkpointCallback: async (payload) => { checkpoints.push(payload); },
    });
    expect(outcome.stopReason).toBe('tool_error');
    expect(checkpoints.at(-1)).toMatchObject({ phase: 'tools_completed', pendingToolCalls: [] });
  });
});
