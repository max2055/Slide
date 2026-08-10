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

import { describe, it, expect, afterEach, vi } from 'vitest';
import { ToolRegistry } from '@slide/agent-core';
import type { LLMProvider, LLMResponse, LLMCallOptions, StreamCallbacks, Message, ToolSchema } from '@slide/agent-core';
import { DirectAdapter } from '../direct-adapter.js';
import type { ChatEvent } from '../types.js';
import { WebSocket } from 'ws';
import { executeToolWithPolicy } from '../../tools/policy.js';
import type { ActorContext } from '../../auth/actor-context.js';
import type { AnyAgentTool } from '../../tools/types.js';
import { chatDatabaseService } from '../../chat-database-service.js';
import { createActorBoundToolRegistry, loadPlatformTools } from '../get-agent-engine.js';
import { agentRunService } from '../agent-run-service.js';
import { instanceDatabaseService } from '../../instance-database-service.js';
import { completeAnalysisTool } from '../../tools/generated/slide-self-mgmt/complete_analysis.js';

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

class ToolCallingProvider extends MockLLMProvider {
  private calls = 0;
  override async chat(): Promise<LLMResponse> {
    if (this.calls++ === 0) {
      return {
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call-1', name: 'dangerous_tool', arguments: {} }],
        usage: {},
        shouldExecuteTools: true,
        hasToolCalls: true,
      };
    }
    return {
      content: 'Tool request completed.',
      finishReason: 'stop',
      toolCalls: [],
      usage: {},
      shouldExecuteTools: false,
      hasToolCalls: false,
    };
  }

  override async chatStream(
    _messages: Message[],
    _tools: ToolSchema[],
    _callbacks: StreamCallbacks,
    _options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    return this.chat();
  }
}

class CatalogToolCallingProvider extends MockLLMProvider {
  private calls = 0;

  constructor(private readonly toolName: string, private readonly args: Record<string, unknown>) {
    super();
  }

  override async chat(): Promise<LLMResponse> {
    if (this.calls++ === 0) {
      return {
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'catalog-call-1', name: this.toolName, arguments: this.args }],
        usage: {},
        shouldExecuteTools: true,
        hasToolCalls: true,
      };
    }
    return {
      content: 'Catalog policy was evaluated.', finishReason: 'stop', toolCalls: [], usage: {},
      shouldExecuteTools: false, hasToolCalls: false,
    };
  }

  override async chatStream(): Promise<LLMResponse> {
    return this.chat();
  }
}

class FailingProvider extends MockLLMProvider {
  override async chat(): Promise<LLMResponse> {
    return {
      content: null,
      finishReason: 'error',
      toolCalls: [],
      usage: {},
      shouldExecuteTools: false,
      hasToolCalls: false,
      errorKind: 'provider_error',
      error: 'Provider failed',
    };
  }

  override async chatStream(): Promise<LLMResponse> {
    return this.chat();
  }
}

class CapturingInvokeProvider extends MockLLMProvider {
  seenTools: ToolSchema[] = [];

  override async chat(
    _messages: Message[],
    tools: ToolSchema[],
    _options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    this.seenTools = tools;
    return super.chat(_messages, tools, _options);
  }
}

const completionEnvelope = {
  schemaVersion: 1,
  analysisType: 'fault_diagnosis',
  subject: { type: 'instance', id: 7 },
  conclusions: ['Bound conclusion'],
  hypotheses: [],
  evidenceRefs: [],
  confidence: 0.8,
  recommendations: [],
  displayMarkdown: '# Bound analysis',
  provenance: { modelVersion: 'test', promptVersion: 'test', toolVersions: {} },
  createdAt: '2026-08-10T00:00:00.000Z',
};

class AnalysisCompletionProvider extends MockLLMProvider {
  private calls = 0;

  constructor(private readonly requestedAnalysisId: number) {
    super();
  }

