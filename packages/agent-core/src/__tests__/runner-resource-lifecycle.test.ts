import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { LLMProvider, LLMCallOptions, AgentRunSpec } from '../types.js';
const response = { content: 'done', finishReason: 'stop', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false } as const;
const spec = (): AgentRunSpec => ({ initialMessages: [], tools: new ToolRegistry(), model: 'test', maxIterations: 1, maxToolResultChars: 100, hook: new NoopHook(), llmTimeoutS: 1 });
afterEach(() => vi.useRealTimers());
describe('runner request resources', () => {
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
