import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionManager, ToolRegistry, RuntimeError, type LLMProvider, type LLMResponse, type Message, type StreamCallbacks } from '@slide/agent-core';
import { DirectAdapter } from '../direct-adapter.js';
import { ChatResponse } from '../chat-response.js';
import type { ChatEvent } from '../types.js';

const bad = '正在分析数据库状态……\n'.repeat(20);
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function provider(outputs: string[]) {
  const contexts: Message[][] = [];
  const callbacks: StreamCallbacks[] = [];
  const value: LLMProvider = {
    getDefaultModel: () => 'fixture',
    chat: async () => { throw new Error('unexpected non-streaming request'); },
    chatStream: async (messages, _tools, stream): Promise<LLMResponse> => {
      contexts.push(structuredClone(messages)); callbacks.push(stream);
      const content = outputs[Math.min(contexts.length - 1, outputs.length - 1)];
      await stream.onContentDelta(content);
      return { content, finishReason: 'stop', toolCalls: [], hasToolCalls: false, shouldExecuteTools: false, usage: {} };
    },
  };
  return { value, contexts, callbacks };
}

it.each(['complete', 'cancelled', 'error'] as const)('explicit empty %s overrides provisional text', type => {
  const response = new ChatResponse();
  response.observe({ type: 'text_delta', delta: bad });
  response.observe({ type, finalContent: '', error: 'failed' } as ChatEvent);
  expect(response.message()).toBeNull();
  response.observe({ type: 'text_delta', delta: bad });
  expect(response.message({ finalContent: '', stopReason: 'error' })).toBeNull();
});

it('retracts rejected attempts, excludes them from memory/file/next context, ignores late deltas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'candidate-final-')); directories.push(directory);
  const sessionManager = new SessionManager(directory);
  const mock = provider([bad, '连接正常。']);
  const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: mock.value, sessionManager });
  const events: ChatEvent[] = [];
  const result = await adapter.chat('test', '诊断数据库', e => { events.push(e); });
  expect(result.stopReason).toBe('completed');
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text_delta', delta: '' })]));
  expect(events.map(e => e.sequence)).toEqual(events.map((_, i) => i + 1));
  expect(events.filter(e => e.type === 'text_delta').map(e => e.attempt)).toEqual([1, 1, 2]);
  const count = events.length;
  await mock.callbacks[0].onContentDelta(bad);
  expect(events).toHaveLength(count);
  expect(JSON.stringify(sessionManager.getOrCreate('test').getHistory(120))).not.toContain('正在分析');
  const fresh = new SessionManager(directory);
  expect(JSON.stringify(fresh.getOrCreate('test').getHistory(120))).not.toContain('正在分析');
  await adapter.chat('test', '再次检查', () => {});
  expect(JSON.stringify(mock.contexts)).not.toContain('正在分析');
});

it('exhaustion emits one precise error and no completed reply', async () => {
  const mock = provider([bad]);
  const directory = await mkdtemp(join(tmpdir(), 'candidate-exhaustion-')); directories.push(directory);
  const adapter = new DirectAdapter({ workspace: directory, tools: new ToolRegistry(), llmProvider: mock.value });
  const response = new ChatResponse(); const events: ChatEvent[] = [];
  const result = await adapter.chat('rejection-test', '诊断数据库', e => { response.observe(e); events.push(e); });
  expect(result).toMatchObject({ finalContent: '', stopReason: 'error', resolution: { reasonCode: 'MODEL_REPETITION_LOOP' } });
  expect(events.filter(e => ['complete', 'error', 'cancelled'].includes(e.type))).toHaveLength(1);
  expect(response.message(result)).toBeNull();
});

it.each(['cancel', 'callback-error', 'save-error'])('cannot restore a rejected body after %s', async failure => {
  const directory = await mkdtemp(join(tmpdir(), 'candidate-failure-')); directories.push(directory);
  const sessions = new SessionManager(directory);
  const mock = provider([bad]);
  const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: mock.value, sessionManager: sessions });
  const controller = new AbortController(); const response = new ChatResponse();
  if (failure === 'save-error') vi.spyOn(sessions, 'save').mockRejectedValue(new Error('storage unavailable'));
  const run = adapter.chat('failure', '诊断数据库', event => {
    response.observe(event);
    if (event.type === 'text_delta' && event.delta === '') {
      if (failure === 'cancel') controller.abort();
      if (failure === 'callback-error') throw new Error('event delivery failed');
    }
  }, undefined, controller.signal);
  if (failure === 'cancel') expect((await run).stopReason).toBe('cancelled');
  else await expect(run).rejects.toThrow();
  expect(response.message()).toBeNull();
  expect(JSON.stringify(sessions.getOrCreate('failure').getHistory(120))).not.toContain('正在分析');
});

