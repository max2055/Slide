import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { LLMProvider, LLMCallOptions, AgentRunSpec } from '../types.js';
const response = { content: 'done', finishReason: 'stop', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false } as const;
const spec = (): AgentRunSpec => ({ initialMessages: [], tools: new ToolRegistry(), model: 'test', maxIterations: 1, maxToolResultChars: 100, hook: new NoopHook(), llmTimeoutS: 1 });
afterEach(() => vi.useRealTimers());
describe('runner request resources', () => {
  it('observes the actual finalization retry promise after timeout, without hiding settlement', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const chat = async () => {
      if (++calls < 3) return { ...response, toolCalls: [], content: '' };
      await gate;
      return { ...response, toolCalls: [] };
    };
    const requests: Promise<unknown>[] = [];
    const run = new AgentRunner({ chat, chatStream: chat, getDefaultModel: () => 'test' }).run({
      ...spec(), maxIterations: 4, onProviderRequest: promise => { requests.push(promise); },
    });
    await vi.advanceTimersByTimeAsync(1001);
    expect((await run).stopReason).toBe('timed_out');
    expect(requests).toHaveLength(3);
    let settled = false;
    void requests[2].then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await requests[2];
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['success', 'failure'])('cleans timers after %s', async mode => {
    vi.useFakeTimers();
    const chat = vi.fn(async () => { if (mode === 'failure') throw new Error('request failed'); return { ...response }; });
    const provider = { chat, chatStream: chat, getDefaultModel: () => 'test' } as unknown as LLMProvider;
    await new AgentRunner(provider).run(spec()); expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts the provider at deadline and removes its timer', async () => {
    vi.useFakeTimers(); let signal: AbortSignal;
    const chat = vi.fn((_m, _t, opts: LLMCallOptions) => { signal = opts.signal!; return new Promise(() => {}); });
    const provider = { chat, chatStream: chat, getDefaultModel: () => 'test' } as unknown as LLMProvider;
    const pending = new AgentRunner(provider).run(spec()); await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).stopReason).toBe('timed_out'); expect(signal!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])('cancels a non-cooperative provider (streaming=%s)', async streaming => {
    vi.useFakeTimers(); const controller = new AbortController(); let signal: AbortSignal;
    const provider = { getDefaultModel: () => 'test', chat: (_m, _t, o) => { signal = o!.signal!; return new Promise(() => {}); }, chatStream: (_m, _t, _c, o) => { signal = o!.signal!; return new Promise(() => {}); } } as LLMProvider;
    const hook = new NoopHook(); hook.wantsStreaming = () => streaming;
    const pending = new AgentRunner(provider).run({ ...spec(), signal: controller.signal, hook });
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect((await pending).stopReason).toBe('cancelled'); expect(signal!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
});

it.each([false, true])('reports actual provider settlement after run cancellation (streaming=%s)', async streaming => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const chat = vi.fn(async () => { await gate; return { ...response }; });
  const provider = { chat, chatStream: chat, getDefaultModel: () => 'test' } as unknown as LLMProvider;
  const controller = new AbortController();
  const hook = new NoopHook();
  hook.wantsStreaming = () => streaming;
  let settled = false;
  const observed = vi.fn((request: Promise<unknown>) => { void request.then(() => { settled = true; }); });
  const pending = new AgentRunner(provider).run({ ...spec(), hook, signal: controller.signal, onProviderRequest: observed });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect((await pending).stopReason).toBe('cancelled');
  expect(observed).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
