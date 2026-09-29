import { expect, it, vi, afterEach } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { AgentRunSpec, LLMProvider, LLMResponse, StreamCallbacks } from '../types.js';
const ok: LLMResponse = { content: 'late answer', finishReason: 'stop', toolCalls: [], usage: {}, hasToolCalls: false, shouldExecuteTools: false };
const spec = (overrides: Partial<AgentRunSpec> = {}): AgentRunSpec => ({ initialMessages: [], model: 'fixture', tools: new ToolRegistry(), maxIterations: 10, maxToolResultChars: 1000, hook: new NoopHook(), ...overrides });
afterEach(() => vi.useRealTimers());
it('timeout suppresses late deltas/results while the real request remains observable', async () => {
  vi.useFakeTimers();
  let finish!: (r: LLMResponse) => void;
  let callbacks!: StreamCallbacks;
  let settled = false;
  const hook = new NoopHook(); hook.wantsStreaming = () => true; hook.onStream = vi.fn();
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat: async () => ok,
    chatStream: async (_m, _t, cb) => { callbacks = cb; return new Promise(resolve => { finish = resolve; }); } };
  const pending = new AgentRunner(provider).run(spec({ hook, llmTimeoutS: 0.02,
    onProviderRequest: p => { void p.then(() => { settled = true; }); } }));
  await vi.advanceTimersByTimeAsync(21);
  const result = await pending;
  expect(result.stopReason).toBe('timed_out'); expect(settled).toBe(false);
  await callbacks.onContentDelta('late'); finish(ok); await vi.advanceTimersByTimeAsync(0);
  expect(hook.onStream).not.toHaveBeenCalled(); expect(result.messages.some(m => m.content === 'late answer')).toBe(false);
  expect(settled).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it('cancellation in retry backoff ends immediately and starts no new provider attempt', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const chat = vi.fn(async () => ({ ...ok, content: null, finishReason: 'error', error: 'busy', providerStatus: 503 }));
  const runner = new AgentRunner({ getDefaultModel: () => 'fixture', chat, chatStream: chat });
  const pending = runner.run(spec({ signal: controller.signal }));
  await vi.advanceTimersByTimeAsync(0); controller.abort();
  expect((await pending).stopReason).toBe('cancelled');
  expect(chat).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
it('noncooperative tools keep the runner owned until settlement and cannot publish late results', async () => {
  const controller = new AbortController();
  let finish!: (r: unknown) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(r => { started = r; });
  const tools = new ToolRegistry();
  tools.register({ name: 'write', description: 'write', parameters: { type: 'object', properties: {} }, readOnly: false, concurrencySafe: false, exclusive: true,
    execute: async () => { started(); return new Promise(r => { finish = r; }); } });
  const chat = vi.fn(async () => ({ ...ok, content: null, finishReason: 'tool_calls', hasToolCalls: true, shouldExecuteTools: true, toolCalls: [{ id: '1', name: 'write', arguments: {} }] }));
  const hook = new NoopHook(); hook.afterIteration = vi.fn();
  let returned = false;
  const pending = new AgentRunner({ getDefaultModel: () => 'fixture', chat, chatStream: chat }).run(spec({ tools, hook, signal: controller.signal })).then(r => { returned = true; return r; });
  await startedPromise; controller.abort(); await Promise.resolve(); expect(returned).toBe(false);
  finish('late success'); const result = await pending;
  expect(result.stopReason).toBe('cancelled'); expect(hook.afterIteration).not.toHaveBeenCalled();
  expect(JSON.stringify(result.messages)).not.toContain('late success'); expect(chat).toHaveBeenCalledTimes(1);
});
it('transient recovery respects Retry-After and retains exact provider attempt accounting', async () => {
  vi.useFakeTimers();
  const chat = vi.fn().mockResolvedValueOnce({ ...ok, finishReason: 'error', error: 'busy', providerStatus: 429, retryAfterMs: 3000 }).mockResolvedValue(ok);
  const pending = new AgentRunner({ getDefaultModel: () => 'fixture', chat, chatStream: chat }).run(spec());
  await vi.advanceTimersByTimeAsync(2999); expect(chat).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  const result = await pending;
  expect(result.runtimeState).toMatchObject({ providerAttempts: 2, total: 1, counts: { stream: 1 } });
  expect(result.stopReason).toBe('completed');
});