it('invoke cannot broadcast completed for a rejected candidate even when thinking exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'candidate-invoke-')); directories.push(directory);
  const mock = provider([bad]);
  mock.value.chat = async () => ({ content: bad, reasoningContent: 'private analysis', finishReason: 'stop', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false });
  const adapter = new DirectAdapter({ workspace: directory, tools: new ToolRegistry(), llmProvider: mock.value });
  const sent: string[] = [];
  (adapter as any).sessionSubscribers.set('invoke-failure', new Set([{ readyState: 1, bufferedAmount: 0,
    send: (message: string, callback: () => void) => { sent.push(message); callback(); } }]));
  const result = await adapter.invoke('invoke-failure', '诊断数据库');
  expect(result.stopReason).toBe('error');
  expect(result.resolution?.reasonCode).toBe('MODEL_REPETITION_LOOP');
  expect(sent.map(message => JSON.parse(message).type)).toEqual(['error']);
  expect(JSON.stringify([result, sent])).not.toContain('正在分析');
});

it.each(['USER_CANCELLED', 'RUN_DEADLINE'])('async retraction %s preserves counters and terminal marker', async code => {
  const directory = await mkdtemp(join(tmpdir(), 'candidate-async-stop-')); directories.push(directory);
  const sessions = new SessionManager(directory); const mock = provider([bad]);
  const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: mock.value, sessionManager: sessions });
  const controller = new AbortController();
  const result = await adapter.chat('async-stop', '诊断数据库', async event => {
    if (event.type === 'text_delta' && event.delta === '') { controller.abort(new RuntimeError(code, 'stop')); await Promise.resolve(); }
  }, undefined, controller.signal);
  const kind = code === 'RUN_DEADLINE' ? 'timed_out' : 'cancelled';
  expect(result.stopReason).toBe(kind);
  const checkpoint = sessions.getOrCreate('async-stop').metadata.runtime_checkpoint!;
  expect(checkpoint.terminal_resolution).toMatchObject({ kind, reasonCode: code });
  expect(checkpoint.stream_state_v1).toMatchObject({ discardedBytes: Buffer.byteLength(bad) });
  expect(checkpoint.runtime_state_v1).toMatchObject({ modelSteps: 1, providerAttempts: 1, unknownRequests: 1 });
  expect(JSON.stringify(sessions.getOrCreate('async-stop').getHistory(120))).not.toContain('正在分析');
});

it('a persistence failure concurrent with Stop stays a failure and cannot emit cancelled/complete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'candidate-storage-stop-')); directories.push(directory);
  const sessions = new SessionManager(directory); const mock = provider(['safe']);
  const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: mock.value, sessionManager: sessions });
  const controller = new AbortController(); const events: ChatEvent[] = [];
  vi.spyOn(sessions, 'save').mockImplementationOnce(async () => { controller.abort(); throw new Error('storage failed'); });
  await expect(adapter.chat('storage-stop', '诊断数据库', event => { events.push(event); }, undefined, controller.signal)).rejects.toThrow('storage failed');
  expect(events.map(e => e.type)).toEqual(['error']);
});


it.each(['rejection', 'thinking-only', 'partial-tool'])('isolates discarded reasoning and text after %s', async failure => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-reset-')); directories.push(directory);
  const sessions = new SessionManager(directory);
  const mock = provider([bad, 'fresh answer']);
  const original = mock.value.chatStream;
  mock.value.chatStream = async (messages, tools, stream, options) => {
    const first = mock.contexts.length === 0;
    await stream.onThinkingDelta?.(first ? 'discarded thinking' : 'valid thinking');
    if (first && failure !== 'rejection') {
      mock.contexts.push(structuredClone(messages)); mock.callbacks.push(stream);
      if (failure === 'partial-tool') {
        await stream.onContentDelta('discarded text');
        await stream.onToolCallDelta?.({ index: 0, arguments: '{"sql":' } as any);
      }
      throw Object.assign(new Error('stream interrupted'), { code: 'ECONNRESET' });
    }
    return original(messages, tools, stream, options);
  };
  const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: mock.value, sessionManager: sessions });
  const events: ChatEvent[] = []; const response = new ChatResponse();
  const result = await adapter.chat('isolation', '诊断数据库', e => { events.push(e); response.observe(e); });
  expect(result.stopReason).toBe('completed');
  expect(result.thinkingContent).toBe('valid thinking');
  expect(JSON.stringify([result, response.message(result), sessions.getOrCreate('isolation').getCanonicalPage().messages, mock.contexts])).not.toContain('discarded');
  const count = events.length;
  await mock.callbacks[0].onThinkingDelta?.('late thinking');
  await mock.callbacks[0].onContentDelta('late text');
  expect(events).toHaveLength(count);
});


