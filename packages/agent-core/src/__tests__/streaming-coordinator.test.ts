import { describe, it, expect, vi } from 'vitest';
import { StreamingCoordinator } from '../runtime/streaming-coordinator.js';
import { ModelStep } from '../runtime/model-step.js';
import { NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import { OpenAIProvider } from '../openai-provider.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AgentHookContext, AgentRunSpec, LLMProvider, LLMResponse } from '../types.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>(r => setImmediate(r));
const response: LLMResponse = { content: 'ab', toolCalls: [], usage: {}, finishReason: 'stop', shouldExecuteTools: false, hasToolCalls: false };
function fixture(provider: LLMProvider, hook = new NoopHook()): { spec: AgentRunSpec; context: AgentHookContext; step: ModelStep } {
  return { step: new ModelStep(provider), spec: { initialMessages: [], model: 'test', maxIterations: 1,
    tools: new ToolRegistry(), maxToolResultChars: 1000, hook, llmTimeoutS: 1 },
    context: { iteration: 0, messages: [], response: null, usage: {}, toolCalls: [], toolResults: [], toolEvents: [],
      streamedContent: false, streamedReasoning: false, finalContent: null, stopReason: null, error: null } };
}

describe('bounded streaming admission and ordered drain', () => {
  it.each([{ maxPendingEvents: 2, maxPendingBytes: 100 }, { maxPendingEvents: 100, maxPendingBytes: 8 }])(
    'includes active writes in both limits: %j', async limits => {
      const gate = deferred(); const seen: string[] = [];
      const queue = new StreamingCoordinator<string>(async value => { await gate.promise; seen.push(value); },
        { ...limits, size: value => Buffer.byteLength(value), consumerTimeoutMs: 1000 });
      await queue.enqueue('中文');
      // Six bytes active: event limit allows the second event, byte limit holds it.
      const second = queue.enqueue('ab'); await second;
      let advanced = false;
      const third = queue.enqueue('cd').then(() => { advanced = true; });
      await tick(); expect(advanced).toBe(false);
      expect(queue.metrics.pendingEvents).toBeLessThanOrEqual(limits.maxPendingEvents);
      expect(queue.metrics.pendingBytes).toBeLessThanOrEqual(limits.maxPendingBytes);
      gate.resolve(); await third; await queue.drain();
      expect(seen).toEqual(['中文', 'ab', 'cd']);
      expect(queue.metrics.pendingBytes).toBe(0);
    });

  it('merges only queued adjacent raw text, preserving reasoning/tool/control/terminal boundaries', async () => {
    type Event = { type: string; text: string };
    const gate = deferred(); const seen: Event[] = [];
    const queue = new StreamingCoordinator<Event>(async event => { await gate.promise; seen.push(event); }, {
      size: event => Buffer.byteLength(event.text) + 16,
      merge: (a, b) => a.type === 'text' && b.type === 'text' ? { type: 'text', text: a.text + b.text } : undefined,
    });
    const events = ['active', 'b', 'c', 'reasoning', 'tool', 'rejection', 'terminal'].map(text =>
      ({ type: ['active', 'b', 'c'].includes(text) ? 'text' : text, text }));
    for (const event of events) await queue.enqueue(event);
    let drained = false; const drain = queue.drain().then(() => { drained = true; });
    await tick(); expect(drained).toBe(false);
    gate.resolve(); await drain;
    expect(seen.map(e => e.text)).toEqual(['active', 'bc', 'reasoning', 'tool', 'rejection', 'terminal']);
  });

  it('rejects oversized events without buffering them', async () => {
    const write = vi.fn();
    const queue = new StreamingCoordinator<string>(write, { size: s => Buffer.byteLength(s), maxPendingBytes: 5 });
    await expect(queue.enqueue('中文')).rejects.toMatchObject({ code: 'STREAM_EVENT_TOO_LARGE' });
    await expect(queue.drain()).rejects.toMatchObject({ code: 'STREAM_EVENT_TOO_LARGE' });
    expect(write).not.toHaveBeenCalled(); expect(queue.metrics.pendingBytes).toBe(0);
  });

  it('observes writer rejection before drain and releases a blocked producer', async () => {
    const gate = deferred(); const failed = vi.fn();
    const queue = new StreamingCoordinator<string>(async () => { await gate.promise; throw new Error('consumer failed'); },
      { size: s => s.length, maxPendingEvents: 1, onError: failed });
    await queue.enqueue('a'); const blocked = queue.enqueue('b');
    const assertion = expect(blocked).rejects.toMatchObject({ code: 'STREAM_CONSUMER_FAILED' });
    gate.resolve(); await assertion;
    await expect(queue.drain()).rejects.toMatchObject({ code: 'STREAM_CONSUMER_FAILED' });
    expect(failed).toHaveBeenCalledTimes(1); expect(queue.metrics.pendingEvents).toBe(0);
  });

  it('times out a cooperative hanging writer with no remaining consumer work', async () => {
    let active = 0;
    const queue = new StreamingCoordinator<string>(async (_, signal) => {
      active++;
      try { await new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true })); }
      finally { active--; }
    }, { size: s => s.length, consumerTimeoutMs: 20 });
    await queue.enqueue('a');
    await expect(queue.drain()).rejects.toMatchObject({ code: 'STREAM_CONSUMER_TIMEOUT' });
    await tick(); expect(active).toBe(0); expect(queue.metrics.pendingEvents).toBe(0);
  });
});

