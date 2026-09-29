import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionManager, ToolRegistry, type LLMProvider, type LLMResponse, type Message, type StreamCallbacks } from '@slide/agent-core';
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
  expect(events).toContainEqual({ type: 'text_delta', delta: '' });
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
  (adapter as any).sessionSubscribers.set('invoke-failure', new Set([{ send: (message: string) => sent.push(message) }]));
  const result = await adapter.invoke('invoke-failure', '诊断数据库');
  expect(result.stopReason).toBe('error');
  expect(result.resolution?.reasonCode).toBe('MODEL_REPETITION_LOOP');
  expect(sent.map(message => JSON.parse(message).type)).toEqual(['error']);
  expect(JSON.stringify([result, sent])).not.toContain('正在分析');
});
