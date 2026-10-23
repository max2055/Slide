import { afterEach, expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import { RuntimeError, RecoveryPolicy } from '../runtime/recovery-policy.js';
import type { LLMProvider, LLMResponse, AgentRunSpec } from '../types.js';

afterEach(() => vi.restoreAllMocks());
const reply = (): LLMResponse => ({ content: 'Evidence is incomplete; preserve the gaps.', finishReason: 'stop', toolCalls: [], hasToolCalls: false, shouldExecuteTools: false, usage: { prompt_tokens: 10, completion_tokens: 10 } });

// Controlled phase clock exercises the production runner, not a copied planner.
// Admission and checkpoint delays are measured independently of provider time.
async function run(scale = 1, admission = 2, commit = 2, late = false) {
  let now = 100000, n = 0;
  const deadline = now + 120 * scale, controller = new AbortController();
  const advance = (ms: number) => { now += ms * scale; if (now >= deadline) controller.abort(new RuntimeError('RUN_DEADLINE', 'Run deadline exceeded')); };
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const stages: any[] = [], calls: any[] = [], saved: any[] = [];
  const tools = new ToolRegistry(), execute = vi.fn(async () => { stages.push(['tool', now]); advance(2); return 'actual evidence'; });
  tools.register({ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} }, readOnly: true, concurrencySafe: true, exclusive: false, execute });
  const hook = new NoopHook();
  hook.beforeIteration = async () => { stages.push(['admission', now]); advance(admission); };
  hook.afterIteration = async () => { stages.push(['after', now]); advance(2); };
  const provider: LLMProvider = { getDefaultModel: () => 'test', chat: async (messages, definitions, options) => {
    calls.push({ at: now, tools: definitions.length, timeoutS: options?.timeoutS, messages }); stages.push(['provider', now]);
    advance(late && !definitions.length ? (deadline - now) / scale - 1 : 20);
    if (!definitions.length) return reply();
    return { ...reply(), content: null, finishReason: 'tool_calls', hasToolCalls: true, shouldExecuteTools: true,
      toolCalls: [{ id: `read-${++n}`, name: 'read', arguments: {} }] };
  }, chatStream: async () => reply() };
  const spec: AgentRunSpec = { initialMessages: [{ role: 'system', content: 'Read only.' }, { role: 'user', content: 'Inspect and report.' }], tools, model: 'test', hook,
    maxIterations: 8, maxTokens: 500, contextWindowTokens: 15000, maxToolResultChars: 1000,
    runTimeoutMs: 120 * scale, llmTimeoutS: 120 * scale / 1000, signal: controller.signal,
    budgetLimits: { maxProviderAttempts: 8, maxToolCalls: 20, maxTotalTokens: 128000, maxNoProgressSteps: 8 },
    checkpointCallback: async c => { stages.push([c.phase ?? 'counters', now]); advance(commit); saved.push(structuredClone(c)); } };
  const result = await new AgentRunner(provider).run(spec);
  return { result, calls, execute, stages, now, deadline, saved };
}

it.each([1, 100])('preserves time for a complete answer from measured cycles at scale %s without a fixed seconds threshold', async scale => {
  const f = await run(scale);
  expect(f.result.stopReason).toBe('completed');
  expect(f.calls.map(c => c.tools)).toEqual([1, 1, 0]);
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.now).toBeLessThan(f.deadline);
  expect((f.result.runtimeState as any).timing).toMatchObject({ cycleMs: 34 * scale, providerMs: 20 * scale });
  expect(f.result.runtimeState).toMatchObject({ unknownRequests: 0, reservedTokens: 0 });
});
it.each([[15, 2], [2, 8]])('includes measured slow admission=%s and persistence=%s in the closure forecast', async (admission, commit) => {
  const f = await run(1, admission, commit);
  expect(f.result.stopReason).toBe('completed');
  expect(f.calls.at(-1).tools).toBe(0);
  expect(f.now).toBeLessThan(f.deadline);
});
it('retains the hard deadline when a final reply leaves less time than checkpointing needs', async () => {
  const f = await run(1, 2, 2, true);
  expect(f.calls.at(-1).tools).toBe(0);
  expect(f.result.resolution?.reasonCode).toBe('RUN_DEADLINE');
  expect(f.result.stopReason).not.toBe('completed');
});
it('validates and round-trips measured timing across recovery without extending the deadline', () => {
  const state = new RecoveryPolicy().snapshot();
  (state as any).timing = { cycleMs: 340, providerMs: 200 };
  state.deadlineAt = 100000;
  expect((new RecoveryPolicy(state).snapshot() as any).timing).toEqual({ cycleMs: 340, providerMs: 200 });
  for (const timing of [{ cycleMs: -1, providerMs: 0 }, { cycleMs: 2, providerMs: NaN }, { cycleMs: 1, providerMs: 2 }]) {
    expect(() => new RecoveryPolicy({ ...state, timing })).toThrow('Invalid runtime timing');
  }
});