  override async chat(): Promise<LLMResponse> {
    if (this.calls++ === 0) {
      return {
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'analysis-completion-call',
          name: 'slide_complete_analysis',
          arguments: { analysisId: this.requestedAnalysisId, envelope: completionEnvelope },
        }],
        usage: {},
        shouldExecuteTools: true,
        hasToolCalls: true,
      };
    }
    return {
      content: 'Analysis completion attempted.',
      finishReason: 'stop',
      toolCalls: [],
      usage: {},
      shouldExecuteTools: false,
      hasToolCalls: false,
    };
  }

  override async chatStream(): Promise<LLMResponse> {
    return this.chat();
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

    it('denies a production-catalog sensitive tool over the authenticated WebSocket transport', async () => {
      const port = 28993;
      const previousPort = process.env.AGENT_WS_PORT;
      const previousSecret = process.env.JWT_SECRET_KEY;
      process.env.AGENT_WS_PORT = String(port);
      process.env.JWT_SECRET_KEY = 'test-websocket-secret-that-is-long-enough';
      const viewer: ActorContext = Object.freeze({
        userId: 73,
        username: 'ws-catalog-viewer',
        roles: Object.freeze(['viewer']),
        permissions: Object.freeze([]),
        sessionVersion: 1,
        instanceScopes: Object.freeze({}),
        requestId: 'ws-catalog-policy-test',
      });
      const metadata = vi.spyOn(chatDatabaseService, 'getSessionMetadata').mockResolvedValue(null);
      const createSession = vi.spyOn(chatDatabaseService, 'createSession').mockResolvedValue({ session_id: 'ws-catalog-policy-session' } as any);
      const addMessage = vi.spyOn(chatDatabaseService, 'addMessage').mockResolvedValue();
      const decryptedInstanceLookup = vi.spyOn(instanceDatabaseService, 'getInstanceWithDecryptedPassword');
      const platformTools = await loadPlatformTools();
      const actorTools = createActorBoundToolRegistry(viewer);
      const protectedTool = actorTools.get('get_instance_connection');
      expect(protectedTool).toBeDefined();
      await expect(protectedTool!.execute({ instance_id: 999_999 })).resolves.toMatchObject({
        policyDecision: { allow: false, reasonCode: 'OWNER_REQUIRED' },
        success: false,
      });
      const adapter = new DirectAdapter({
        tools: platformTools,
        toolsForActor: () => actorTools,
        llmProvider: new CatalogToolCallingProvider('get_instance_connection', { instance_id: 999_999 }),
        actorContextService: {
          authenticateAccessToken: vi.fn().mockResolvedValue(viewer),
          revalidateActor: vi.fn().mockResolvedValue(viewer),
        },
      });
      adaptersToCleanup.push(adapter);

      try {
        await adapter.start();
        const events = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
          const received: Array<Record<string, unknown>> = [];
          const ws = new WebSocket(`ws://127.0.0.1:${port}`);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('WebSocket catalog policy test timed out'));
          }, 5_000);
          ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'viewer-token' })));
          ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString()) as Record<string, unknown>;
            received.push(message);
            if (message.type === 'auth_ok') {
              ws.send(JSON.stringify({ type: 'chat.send', message: 'show the connection' }));
            }
            if (message.type === 'complete') {
              clearTimeout(timeout);
              ws.close();
              resolve(received);
            }
          });
          ws.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'auth_ok' }),
          expect.objectContaining({ type: 'tool_start', toolName: 'get_instance_connection' }),
          expect.objectContaining({ type: 'tool_result', toolName: 'get_instance_connection' }),
          expect.objectContaining({ type: 'complete' }),
        ]));
        expect(decryptedInstanceLookup).not.toHaveBeenCalled();
      } finally {
        metadata.mockRestore();
        createSession.mockRestore();
        addMessage.mockRestore();
        decryptedInstanceLookup.mockRestore();
        if (previousPort === undefined) delete process.env.AGENT_WS_PORT;
        else process.env.AGENT_WS_PORT = previousPort;
        if (previousSecret === undefined) delete process.env.JWT_SECRET_KEY;
        else process.env.JWT_SECRET_KEY = previousSecret;
      }
    }, 10_000);

    it('persists a provider failure as failed and never emits complete over WebSocket', async () => {
      const port = 28994;
      const previousPort = process.env.AGENT_WS_PORT;
      const previousSecret = process.env.JWT_SECRET_KEY;
      process.env.AGENT_WS_PORT = String(port);
      process.env.JWT_SECRET_KEY = 'test-websocket-secret-that-is-long-enough';
      const actor: ActorContext = Object.freeze({
        userId: 74, username: 'ws-failure-user', roles: Object.freeze(['viewer']), permissions: Object.freeze([]),
        sessionVersion: 1, instanceScopes: Object.freeze({}), requestId: 'ws-provider-failure-test',
      });
      const metadata = vi.spyOn(chatDatabaseService, 'getSessionMetadata').mockResolvedValue(null);
      const createSession = vi.spyOn(chatDatabaseService, 'createSession').mockResolvedValue({ session_id: 'ws-provider-failure-session' } as any);
      const addMessage = vi.spyOn(chatDatabaseService, 'addMessage').mockResolvedValue();
      const claim = vi.spyOn(agentRunService, 'claim').mockResolvedValue({
        created: true,
        run: { id: 'provider-failure-run', actorId: actor.userId, sessionId: 'ws-provider-failure-session', messageId: 'failure-message', idempotencyKey: 'failure-key', state: 'running' },
      });
      const finish = vi.spyOn(agentRunService, 'finish').mockResolvedValue(true);
      const adapter = new DirectAdapter({
        tools: new ToolRegistry(),
        llmProvider: new FailingProvider(),
        actorContextService: {
          authenticateAccessToken: vi.fn().mockResolvedValue(actor),
          revalidateActor: vi.fn().mockResolvedValue(actor),
        },
      });
      adaptersToCleanup.push(adapter);

      try {
        await adapter.start();
        const events = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
          const received: Array<Record<string, unknown>> = [];
          const ws = new WebSocket(`ws://127.0.0.1:${port}`);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('WebSocket provider failure test timed out'));
          }, 5_000);
          ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'failure-token' })));
          ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString()) as Record<string, unknown>;
            received.push(message);
            if (message.type === 'auth_ok') {
              ws.send(JSON.stringify({ type: 'chat.send', message: 'trigger provider failure', messageId: 'failure-message', idempotencyKey: 'failure-key' }));
            }
            if (message.type === 'error') {
              clearTimeout(timeout);
              ws.close();
              resolve(received);
            }
          });
          ws.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error' })]));
        expect(events.some((event) => event.type === 'complete')).toBe(false);
        expect(finish).toHaveBeenCalledWith('provider-failure-run', 'failed', { stopReason: 'error' });
      } finally {
        metadata.mockRestore();
        createSession.mockRestore();
        addMessage.mockRestore();
        claim.mockRestore();
        finish.mockRestore();
        if (previousPort === undefined) delete process.env.AGENT_WS_PORT;
        else process.env.AGENT_WS_PORT = previousPort;
        if (previousSecret === undefined) delete process.env.JWT_SECRET_KEY;
        else process.env.JWT_SECRET_KEY = previousSecret;
      }
    }, 10_000);
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

    it('binds an authenticated actor to a dangerous tool call and denies the handler', async () => {
      const metadata = vi.spyOn(chatDatabaseService, 'getSessionMetadata').mockResolvedValue(null);
      const handler = vi.fn().mockResolvedValue({ success: true, data: 'must not execute' });
      const dangerousTool: AnyAgentTool = {
        name: 'dangerous_tool',
        description: 'owner-only mutation',
        parameters: { type: 'object', properties: {} },
        ownerOnly: true,
        requiresApproval: true,
        handler,
      };
      const viewer: ActorContext = Object.freeze({
        userId: 71,
        username: 'viewer',
        roles: Object.freeze(['viewer']),
        permissions: Object.freeze([]),
        sessionVersion: 1,
        instanceScopes: Object.freeze({}),
        requestId: 'adapter-policy-test',
      });
      const adapter = new DirectAdapter({
        tools: new ToolRegistry(),
        toolsForActor: (actor) => {
          const registry = new ToolRegistry();
          registry.register({
            name: dangerousTool.name,
            description: dangerousTool.description,
            parameters: dangerousTool.parameters as ToolSchema['parameters'],
            readOnly: false,
            concurrencySafe: false,
            exclusive: false,
            execute: async (params) => {
              const { decision, result } = await executeToolWithPolicy(actor, dangerousTool, params);
              return { ...result, policyDecision: decision };
            },
          });
          return registry;
        },
        llmProvider: new ToolCallingProvider(),
      });
      adaptersToCleanup.push(adapter);
      const events: ChatEvent[] = [];

      try {
        await adapter.chat('adapter-policy-session', 'run the dangerous tool', (event) => events.push(event), viewer);
        expect(handler).not.toHaveBeenCalled();
        expect(events.some((event) => event.type === 'tool_result')).toBe(true);
      } finally {
        metadata.mockRestore();
      }
    });

    it('denies a viewer in the real production catalog before the connection tool handler runs', async () => {
      const metadata = vi.spyOn(chatDatabaseService, 'getSessionMetadata').mockResolvedValue(null);
      const viewer: ActorContext = Object.freeze({
        userId: 72,
        username: 'catalog-viewer',
        roles: Object.freeze(['viewer']),
        permissions: Object.freeze([]),
        sessionVersion: 1,
        instanceScopes: Object.freeze({}),
        requestId: 'catalog-policy-test',
      });
      const platformTools = await loadPlatformTools();
      expect(platformTools.has('get_instance_connection')).toBe(true);
      const actorTools = createActorBoundToolRegistry(viewer);
      const protectedTool = actorTools.get('get_instance_connection');
      expect(protectedTool).toBeDefined();
      await expect(protectedTool!.execute({ instance_id: 999_999 })).resolves.toMatchObject({
        policyDecision: { allow: false, reasonCode: 'OWNER_REQUIRED' },
        success: false,
        errorCode: 'OWNER_REQUIRED',
      });
      const adapter = new DirectAdapter({
        tools: platformTools,
        toolsForActor: () => actorTools,
        llmProvider: new CatalogToolCallingProvider('get_instance_connection', { instance_id: 999_999 }),
      });
      adaptersToCleanup.push(adapter);
      const events: ChatEvent[] = [];

      try {
        await adapter.chat('catalog-policy-session', 'show the connection', (event) => events.push(event), viewer);
        const result = events.find((event) => event.type === 'tool_result');
        expect(result).toMatchObject({
          toolName: 'get_instance_connection',
          result: expect.any(String),
        });
      } finally {
        metadata.mockRestore();
      }
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

    it('retains the concrete provider error for failed background invokes', async () => {
      const adapter = new DirectAdapter({
        tools: new ToolRegistry(),
        llmProvider: new FailingProvider(),
      });

      const result = await adapter.invoke('test-session-provider-failure', 'Analyze');

      expect(result).toMatchObject({
        stopReason: 'error',
        error: 'Provider failed',
      });
    });

    it('exposes no tools to an unbound background invoke', async () => {
      const provider = new CapturingInvokeProvider();
      const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: provider });

      await adapter.invoke('test-session-analysis-completion', 'Analyze');

      expect(provider.seenTools).toEqual([]);
    });

    it('exposes only a record-bound completion tool to an analysis invoke', async () => {
      const provider = new CapturingInvokeProvider();
      const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: provider });

      await adapter.invoke('test-session-analysis-completion', 'Analyze', undefined, { analysisId: 42 });

      expect(provider.seenTools.map((tool) => tool.name)).toEqual(['slide_complete_analysis']);
    });

    it('rejects a model-supplied analysis id that differs from the bound record', async () => {
      const handler = vi.spyOn(completeAnalysisTool, 'handler').mockResolvedValue({ success: true });
      const adapter = new DirectAdapter({
        tools: new ToolRegistry(),
        llmProvider: new AnalysisCompletionProvider(99),
      });

      try {
        await adapter.invoke('test-session-analysis-mismatch', 'Analyze', undefined, { analysisId: 42 });

        expect(handler).not.toHaveBeenCalled();
      } finally {
        handler.mockRestore();
      }
    });

    it('forces a valid completion call onto the bound analysis record', async () => {
      const handler = vi.spyOn(completeAnalysisTool, 'handler').mockResolvedValue({
        success: true,
        data: { saved: true, analysisId: 42 },
      });
      const adapter = new DirectAdapter({
        tools: new ToolRegistry(),
        llmProvider: new AnalysisCompletionProvider(42),
      });

      try {
        await adapter.invoke('test-session-analysis-bound', 'Analyze', undefined, { analysisId: 42 });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ analysisId: 42 }));
      } finally {
        handler.mockRestore();
      }
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
      expect(caps.features.files.state).toBe('unsupported');
      expect(caps.features.sessions.state).toBe('supported');
    });
  });
});
