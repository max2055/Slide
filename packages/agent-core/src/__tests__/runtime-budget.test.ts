import { afterEach, expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { AgentRunSpec, LLMProvider, LLMResponse } from '../types.js';
import { RecoveryPolicy } from '../runtime/recovery-policy.js';

const ok: LLMResponse = { content: 'Complete.', finishReason: 'stop', toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 80 }, hasToolCalls: false, shouldExecuteTools: false };
const call = (n = 0): LLMResponse => ({ ...ok, content: null, finishReason: 'tool_calls', hasToolCalls: true, shouldExecuteTools: true, toolCalls: [{ id: `t${n}`, name: 'read', arguments: { n } }] });
function spec(extra: Partial<AgentRunSpec> = {}): AgentRunSpec {
  const tools = new ToolRegistry();
  tools.register({ name: 'read', description: 'read', parameters: { type: 'object', properties: {} }, readOnly: true, concurrencySafe: true, exclusive: false, execute: async args => args.n });
  return { initialMessages: [{ role: 'user', content: 'Inspect resources.' }], tools, model: 'test', maxIterations: 200, maxToolResultChars: 1000, hook: new NoopHook(),
    contextWindowTokens: 200_000, maxTokens: 4096,
    budgetLimits: { maxToolCalls: 500, maxProviderAttempts: 600, maxTotalTokens: 1_000_000, maxNoProgressSteps: 12 }, ...extra };
}
function provider(chat: LLMProvider['chat']): LLMProvider { return { getDefaultModel: () => 'test', chat, chatStream: (m, t, _c, o) => chat(m, t, o) }; }
afterEach(() => { vi.useRealTimers(); });

