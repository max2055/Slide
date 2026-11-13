import { afterEach, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import { ModelStep } from '../runtime/model-step.js';
import { RecoveryPolicy } from '../runtime/recovery-policy.js';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { AgentHookContext, AgentRunSpec, LLMProvider, LLMResponse } from '../types.js';

const maxDelay = 2_147_483_647;
const response: LLMResponse = { content: 'Done.', toolCalls: [], usage: {}, finishReason: 'stop', shouldExecuteTools: false, hasToolCalls: false };
function fixture(extra: Partial<AgentRunSpec> = {}) {
  const chat = vi.fn<LLMProvider['chat']>(async () => response);
  const provider: LLMProvider = { getDefaultModel: () => 'test', chat, chatStream: (m, t, _c, o) => chat(m, t, o) };
  const spec: AgentRunSpec = { initialMessages: [], model: 'test', maxIterations: 1, tools: new ToolRegistry(),
    maxToolResultChars: 1000, hook: new NoopHook(), ...extra };
  const context: AgentHookContext = { iteration: 0, messages: [], response: null, usage: {}, toolCalls: [], toolResults: [], toolEvents: [],
    streamedContent: false, streamedReasoning: false, finalContent: null, stopReason: null, error: null };
  return { chat, provider, spec, request: () => new ModelStep(provider).request(spec, [], spec.hook, context) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// GitHub #453: exercise the actual runtime admission, including restored deadlines.
it.each([maxDelay + 1, 3_000_000_000, Number.MAX_SAFE_INTEGER, Infinity, NaN, 0, -1, 1.5])('rejects unsafe run timeout %s before dispatch', async runTimeoutMs => {
  const f = fixture({ runTimeoutMs });
  await expect(new AgentRuntime(() => f.provider, { runTool: vi.fn() }).run(f.spec)).rejects.toMatchObject({ code: 'INVALID_POLICY' });
  expect(f.chat).not.toHaveBeenCalled();
});
it('rejects a restored remote deadline before creating a Node timer', async () => {
  const state = new RecoveryPolicy().snapshot(); state.deadlineAt = Date.now() + 3_000_000_000;
  const f = fixture({ resumeCheckpoint: { runtime_state_v1: state } });
  await expect(new AgentRuntime(() => f.provider, { runTool: vi.fn() }).run(f.spec)).rejects.toMatchObject({ code: 'INVALID_POLICY' });
  expect(f.chat).not.toHaveBeenCalled();
});
it('accepts the exact Node maximum and clears the timer after a short successful run', async () => {
  vi.useFakeTimers();
  const f = fixture({ runTimeoutMs: maxDelay });
  expect((await new AgentRunner(f.provider).run(f.spec)).stopReason).toBe('completed');
  expect(vi.getTimerCount()).toBe(0);
});
it('arms real Node timers within range instead of relying only on simulated timers', async () => {
  const native = globalThis.setTimeout;
  const armed: number[] = [];
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    const timer = native(...args);
    armed.push((timer as unknown as { _idleTimeout: number })._idleTimeout);
    return timer;
  }) as typeof setTimeout);
  const f = fixture({ runTimeoutMs: maxDelay });
  expect((await new AgentRunner(f.provider).run(f.spec)).stopReason).toBe('completed');
  expect(armed.some(delay => delay > maxDelay - 1000)).toBe(true);
  expect(armed.every(delay => delay > 1 && delay <= maxDelay)).toBe(true);
});
it('uses an explicit shorter limit when a restored deadline is remote', async () => {
  const state = new RecoveryPolicy().snapshot(); state.deadlineAt = Date.now() + 3_000_000_000;
  const f = fixture({ runTimeoutMs: 1000, resumeCheckpoint: { runtime_state_v1: state } });
  expect((await new AgentRunner(f.provider).run(f.spec)).stopReason).toBe('completed');
});
it('expires short runs, preserves the deadline on recovery, and never redispatches an expired request', async () => {
  vi.useFakeTimers();
  const f = fixture({ runTimeoutMs: 100, llmTimeoutS: 1 });
  f.chat.mockImplementation(() => new Promise(() => {})); // provider deliberately ignores abort
  const pending = new AgentRunner(f.provider).run(f.spec);
  await vi.advanceTimersByTimeAsync(101);
  const first = await pending;
  expect(first.resolution?.reasonCode).toBe('RUN_DEADLINE');
  const next = await new AgentRunner(f.provider).run({ ...f.spec, resumeCheckpoint: { runtime_state_v1: first.runtimeState } });
  expect(next.resolution?.reasonCode).toBe('RUN_DEADLINE');
  expect(f.chat).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

// GitHub #690: explicit invalid configuration must fail before any provider call.
it.each(['abc', '', ' ', '300seconds', 'Infinity', 'NaN', '0', '-1', '1e309', '2147483.648'])('rejects invalid model timeout environment %j', async value => {
  vi.stubEnv('NANOBOT_LLM_TIMEOUT_S', value);
  const f = fixture();
  await expect(f.request()).rejects.toMatchObject({ code: 'INVALID_POLICY' });
  expect(f.chat).not.toHaveBeenCalled();
});
it.each([NaN, Infinity, 0, -1, maxDelay / 1000 + 0.001])('rejects invalid caller model timeout %s', async llmTimeoutS => {
  const f = fixture({ llmTimeoutS });
  await expect(f.request()).rejects.toMatchObject({ code: 'INVALID_POLICY' });
  expect(f.chat).not.toHaveBeenCalled();
});
it('keeps a 300 second wall clock when the environment is absent, even if abort is ignored', async () => {
  vi.useFakeTimers(); vi.stubEnv('NANOBOT_LLM_TIMEOUT_S', undefined);
  const f = fixture(); f.chat.mockImplementation(() => new Promise(() => {}));
  const checked = expect(f.request()).rejects.toMatchObject({ code: 'MODEL_REQUEST_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(299_999); expect(f.chat).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1); await checked;
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['0.05', '3e2', '2147483.647'])('accepts complete finite positive model timeout %j', async value => {
  vi.stubEnv('NANOBOT_LLM_TIMEOUT_S', value);
  const f = fixture(); await f.request();
  expect(f.chat.mock.calls[0]?.[2]).toMatchObject({ timeoutS: Number(value) });
});
it('lets a valid caller timeout take precedence over invalid environment configuration', async () => {
  vi.stubEnv('NANOBOT_LLM_TIMEOUT_S', 'abc');
  const f = fixture({ llmTimeoutS: 0.1 }); await f.request();
  expect(f.chat.mock.calls[0]?.[2]).toMatchObject({ timeoutS: 0.1 });
});
it.each([false, true])('rejects invalid environment before %s streaming dispatch and leaves no timer', async streaming => {
  vi.useFakeTimers(); vi.stubEnv('NANOBOT_LLM_TIMEOUT_S', 'abc');
  const hook = new NoopHook(); hook.wantsStreaming = () => streaming;
  const f = fixture({ hook });
  await expect(f.request()).rejects.toMatchObject({ code: 'INVALID_POLICY' });
  expect(f.chat).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
