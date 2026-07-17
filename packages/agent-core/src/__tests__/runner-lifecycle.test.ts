import { describe, expect, it } from 'vitest';
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
});