it('completes 45 model steps across 130 seconds with progress and no run deadline', async () => {
  vi.useFakeTimers(); let count = 0;
  const chat = vi.fn(async () => { await new Promise(r => setTimeout(r, 130_000 / 45)); return ++count < 45 ? call(count) : ok; });
  const run = new AgentRunner(provider(chat)).run(spec());
  await vi.advanceTimersByTimeAsync(130_100);
  const result = await run;
  expect(result.stopReason).toBe('completed'); expect(result.runtimeState).toMatchObject({ modelSteps: 45, toolCalls: 44, providerAttempts: 45, unknownRequests: 0, reservedTokens: 0 });
  expect(result.usage).toEqual({ prompt_tokens: 4500, completion_tokens: 450, cached_tokens: 3600 });
  expect(vi.getTimerCount()).toBe(0);
});
it('explicit deadline aborts a live provider and is persisted across resume', async () => {
  vi.useFakeTimers(); let aborted = false; const checkpoints: any[] = [];
  const chat = vi.fn(async (_m, _t, options) => new Promise<LLMResponse>((_resolve, reject) => options?.signal?.addEventListener('abort', () => { aborted = true; reject(options.signal!.reason); })));
  const run = new AgentRunner(provider(chat)).run(spec({ runTimeoutMs: 5000, checkpointCallback: async c => { checkpoints.push(c); } }));
  await vi.advanceTimersByTimeAsync(5001);
  expect((await run).resolution).toMatchObject({ kind: 'timed_out', reasonCode: 'RUN_DEADLINE' }); expect(aborted).toBe(true);
  const resumed = await new AgentRunner(provider(chat)).run(spec({ runTimeoutMs: 5000, resumeCheckpoint: checkpoints.at(-1) }));
  expect(resumed.resolution?.reasonCode).toBe('RUN_DEADLINE'); expect(chat).toHaveBeenCalledTimes(1);
});
it.each([
  ['MAX_PROVIDER_ATTEMPTS', { maxProviderAttempts: 2 }, 2],
  ['MAX_TOOL_CALLS', { maxToolCalls: 2 }, 3],
  ['NO_PROGRESS', { maxNoProgressSteps: 2 }, 3],
] as const)('enforces %s while model text and tool heartbeat keep arriving', async (reason, limits, requests) => {
  const chat = vi.fn(async () => ({ ...call(), content: 'Working on it.' }));
  const config = spec({ loopGuardThreshold: 100 }); config.budgetLimits = { ...config.budgetLimits!, ...limits };
  const result = await new AgentRunner(provider(chat)).run(config);
  expect(result.resolution?.reasonCode).toBe(reason); expect(chat).toHaveBeenCalledTimes(requests);
});
it('does not execute any part of a batch exceeding tool allowance', async () => {
  const config = spec(); config.budgetLimits!.maxToolCalls = 1;
  const execute = vi.spyOn(config.tools, 'execute');
  const result = await new AgentRunner(provider(async () => ({ ...call(), toolCalls: [...call(1).toolCalls, ...call(2).toolCalls] }))).run(config);
  expect(result.resolution?.reasonCode).toBe('MAX_TOOL_CALLS'); expect(execute).not.toHaveBeenCalled();
});
it('preserves unknown reservations across restart and fails closed before dispatch', async () => {
  const chat = vi.fn(async () => ({ ...call(), usage: {} }));
  const first = await new AgentRunner(provider(chat)).run(spec({ maxIterations: 2 }));
  expect(first.runtimeState).toMatchObject({ reservedTokens: 400000, unknownRequests: 2 });
  const config = spec({ resumeCheckpoint: { runtime_state_v1: first.runtimeState } }); config.budgetLimits!.maxTotalTokens = 500_000;
  const second = await new AgentRunner(provider(chat)).run(config);
  expect(second.resolution?.reasonCode).toBe('TOKEN_BUDGET'); expect(chat).toHaveBeenCalledTimes(2);
});
it('counts cached tokens as input subset and allows exactly covered reservations', async () => {
  const config = spec(); config.budgetLimits!.maxTotalTokens = 200000;
  const result = await new AgentRunner(provider(async () => ({ ...ok, usage: { prompt_tokens: 199904, completion_tokens: 96, cached_tokens: 199904 } }))).run(config);
  expect(result.stopReason).toBe('completed');
});
it('checks real usage before accepting a final result', async () => {
  const result = await new AgentRunner(provider(async () => ({ ...ok, usage: { prompt_tokens: 1_000_001, completion_tokens: 1 } }))).run(spec());
  expect(result.resolution?.reasonCode).toBe('TOKEN_BUDGET'); expect(result.messages).not.toContainEqual(expect.objectContaining({ content: ok.content, role: 'assistant' }));
});
it('keeps model-step cap effective even with progress', async () => {
  let n = 0; const result = await new AgentRunner(provider(async () => call(n++))).run(spec({ maxIterations: 3 }));
  expect(result.resolution?.reasonCode).toBe('MAX_MODEL_STEPS'); expect(result.runtimeState?.modelSteps).toBe(3);
  expect(result.finalContent).toContain('Emergency model-step fuse');
});
it('does not treat timestamp and request-id churn as semantic tool progress', async () => {
  let resultId = 0;
  const config = spec({ loopGuardThreshold: 100 });
  config.budgetLimits!.maxNoProgressSteps = 2;
  config.tools.register({ ...config.tools.get('read')!, execute: async () => ({
    status: 'unchanged',
    timestamp: `2026-09-29T00:00:0${resultId}Z`,
    'request-id': `request-${resultId++}`,
  }) });
  const chat = vi.fn(async () => call());
  const result = await new AgentRunner(provider(chat)).run(config);
  expect(result.resolution?.reasonCode).toBe('NO_PROGRESS');
  expect(chat).toHaveBeenCalledTimes(3);
});
it('credits materially different continuation candidates as progress', async () => {
  const responses = [
    { ...ok, content: 'First substantive section.', finishReason: 'length' },
    { ...ok, content: 'Second distinct section.', finishReason: 'length' },
    { ...ok, content: 'Final conclusion.' },
  ];
  const config = spec();
  config.budgetLimits!.maxNoProgressSteps = 2;
  const result = await new AgentRunner(provider(async () => responses.shift()!)).run(config);
  expect(result.stopReason).toBe('completed');
  expect(result.finalContent).toContain('Final conclusion.');
  expect(result.runtimeState?.progressKeyId).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(result.runtimeState)).not.toContain('First substantive section');
});
it('credits a new user injection before the next model step', async () => {
  let injections = 0;
  const config = spec({ injectionCallback: async () => injections++ === 0 ? [{ role: 'user', content: 'Also include the rollback state.' }] : [] });
  config.budgetLimits!.maxNoProgressSteps = 1;
  const chat = vi.fn(async () => ok);
  const result = await new AgentRunner(provider(chat)).run(config);
  expect(result.stopReason).toBe('completed');
  expect(result.hadInjections).toBe(true);
  expect(chat).toHaveBeenCalledTimes(2);
});
it('keeps recovery total finite across restored mixed categories', async () => {
  const recovery = new RecoveryPolicy(); recovery.state.modelSteps = 1; recovery.state.providerAttempts = 1;
  recovery.consume('empty'); recovery.consume('empty'); recovery.consume('continuation'); recovery.consume('continuation'); recovery.consume('continuation'); recovery.consume('stream'); recovery.consume('stream'); recovery.consume('repetition');
  const result = await new AgentRunner(provider(async () => ({ ...ok, content: '' }))).run(spec({ resumeCheckpoint: { runtime_state_v1: recovery.snapshot() } }));
  expect(result.resolution?.reasonCode).toBe('RECOVERY_LIMIT');
});
it('semantic output cannot evade wall-clock and empty heartbeats do not reset idle', async () => {
  vi.useFakeTimers();
  for (const activity of ['silent', 'heartbeat', 'content'] as const) {
    let ticker: ReturnType<typeof setInterval> | undefined;
    const mock: LLMProvider = { getDefaultModel: () => 'test', chat: async () => ok, chatStream: async (_m, _t, callbacks, options) => new Promise((_r, reject) => {
      if (activity === 'heartbeat') ticker = setInterval(() => callbacks.onActivity?.(), 20);
      if (activity === 'content') ticker = setInterval(() => { void callbacks.onContentDelta('real output'); }, 20);
      options?.signal?.addEventListener('abort', () => { clearInterval(ticker); reject(options.signal!.reason); });
    }) };
    const hook = new NoopHook(); hook.wantsStreaming = () => true;
    const run = new AgentRunner(mock).run(spec({ hook, llmTimeoutS: 0.1, streamIdleTimeoutS: 0.05 }));
    await vi.advanceTimersByTimeAsync(110);
    expect((await run).resolution?.reasonCode).toBe(activity === 'content' ? 'MODEL_REQUEST_TIMEOUT' : 'MODEL_IDLE_TIMEOUT');
  }
});
it('tool timeout retains actual settlement, blocks later tools, and ignores late success', async () => {
  vi.useFakeTimers(); let finish!: (value: unknown) => void; let aborted = false; let settled = false;
  const config = spec({ toolTimeoutMs: 50, onToolExecution: p => { p.then(() => { settled = true; }, () => { settled = true; }); } });
  const original = config.tools.get('read')!;
  config.tools.register({ ...original, execute: async (_args, ctx) => { ctx?.signal?.addEventListener('abort', () => { aborted = true; }); return new Promise(r => { finish = r; }); } });
  const execute = vi.spyOn(config.tools, 'execute');
  const run = new AgentRunner(provider(async () => ({ ...call(), toolCalls: [...call(1).toolCalls, ...call(2).toolCalls] }))).run(config);
  await vi.advanceTimersByTimeAsync(51); const result = await run;
  expect(result.resolution).toMatchObject({ kind: 'timed_out', reasonCode: 'TOOL_TIMEOUT' });
  expect(aborted).toBe(true); expect(settled).toBe(false); expect(execute).toHaveBeenCalledTimes(1);
  finish('late success'); await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(true);
  expect(JSON.stringify(result.messages)).not.toContain('late success'); expect(vi.getTimerCount()).toBe(0);
});