describe('ModelStep reader/writer lifecycle', () => {
  it('publishes waiting before provider entry and generating only at actual output', async () => {
    const gate = deferred(); const entered = deferred(); const phases: string[] = [];
    const provider: LLMProvider = { getDefaultModel: () => 'test', chat: async () => response,
      chatStream: async (_, __, callbacks) => {
        entered.resolve(); await gate.promise;
        await callbacks.onThinkingDelta?.('actual reasoning'); await callbacks.onContentDelta('a'); return response;
      } };
    const hook = Object.assign(new NoopHook(), { wantsStreaming: () => true });
    const f = fixture(provider, hook); f.spec.onRuntimePhase = phase => { phases.push(phase); };
    const run = f.step.request(f.spec, [], hook, f.context);
    await entered.promise; expect(phases).toEqual(['waiting_model']);
    gate.resolve(); await run; expect(phases).toEqual(['waiting_model', 'generating']);
  });
  it('real OpenAI SDK SSE decoder advances independently, retaining reasoning/text/tool assembly', async () => {
    const server = createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = [
        { delta: { reasoning_content: '推理' } },
        { delta: { content: '答' } },
        { delta: { tool_calls: [{ index: 0, id: 'tool-one', function: { name: 'read', arguments: '{"x":' } }] } },
        { delta: { content: '案', tool_calls: [{ index: 0, function: { arguments: '1}' } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ];
      for (const chunk of chunks) {
        const event = `data: ${JSON.stringify({ id: 'fixture', choices: [chunk] })}\n\n`;
        res.write(event.slice(0, 7)); res.write(event.slice(7));
      }
      res.end('data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const gate = deferred(); const read = deferred(); const seen: string[] = [];
    const hook = Object.assign(new NoopHook(), { wantsStreaming: () => true,
      emitReasoning: async (text: string | null) => { await gate.promise; seen.push(text!); },
      onStream: async (_: AgentHookContext, text: string) => { seen.push(text); } });
    const provider = new OpenAIProvider({ apiKey: 'controlled-fixture', baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
    const f = fixture(provider, hook); f.spec.onProviderRequest = request => { void request.then(() => read.resolve(), () => read.resolve()); };
    try {
      let returned = false;
      const request = f.step.request(f.spec, [], hook, f.context).then(value => { returned = true; return value; });
      await read.promise; expect(returned).toBe(false); expect(seen).toEqual([]);
      gate.resolve();
      expect(await request).toMatchObject({ content: '答案', reasoningContent: '推理', finishReason: 'tool_calls',
        toolCalls: [{ id: 'tool-one', name: 'read', arguments: { x: 1 } }], shouldExecuteTools: true });
      expect(seen).toEqual(['推理', '答', '案']);
    } finally { gate.resolve(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
  it('reader advances before slow hook finishes and drains before returning', async () => {
    const gate = deferred(); const read = deferred(); const seen: string[] = [];
    const provider: LLMProvider = { getDefaultModel: () => 'test', chat: async () => response,
      chatStream: async (_, __, callbacks) => {
        await callbacks.onContentDelta('a'); await callbacks.onThinkingDelta?.('r');
        await callbacks.onContentDelta('b'); read.resolve(); return response;
      } };
    const hook = { ...new NoopHook(), wantsStreaming: () => true,
      onStream: async (_: AgentHookContext, text: string) => { await gate.promise; seen.push(text); },
      emitReasoning: async (text: string | null) => { seen.push(text!); } };
    const f = fixture(provider, Object.assign(new NoopHook(), hook));
    let returned = false;
    const request = f.step.request(f.spec, [], f.spec.hook, f.context).then(r => { returned = true; return r; });
    await read.promise; expect(returned).toBe(false); expect(seen).toEqual([]);
    gate.resolve(); await request; expect(seen).toEqual(['a', 'r', 'b']);
  });

  it.each(['stop', 'request', 'idle', 'consumer', 'failure'] as const)('converges at high water on %s', async mode => {
    let writers = 0; const firstWrite = deferred(); let providerEnded = false; let providerSignal: AbortSignal | undefined;
    const provider: LLMProvider = { getDefaultModel: () => 'test', chat: async () => response,
      chatStream: async (_, __, callbacks, options) => {
        providerSignal = options?.signal;
        try { for (let i = 0; i < 100; i++) await callbacks.onThinkingDelta?.('x'); return response; }
        finally { providerEnded = true; }
      } };
    const controller = new AbortController();
    const hook = Object.assign(new NoopHook(), { wantsStreaming: () => true,
      emitReasoning: async (_: string | null, signal?: AbortSignal) => {
        writers++; firstWrite.resolve();
        try {
          if (mode === 'failure') throw new Error('write rejected');
          await new Promise<void>(r => signal!.addEventListener('abort', () => r(), { once: true }));
        } finally { writers--; }
      } });
    const f = fixture(provider, hook); f.spec.signal = controller.signal;
    f.spec.streamingLimits = { maxPendingEvents: 1, maxPendingBytes: 100, consumerTimeoutMs: mode === 'consumer' ? 20 : 1000 };
    if (mode === 'request') f.spec.llmTimeoutS = 0.02;
    if (mode === 'idle') f.spec.streamIdleTimeoutS = 0.02;
    const expected = { stop: 'USER_CANCELLED', request: 'MODEL_REQUEST_TIMEOUT', idle: 'MODEL_IDLE_TIMEOUT',
      consumer: 'STREAM_CONSUMER_TIMEOUT', failure: 'STREAM_CONSUMER_FAILED' }[mode];
    const request = f.step.request(f.spec, [], hook, f.context);
    const assertion = expect(request).rejects.toMatchObject({ code: expected });
    await firstWrite.promise; if (mode === 'stop') controller.abort(); await assertion;
    await tick(); expect(writers).toBe(0); expect(providerEnded).toBe(true); expect(providerSignal?.aborted).toBe(true);
  });
});