it('failed local finalization retains only the durable checkpoint and never restores its final candidate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-finalization-')); directories.push(directory);
  const sessions = new SessionManager(directory); const mock = provider(['uncommitted candidate']);
  const realSave = sessions.save.bind(sessions);
  vi.spyOn(sessions, 'save').mockImplementation(async session => {
    if (session.messages.some(m => m.role === 'assistant' && !m.tool_calls)) throw new Error('finalization failed');
    await realSave(session);
  });
  const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: mock.value, sessionManager: sessions });
  const events: ChatEvent[] = [];
  await expect(adapter.chat('finalization', 'diagnose', e => { events.push(e); })).rejects.toThrow('finalization failed');
  expect(events.at(-1)).toMatchObject({ type: 'error', finalContent: '' });
  expect(sessions.getOrCreate('finalization').messages.filter(m => m.role === 'assistant')).toEqual([]);
  const restored = new SessionManager(directory).getOrCreate('finalization');
  (adapter as any).runner._restoreRuntimeCheckpoint(restored);
  expect(restored.messages.filter(m => m.role === 'assistant')).toEqual([]);
});


it('accepted continuation stays anchored while final candidate reasoning is cancelled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuation-anchor-')); directories.push(directory);
  const sessions = new SessionManager(directory); const controller = new AbortController(); let requests = 0;
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat: async () => { throw new Error('unused'); }, chatStream: async (_m, _t, c) => {
    const first = ++requests === 1; const text = first ? 'durable prefix' : 'discarded suffix';
    await c.onThinkingDelta?.(first ? 'durable reasoning' : 'discarded reasoning'); await c.onContentDelta(text);
    return { content: text, finishReason: first ? 'length' : 'stop', toolCalls: [], usage: {}, hasToolCalls: false, shouldExecuteTools: false };
  } };
  const save = sessions.save.bind(sessions);
  vi.spyOn(sessions, 'save').mockImplementation(async session => {
    await save(session);
    if (session.metadata.runtime_checkpoint?.phase === 'final_response') controller.abort();
  });
  const adapter = new DirectAdapter({ sessionManager: sessions, tools: new ToolRegistry(), llmProvider: provider });
  const events: ChatEvent[] = [];
  const result = await adapter.chat('continuation', 'diagnose', e => { events.push(e); }, undefined, controller.signal);
  expect(result).toMatchObject({ stopReason: 'cancelled', finalContent: 'durable prefix', thinkingContent: 'durable reasoning' });
  expect(JSON.stringify(sessions.getOrCreate('continuation').messages)).not.toContain('discarded');
  const checkpoint = sessions.getOrCreate('continuation').metadata.runtime_checkpoint!;
  expect(checkpoint.stream_state_v1).toMatchObject({ anchor: { text: 'durable prefix', reasoning: 'durable reasoning' } });
  expect(checkpoint.assistantMessage).toBeUndefined();
  expect(events.at(-1)?.type).toBe('cancelled');
});


it('Stop during terminal checkpoint retracts final reasoning and persists the cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-checkpoint-stop-')); directories.push(directory);
  const sessions = new SessionManager(directory); const controller = new AbortController(); const mock = provider(['candidate']);
  const original = mock.value.chatStream;
  mock.value.chatStream = async (m, t, c, o) => { await c.onThinkingDelta?.('discarded reasoning'); return original(m, t, c, o); };
  const save = sessions.save.bind(sessions);
  vi.spyOn(sessions, 'save').mockImplementation(async session => {
    await save(session);
    if ((session.metadata.runtime_checkpoint?.terminal_resolution as any)?.kind === 'response_ready') controller.abort();
  });
  const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: mock.value, sessionManager: sessions });
  const result = await adapter.chat('terminal-stop', 'diagnose', () => {}, undefined, controller.signal);
  expect(result).toMatchObject({ stopReason: 'cancelled', finalContent: '' });
  expect(result.thinkingContent).toBeUndefined();
  const checkpoint = sessions.getOrCreate('terminal-stop').metadata.runtime_checkpoint!;
  expect(checkpoint.terminal_resolution).toMatchObject({ kind: 'cancelled' });
  expect(checkpoint.assistantMessage).toBeUndefined();
  expect(JSON.stringify(sessions.getOrCreate('terminal-stop').messages)).not.toContain('discarded');
});
