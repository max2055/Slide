/**
 * IAgentEngine Interface Compliance Tests
 *
 * Tests that the IAgentEngine interface contract is properly defined:
 * - All 5 methods compile and are callable
 * - ChatEvent discriminated union has all 6 variants
 * - start() is idempotent and does not throw
 * - listTools() returns correct ToolSchema[] signatures
 * - capabilities() returns expected AgentCapabilities shape
 * - chat() onEvent callback receives at least 'complete' event type
 * - invoke() returns InvokeResult with content string
 */

import { describe, it, expect, assert } from 'vitest';
import type { ToolSchema } from '@slide/agent-core';
import type {
  IAgentEngine,
  ChatEvent,
  AgentCapabilities,
  ChatResult,
  InvokeResult,
} from '../types.js';

// ── Mock adapter implementation ──

class MockAdapter implements IAgentEngine {
  private started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async chat(
    _sessionKey: string,
    _message: string,
    onEvent: (event: ChatEvent) => void,
  ): Promise<ChatResult> {
    onEvent({ type: 'text_delta', delta: 'Hello, I am a mock assistant.' });
    onEvent({ type: 'complete', finalContent: 'Hello, I am a mock assistant.' });
    return { finalContent: 'Hello, I am a mock assistant.', usage: { prompt_tokens: 10, completion_tokens: 5 } };
  }

  async invoke(
    _sessionKey: string,
    _message: string,
    _systemPrompt?: string,
  ): Promise<InvokeResult> {
    return { content: 'Mock analysis complete.', usage: { prompt_tokens: 8, completion_tokens: 4 } };
  }

  listTools(): ToolSchema[] {
    return [
      {
        name: 'mock_tool',
        description: 'A mock tool for testing',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input parameter' },
          },
          required: ['input'],
        },
      },
    ];
  }

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      maxContextTokens: 200000,
      supportsCustomSystemPrompt: true,
    };
  }

  isStarted(): boolean {
    return this.started;
  }
}

describe('IAgentEngine', () => {
  const adapter = new MockAdapter();

  it('should compile with all 5 methods (start, chat, invoke, listTools, capabilities)', () => {
    // TypeScript compile-time check: the adapter satisfies the interface
    const engine: IAgentEngine = adapter;
    expect(engine).toBeDefined();
  });

  it('should have start() callable and not throw', async () => {
    const testAdapter = new MockAdapter();
    await expect(testAdapter.start()).resolves.toBeUndefined();
    expect(testAdapter.isStarted()).toBe(true);
  });

  it('should have start() idempotent on repeated calls', async () => {
    const testAdapter = new MockAdapter();
    await testAdapter.start();
    await testAdapter.start(); // Second call should not throw
    expect(testAdapter.isStarted()).toBe(true);
  });

  it('should return correct ToolSchema signature from listTools()', () => {
    const tools = adapter.listTools();
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe('mock_tool');
    expect(tool.description).toBe('A mock tool for testing');
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties).toHaveProperty('input');
    expect(tool.parameters.required).toContain('input');
  });

  it('should return expected AgentCapabilities shape from capabilities()', () => {
    const caps = adapter.capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalling).toBe(true);
    expect(caps.maxContextTokens).toBeGreaterThan(0);
    expect(caps.supportsCustomSystemPrompt).toBe(true);
  });

  it('should complete chat() with onEvent receiving at least complete event', async () => {
    const events: ChatEvent[] = [];
    const result = await adapter.chat('test-session', 'Hello', (e) => events.push(e));

    expect(events.length).toBeGreaterThanOrEqual(1);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe('complete');
    if (lastEvent.type === 'complete') {
      expect(lastEvent.finalContent).toBeTruthy();
    }

    expect(result.finalContent).toBeTruthy();
    expect(result.usage).toBeDefined();
  });

  it('should return InvokeResult with content from invoke()', async () => {
    const result = await adapter.invoke('test-session', 'Analyze this');

    expect(result.content).toBe('Mock analysis complete.');
    expect(result.usage).toBeDefined();
    expect(result.usage!.prompt_tokens).toBeGreaterThan(0);
  });

  it('should accept optional systemPrompt in invoke()', async () => {
    const result = await adapter.invoke('test-session', 'Analyze', 'Custom prompt');
    expect(result.content).toBeTruthy();
  });

  it('should return empty tool list when no tools registered', () => {
    class EmptyMockAdapter implements IAgentEngine {
      async start(): Promise<void> {}
      async chat(): Promise<ChatResult> { return { finalContent: null }; }
      async invoke(): Promise<InvokeResult> { return { content: null }; }
      listTools(): ToolSchema[] { return []; }
      capabilities(): AgentCapabilities {
        return { streaming: false, toolCalling: false, maxContextTokens: 0, supportsCustomSystemPrompt: false };
      }
    }

    const empty = new EmptyMockAdapter();
    expect(empty.listTools()).toHaveLength(0);
  });

  it('should support ChatEvent discriminated union with all 6 variants', () => {
    // Compile-time verification: assign each variant
    const events: ChatEvent[] = [
      { type: 'text_delta', delta: 'hello' },
      { type: 'tool_start', toolName: 'mock', args: {} },
      { type: 'tool_result', toolName: 'mock', result: 'ok' },
      { type: 'tool_error', toolName: 'mock', error: 'failed' },
      { type: 'complete', finalContent: 'done' },
      { type: 'error', error: 'something went wrong' },
    ];

    expect(events).toHaveLength(6);
    expect(events[0].type).toBe('text_delta');
    expect(events[1].type).toBe('tool_start');
    expect(events[2].type).toBe('tool_result');
    expect(events[3].type).toBe('tool_error');
    expect(events[4].type).toBe('complete');
    expect(events[5].type).toBe('error');
  });
});
