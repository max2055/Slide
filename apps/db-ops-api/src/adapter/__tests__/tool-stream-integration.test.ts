import { it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { ToolRegistry } from '@slide/agent-core';
import type { LLMProvider, LLMResponse, StreamCallbacks } from '@slide/agent-core';
import { WebSocket } from 'ws';
import { DirectAdapter } from '../direct-adapter.js';
import { canonicalStore } from '../canonical-store.js';
import { chatDatabaseService } from '../../chat-database-service.js';
import type { ActorContext } from '../../auth/actor-context.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const final: LLMResponse = { content: 'after', finishReason: 'stop', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false };
const actor: ActorContext = { userId: 81, username: 'fixture', roles: ['admin'], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: 'tool-stream-fixture' };

it('real authenticated Adapter WS → Gateway → tool consumer preserves identity, timing, errors and text boundaries', async () => {
  // Only persistence/identity boundaries and provider are controlled. Execution,
  // socket transport, wire normalization and both UI consumers are real.
  vi.stubEnv('AGENT_WS_PORT', '0');
  vi.stubEnv('JWT_SECRET_KEY', 'fixture-only-secret-long-enough-for-tests');
  vi.spyOn(canonicalStore, 'getPage').mockResolvedValue({ messages: [], nextBefore: null });
  const persist = vi.spyOn(canonicalStore, 'appendToolFacts').mockResolvedValue(undefined);
  vi.spyOn(canonicalStore, 'saveCheckpoint').mockResolvedValue(undefined);
  vi.spyOn(chatDatabaseService, 'getSessionMetadata').mockResolvedValue(null);
  vi.spyOn(chatDatabaseService, 'authorizeSession').mockResolvedValue({} as any);
  vi.spyOn(chatDatabaseService, 'addMessage').mockResolvedValue(1);
  const requireFrontend = createRequire(new URL('../../../../../frontend/package.json', import.meta.url));
  const { JSDOM } = requireFrontend('jsdom');
  const dom = new JSDOM('', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'customElements', 'localStorage', 'location', 'navigator']) vi.stubGlobal(key, dom.window[key]);
  // Computed import keeps server typecheck independent of the frontend tsconfig.
  const consumerPath = new URL('../../../../../frontend/src/app/ui/direct-gateway.ts', import.meta.url).pathname;
  const { handleDirectAdapterEvent, DirectGatewayClient } = await import(consumerPath);
  const host = { chatRunId: null, sessionKey: 'stream-fixture', connected: false, client: null,
    chatStream: '', chatStreamStartedAt: null, chatThinkingText: '', chatMessages: [], chatQueue: [], chatSending: true,
    lastError: null, settings: { lastActiveSessionKey: '' }, applySettings() {}, refreshSessionsAfterChat: new Set(),
    chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [], toolStreamSyncTimer: null };
  const gateway = new DirectGatewayClient({ onEvent: (event: any) => handleDirectAdapterEvent(host, event), onStateChange: () => {} });
  const tools = new ToolRegistry();
  let releaseSlow!: () => void;
  tools.register({ name: 'query', description: 'fixture', parameters: { type: 'object', properties: {} }, readOnly: true, exclusive: false, concurrencySafe: true,
    execute: async (args, ctx) => {
      await ctx?.progressCallback?.({ completed: 1, total: 2, password: 'hidden' });
      if (args.which === 'slow') await new Promise<void>(resolve => { releaseSlow = resolve; });
      return { success: args.which !== 'slow', rows: [args.which], secret: 'hidden' };
    } });
  let requests = 0;
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat: async () => final,
    chatStream: async (_m, _t, callbacks: StreamCallbacks) => {
      if (requests++ === 0) {
        await callbacks.onContentDelta('before');
        return { ...final, content: 'before', finishReason: 'tool_calls', shouldExecuteTools: true, hasToolCalls: true,
          toolCalls: ['slow', 'fast'].map(which => ({ id: which, name: 'query', arguments: { which } })) };
      }
      await callbacks.onContentDelta('after'); return final;
    } };
  const workspace = mkdtempSync(join(tmpdir(), 'tool-stream-integration-'));
  const adapter = new DirectAdapter({ workspace, concurrentTools: true, tools, toolsForActor: () => tools, llmProvider: provider,
    actorContextService: { authenticateAccessToken: vi.fn().mockResolvedValue(actor), revalidateActor: vi.fn().mockResolvedValue(actor) } });
  let ws: WebSocket | undefined;
  try {
    await adapter.start();
    const server = (adapter as any).wsServer;
    if (!server.address()) await once(server, 'listening');
    const port = server.address().port;
    const received: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timeout = setTimeout(() => reject(new Error('integration timed out: ' + received.map(e => `${e.type}:${e.toolCallId ?? e.code ?? e.error ?? ''}`).join(', '))), 5000);
      ws.on('open', () => ws!.send(JSON.stringify({ type: 'auth', token: 'fixture-token' })));
      ws.on('error', reject);
      ws.on('message', raw => {
        try {
          const event = JSON.parse(raw.toString()); received.push(event);
          if (event.type === 'auth_ok') { ws!.send(JSON.stringify({ type: 'chat.send', sessionKey: 'stream-fixture', message: 'run fixtures' })); return; }
          if (event.type === 'complete') {
            // Observe the final text before terminal history replacement.
            handleDirectAdapterEvent(host, { type: 'thinking_end' });
            expect(host.chatStreamSegments).toMatchObject([{ text: 'before', beforeToolCallId: 'slow' }]);
            expect(host.chatStream).toBe('after');
            expect(host.toolStreamOrder).toEqual(['slow', 'fast']);
            expect(host.toolStreamById.get('slow')).toMatchObject({ phase: 'persisted', outcome: 'error' });
            expect(host.toolStreamById.get('fast')).toMatchObject({ phase: 'persisted', outcome: 'ok' });
            expect(persist).toHaveBeenCalled();
            clearTimeout(timeout); resolve(); return;
          }
          // Exercise the native Gateway dispatch too, after real WS JSON decoding.
          (gateway as any).dispatchEvent(event);
          if (event.type === 'tool_result' && event.toolCallId === 'fast') {
            expect(host.toolStreamById.get('fast').phase).toBe('settled');
            expect(host.toolStreamById.get('slow').phase).toBe('running');
            releaseSlow();
          }
        } catch (error) { clearTimeout(timeout); reject(error); }
      });
    });
    expect(received.filter(e => e.type === 'tool_progress').map(e => e.toolCallId)).toEqual(['slow', 'fast']);
    expect(received.filter(e => e.type === 'text_delta').map(e => e.delta)).toEqual(['before', 'beforeafter']);
    expect(received.filter(e => e.type === 'text_delta').map(e => e.partText)).toEqual(['before', 'after']);
    expect(JSON.stringify(received)).not.toContain('hidden');
    const firstPersisted = received.findIndex(e => e.phase === 'persisted');
    expect(firstPersisted).toBeGreaterThan(received.findIndex(e => e.type === 'tool_error'));
    expect(received.filter(e => e.type === 'tool_start')).toHaveLength(2);
  } finally {
    releaseSlow?.(); ws?.close();
    if (host.toolStreamSyncTimer != null) clearTimeout(host.toolStreamSyncTimer);
    gateway.disconnect(); await adapter.dispose(); dom.window.close(); rmSync(workspace, { recursive: true, force: true });
  }
}, 10_000);

it('failed checkpoint acknowledgement never publishes persisted tool state', async () => {
  const { AgentRunner, NoopHook } = await import('@slide/agent-core');
  const tools = new ToolRegistry();
  tools.register({ name: 'query', description: '', parameters: { type: 'object', properties: {} }, readOnly: true, exclusive: false, concurrencySafe: true, execute: async () => 'ok' });
  const response = { ...final, content: null, finishReason: 'tool_calls', shouldExecuteTools: true, hasToolCalls: true,
    toolCalls: [{ id: 'call', name: 'query', arguments: {} }] };
  const events: any[] = [];
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat: async () => response, chatStream: async () => response };
  await expect(new AgentRunner(provider).run({ initialMessages: [], model: 'fixture', tools, hook: new NoopHook(), maxIterations: 3,
    maxToolResultChars: 1000, checkpointCallback: async checkpoint => { if (checkpoint.phase === 'tools_completed') throw new Error('storage failed'); },
    onToolEvent: e => { events.push(e); } })).rejects.toThrow('storage failed');
  expect(events.some(e => e.phase === 'settled')).toBe(true);
  expect(events.some(e => e.phase === 'persisted')).toBe(false);
});