it('reserves concurrent child allowances durably without double-spending or counting them as measured usage', async () => {
  const { reserveChildBudget } = await import('../runtime/budget.js');
  const checkpoints: any[] = []; const allocations: any[] = [];
  const config = spec({ checkpointCallback: async c => { checkpoints.push(structuredClone(c)); } });
  config.tools.register({ ...config.tools.get('read')!, execute: async () => {
    const allocate = async () => { const allocation = await reserveChildBudget({ maxIterations: 25, budgetLimits: config.budgetLimits }); allocations.push(allocation); return 'child reserved'; };
    await Promise.all([allocate(), allocate()]);
    expect(checkpoints.at(-1).runtime_state_v1.delegated.tokens).toBeGreaterThan(0);
    return 'allocated';
  } });
  let calls = 0; const result = await new AgentRunner(provider(async () => ++calls === 1 ? call() : ok)).run(config);
  expect(result.stopReason).toBe('completed');
  expect(allocations[0].budgetLimits.maxTotalTokens + allocations[1].budgetLimits.maxTotalTokens).toBeLessThan(1_000_000 - 110);
  expect(result.runtimeState?.delegated?.tokens).toBe(allocations.reduce((sum, a) => sum + a.budgetLimits.maxTotalTokens, 0));
  expect(result.usage.prompt_tokens).toBe(200);
  const restored = new RecoveryPolicy(result.runtimeState).snapshot(); expect(restored.delegated).toEqual(result.runtimeState?.delegated);
});

