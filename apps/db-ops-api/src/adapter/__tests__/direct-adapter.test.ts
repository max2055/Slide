/**
 * DirectAdapter Unit Tests
 *
 * Tests DirectAdapter implementation:
 * - Instantiation with mock dependencies
 * - start() creates WS server (idempotent)
 * - chat() produces streaming events
 * - invoke() returns InvokeResult
 * - listTools() returns registered tools
 * - capabilities() returns expected shape
 *
 * Uses mock LLMProvider (no real SDK calls).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ToolRegistry } from '@slide/agent-core';
import type { LLMProvider, LLMResponse, LLMCallOptions, StreamCallbacks, Message, ToolSchema } from '@slide/agent-core';
import { DirectAdapter } from '../direct-adapter.js';
import type { ChatEvent } from '../types.js';
import { WebSocket } from 'ws';

// ── Mock LLMProvider — returns hardcoded responses ──

class MockLLMProvider implements LLMProvider {
  getDefaultModel(): string {
    return 'mock-model';
  }

  async chat(
    _messages: Message[],
    _tools: ToolSchema[],
    _options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    return {
      content: 'Mock response content.',
      finishReason: 'stop',
      toolCalls: [],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      shouldExecuteTools: false,
      hasToolCalls: false,
    };
  }

  async chatStream(
    _messages: Message[],
    _tools: ToolSchema[],
    callbacks: StreamCallbacks,
    _options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    await callbacks.onContentDelta('Mock streaming response.');
    return {
      content: 'Mock streaming response.',
      finishReason: 'stop',
      toolCalls: [],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      shouldExecuteTools: false,
      hasToolCalls: false,
    };
  }
}

// ── Helper: create a DirectAdapter with a mock registry and provider ──

function createMockAdapter(tools?: ToolRegistry): DirectAdapter {
  const registry = tools || new ToolRegistry();

  if (!registry.has('test_tool')) {
    registry.register({
      name: 'test_tool',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Input parameter' },
        },
        required: ['input'],
      },
      readOnly: true,
      concurrencySafe: true,
      exclusive: false,
      async execute(params: Record<string, unknown>): Promise<unknown> {
        return `Executed with: ${params.input}`;
      },
    });
  }

  return new DirectAdapter({
    tools: registry,
    llmProvider: new MockLLMProvider(),
  });
}

// Track adapters for cleanup
const adaptersToCleanup: DirectAdapter[] = [];

afterEach(async () => {
  for (const a of adaptersToCleanup) {
    await a.dispose();
  }
  adaptersToCleanup.length = 0;
});

// ── Tests ──

describe('DirectAdapter', () => {
  describe('instantiation', () => {
    it('should compile and be instantiated with mock ToolRegistry + mock LLMProvider', () => {
      const adapter = createMockAdapter();
      expect(adapter).toBeDefined();
      expect(adapter.listTools()).toHaveLength(1);
    });

    it('should accept empty ToolRegistry', () => {
      const empty = new ToolRegistry();
      const adapter = new DirectAdapter({
        tools: empty,
        llmProvider: new MockLLMProvider(),
      });
      expect(adapter.listTools()).toHaveLength(0);
    });
  });

  describe('start()', () => {
    const TEST_WS_PORT = 28992;

    it('should create a WebSocketServer on the specified port', async () => {
      process.env.AGENT_WS_PORT = String(TEST_WS_PORT);
      const adapter = createMockAdapter();
      adaptersToCleanup.push(adapter);

      await adapter.start();

      // Verify port is bound by trying to connect
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_WS_PORT}`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('WS connection timed out')), 3000);
      });
    }, 10000);

    it('should be idempotent (repeated calls do not create a second server)', async () => {
      process.env.AGENT_WS_PORT = String(TEST_WS_PORT);
      const adapter = createMockAdapter();
      adaptersToCleanup.push(adapter);

      await adapter.start();
      await expect(adapter.start()).resolves.toBeUndefined();

      // Verify it still works
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_WS_PORT}`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('WS connection timed out')), 3000);
      });
    }, 10000);
  });

  describe('chat()', () => {
    it('should produce events including at least one event', async () => {
      const adapter = createMockAdapter();
      const events: ChatEvent[] = [];

      const result = await adapter.chat('test-session-chat', 'Hello', (e) => events.push(e));

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(result.finalContent).toBeTruthy();
      expect(result.usage).toBeDefined();
    });

    it('should emit a complete event at the end', async () => {
      const adapter = createMockAdapter();
      const events: ChatEvent[] = [];

      await adapter.chat('test-session-complete', 'Hello', (e) => events.push(e));

      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe('complete');
      if (lastEvent.type === 'complete') {
        expect(lastEvent.finalContent).toBeDefined();
      }
    });

    it('should return ChatResult with usage stats', async () => {
      const adapter = createMockAdapter();
      const events: ChatEvent[] = [];

      const result = await adapter.chat('test-session-usage', 'Analyze', (e) => events.push(e));

      expect(result.finalContent).toBeTruthy();
      expect(result.usage).toBeDefined();
      expect(result.usage!.prompt_tokens).toBeGreaterThan(0);
    });
  });

  describe('invoke()', () => {
    it('should return InvokeResult with content', async () => {
      const adapter = createMockAdapter();

      const result = await adapter.invoke('test-session-invoke', 'Analyze this alert');

      expect(result.content).toBeTruthy();
      expect(typeof result.content).toBe('string');
      expect(result.usage).toBeDefined();
    });

    it('should accept optional systemPrompt', async () => {
      const adapter = createMockAdapter();

      const result = await adapter.invoke(
        'test-session-custom-prompt',
        'Analyze',
        'Custom system prompt for analysis',
      );

      expect(result.content).toBeTruthy();
    });
  });

  describe('listTools()', () => {
    it('should return registered tools', () => {
      const adapter = createMockAdapter();
      const tools = adapter.listTools();

      expect(Array.isArray(tools)).toBe(true);
      const names = tools.map((t) => t.name);
      expect(names).toContain('test_tool');
    });

    it('should return ToolSchema[] with correct structure', () => {
      const adapter = createMockAdapter();
      const tools = adapter.listTools();

      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.parameters.type).toBe('object');
        expect(tool.parameters.properties).toBeDefined();
      }
    });
  });

  describe('capabilities()', () => {
    it('should return expected AgentCapabilities shape', () => {
      const adapter = createMockAdapter();
      const caps = adapter.capabilities();

      expect(caps.streaming).toBe(true);
      expect(caps.toolCalling).toBe(true);
      expect(caps.maxContextTokens).toBe(200_000);
      expect(caps.supportsCustomSystemPrompt).toBe(true);
    });
  });
});