it('a stricter server-declared tool timeout wins and abort cannot start a second business operation', async () => {
  vi.useFakeTimers(); const controller = new AbortController();
  const config = spec({ signal: controller.signal, toolTimeoutMs: 100, onToolExecution: () => {} });
  const execute = vi.fn(async (_args, ctx) => new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))));
  config.tools.register({ ...config.tools.get('read')!, timeoutMs: 10, execute });
  const run = new AgentRunner(provider(async () => ({ ...call(), toolCalls: [...call(1).toolCalls, ...call(2).toolCalls] }))).run(config);
  await vi.advanceTimersByTimeAsync(11);
  expect((await run).resolution?.reasonCode).toBe('TOOL_TIMEOUT'); expect(execute).toHaveBeenCalledTimes(1);
  controller.abort();
  expect((await new AgentRunner(provider(async () => call())).run(config)).stopReason).toBe('cancelled'); expect(execute).toHaveBeenCalledTimes(1);
});

it('restart does not credit unverifiable first tool evidence as fresh progress', async () => {
  const recovery = new RecoveryPolicy();
  Object.assign(recovery.state, { modelSteps: 1, providerAttempts: 1, noProgressSteps: 1, progressKeyId: '00000000-0000-0000-0000-000000000000', progressEvidence: ['a'.repeat(64)] });
  const config = spec({ resumeCheckpoint: { runtime_state_v1: recovery.snapshot() } }); config.budgetLimits!.maxNoProgressSteps = 2;
  const chat = vi.fn(async () => call());
  const result = await new AgentRunner(provider(chat)).run(config);
  expect(result.resolution?.reasonCode).toBe('NO_PROGRESS'); expect(chat).toHaveBeenCalledTimes(1);
  expect(result.runtimeState?.noProgressSteps).toBe(2);
});

it('tool timeout during child admission cannot start a child after persistence returns', async () => {
  vi.useFakeTimers(); const { reserveChildBudget } = await import('../runtime/budget.js');
  let release!: () => void; let saved = false; let children = 0; let settled = false;
  const config = spec({ toolTimeoutMs: 20, onToolExecution: p => { p.then(() => { settled = true; }, () => { settled = true; }); },
    checkpointCallback: async p => {
      if ((p.runtime_state_v1 as any).delegated && !saved) { saved = true; await new Promise<void>(r => { release = r; }); }
    } });
  config.tools.register({ ...config.tools.get('read')!, execute: async () => { await reserveChildBudget({ maxIterations: 25, budgetLimits: config.budgetLimits }); children++; return 'spawned'; } });
  const run = new AgentRunner(provider(async () => call())).run(config);
  await vi.advanceTimersByTimeAsync(21); expect((await run).resolution?.reasonCode).toBe('TOOL_TIMEOUT');
  expect(settled).toBe(false); release(); await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true); expect(children).toBe(0);
});
