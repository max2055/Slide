import { afterEach, expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook, ToolRegistry, RecoveryPolicy, type RecoverySnapshot, type AgentRunSpec, type LLMProvider } from '@slide/agent-core';
// Internal ALS test harness; keep it outside the API compiler's source roots.
// The public agent-core entry point intentionally does not export this context.
const { withBudgetContext }: {
  withBudgetContext: <T>(spec: AgentRunSpec, state: RecoverySnapshot, task: () => T, persist: () => Promise<void>) => T;
} = await import(new URL('../../../../packages/agent-core/src/runtime/budget.js', import.meta.url).href);
import type { ActorContext } from '../auth/actor-context.js';
import { SubagentManager } from './subagent-manager.js';
import { SubagentRegistry } from './subagent-registry.js';
import { createSubagentAccessTool, createSpawnSubagentTool, setSubagentManager } from './subagent-spawn-tool.js';

const owner = { userId: 71 } as ActorContext;
const other = { userId: 72 } as ActorContext;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const completed = { stopReason: 'completed', finalContent: 'done' };
function fakeRunner(run: (spec: AgentRunSpec) => Promise<any>) {
  return { run, getDefaultModel: () => 'test' } as unknown as AgentRunner;
}
function setup(run: (spec: AgentRunSpec) => Promise<any> = async () => completed, retention = { ttlMs: 1000, maxRecords: 3 }) {
  const registry = new SubagentRegistry(retention);
  const manager = new SubagentManager(fakeRunner(run), undefined, undefined, registry);
  setSubagentManager(manager);
  return { registry, manager };
}
const budget = { maxProviderAttempts: 100, maxToolCalls: 100, maxTotalTokens: 100_000, maxNoProgressSteps: 10 };
function parent(signal?: AbortSignal) {
  return { maxIterations: 100, budgetLimits: budget, signal } as AgentRunSpec;
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

// #307: actual reserveChildBudget + persistence barrier, no model/database needed.
it('rejects racing admission before irreversible allocation and lets another actor run', async () => {
  vi.stubEnv('AGENT_MAX_CONCURRENT_RUNS', '1');
  const persist = deferred();
  const execution = deferred<any>();
  const { manager, registry } = setup(() => execution.promise);
  const state = new RecoveryPolicy().state;
  const save = vi.fn(() => persist.promise);
  const first = withBudgetContext(parent(), state, () => manager.spawn('agent', 'one', 'p', owner), save);
  const allocated = state.delegated!.tokens;
  await expect(withBudgetContext(parent(), state, () => manager.spawn('agent', 'two', 'p', owner), save))
    .rejects.toThrow('SUBAGENT_CONCURRENCY_LIMIT');
  expect(state.delegated!.tokens).toBe(allocated);
  expect(save).toHaveBeenCalledTimes(1);
  expect(registry.listRuns()).toHaveLength(0);
  const otherId = await manager.spawn('agent', 'other actor', 'p', other);
  persist.resolve();
  const id = await first;
  expect(registry.listRuns()).toHaveLength(2);
  expect(registry.getRun(id)!.sessionKey).not.toBe(registry.getRun(otherId)!.sessionKey);
  execution.resolve(completed);
  await vi.waitFor(async () => expect((await manager.access(id, owner)).status).toBe('completed'));
  await expect(manager.spawn('agent', 'next', 'p', owner)).resolves.toBeTypeOf('string');
});

it('admits two normal concurrent children and keeps active history past TTL', async () => {
  vi.stubEnv('AGENT_MAX_CONCURRENT_RUNS', '2');
  vi.useFakeTimers();
  const execution = deferred<any>();
  const { manager, registry } = setup(() => execution.promise);
  const state = new RecoveryPolicy().state;
  const saved: number[] = [];
  const ids = await withBudgetContext(parent(), state, () => Promise.all([
    manager.spawn('agent', 'one', 'p', owner), manager.spawn('agent', 'two', 'p', owner),
  ]), async () => { saved.push(state.delegated!.tokens); });
  expect(new Set(ids).size).toBe(2);
  expect(saved).toHaveLength(2);
  expect(saved[1]).toBeGreaterThan(saved[0]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(registry.listRuns().every(run => run.status === 'running')).toBe(true);
  expect(registry.listRuns()).toHaveLength(2);
  execution.resolve(completed);
  await vi.advanceTimersByTimeAsync(0);
  await expect(manager.spawn('agent', 'next', 'p', owner)).resolves.toBeTypeOf('string');
});

it.each(['persistence failure', 'cancel before persistence', 'cancel during persistence'])('releases admission after %s without unsafe budget refunds', async scenario => {
  vi.stubEnv('AGENT_MAX_CONCURRENT_RUNS', '1');
  const { manager, registry } = setup();
  const controller = new AbortController();
  const persist = deferred();
  const state = new RecoveryPolicy().state;
  const save = vi.fn(() => persist.promise);
  if (scenario === 'cancel before persistence') controller.abort(new Error('cancelled'));
  const spawn = withBudgetContext(parent(controller.signal), state, () => manager.spawn('agent', 'one', 'p', owner), save);
  const assertion = expect(spawn).rejects.toThrow();
  if (scenario === 'persistence failure') persist.reject(new Error('save failed'));
  else { controller.abort(new Error('cancelled')); persist.resolve(); }
  await assertion;
  expect(registry.listRuns()).toHaveLength(0);
  // Unknown durability stays charged conservatively, while concurrency is freed.
  if (scenario !== 'cancel before persistence') expect(state.delegated!.tokens).toBeGreaterThan(0);
  else expect(save).not.toHaveBeenCalled();
  await expect(manager.spawn('agent', 'next', 'p', owner)).resolves.toBeTypeOf('string');
});

it('redacts thrown errors once in registry, access tool and console (#308)', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { manager, registry } = setup(async () => { throw new Error('password=fictional-pass; api_key=fictional-key'); });
  const update = vi.spyOn(registry, 'updateRunStatus');
  const id = await manager.spawn('agent', 'fail', 'p', owner);
  await vi.waitFor(async () => expect((await manager.access(id, owner)).status).toBe('failed'));
  const response = await createSubagentAccessTool().handler({ runId: id }, { actor: owner });
  const serialized = JSON.stringify([registry.getRun(id), response, log.mock.calls]);
  expect(serialized).not.toContain('fictional-pass');
  expect(serialized).not.toContain('fictional-key');
  expect(serialized).toContain('[REDACTED]');
  expect(update.mock.calls.filter(call => call[1] === 'failed')).toHaveLength(1);
  expect(response).toMatchObject({ success: false, errorCode: 'SUBAGENT_RUN_FAILED', data: { runId: id, status: 'failed' } });
});

it('bounds settled history and expires owners, runs and shared sessions together (#478)', async () => {
  vi.useFakeTimers();
  const { manager, registry } = setup();
  const ids: string[] = [];
  for (let i = 0; i < 1000; i++) ids.push(await manager.spawn('agent', 'task', 'p', owner));
  expect(registry.listRuns()).toHaveLength(3);
  expect(registry.listSessions()).toHaveLength(3);
  expect(await manager.access(ids[0], owner)).toEqual(await manager.access('missing', owner));
  expect((await manager.access(ids.at(-1)!, owner)).found).toBe(true);
  expect((await manager.access(ids.at(-1)!, other)).found).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await manager.access(ids.at(-1)!, owner)).found).toBe(false);
  expect(registry.listSessions()).toHaveLength(0);
  // Multiple runs in one session: removing old history preserves the active run.
  const active = registry.register({ sessionKey: 'shared', task: 'active' });
  const old = registry.register({ sessionKey: 'shared', task: 'old' });
  registry.updateRunStatus(old.runId, 'completed');
  await vi.advanceTimersByTimeAsync(1000);
  expect(registry.getSession('shared')!.runs.map(run => run.runId)).toEqual([active.runId]);
});

it('pins terminal runs and admission while an observed operation has unknown settlement (#478)', async () => {
  vi.stubEnv('AGENT_MAX_CONCURRENT_RUNS', '1');
  vi.useFakeTimers();
  const operation = deferred();
  const providerRequest = deferred<never>();
  const { manager, registry } = setup(async spec => {
    spec.onToolExecution!(operation.promise);
    spec.onProviderRequest!(providerRequest.promise);
    return { stopReason: 'cancelled', resolution: { kind: 'cancelled', reasonCode: 'USER_CANCELLED', safePartialContent: 'partial' } };
  });
  const id = await manager.spawn('agent', 'task', 'p', owner);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await manager.access(id, owner)).toMatchObject({ found: true, status: 'cancelled', cancellationPending: true });
  await expect(manager.spawn('agent', 'denied', 'p', owner)).rejects.toThrow('SUBAGENT_CONCURRENCY_LIMIT');
  expect(registry.listRuns()).toHaveLength(1);
  operation.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await expect(manager.spawn('agent', 'still denied', 'p', owner)).rejects.toThrow('SUBAGENT_CONCURRENCY_LIMIT');
  providerRequest.reject(new Error('late provider failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(await manager.access(id, owner)).not.toHaveProperty('cancellationPending');
  await manager.spawn('agent', 'next', 'p', owner);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await manager.access(id, owner)).found).toBe(false);
});

it.each(['running', 'completed', 'failed', 'cancelled', 'timed_out'] as const)('keeps authorized %s state at tool entry and conceals foreign runs (#479)', async status => {
  const run = deferred<any>();
  const { manager } = setup(() => run.promise);
  const id = await manager.spawn('agent', 'task', 'p', owner);
  if (status !== 'running') {
    run.resolve(status === 'completed' ? completed : { stopReason: status, resolution: { kind: status === 'failed' ? 'failed' : status, reasonCode: status.toUpperCase(), safePartialContent: 'partial' } });
    await vi.waitFor(async () => expect((await manager.access(id, owner)).status).not.toBe('running'));
  }
  const tool = createSubagentAccessTool();
  const response = await tool.handler({ runId: id }, { actor: owner });
  expect(response).toMatchObject({ success: status === 'running' || status === 'completed', data: { runId: id, status: status === 'timed_out' ? 'failed' : status } });
  if (!['running', 'completed'].includes(status)) expect(response).toMatchObject({ errorCode: 'SUBAGENT_RUN_FAILED', data: { result: 'partial', resolution: { kind: status } } });
  const foreign = await tool.handler({ runId: id }, { actor: other });
  expect(foreign).toEqual(await tool.handler({ runId: 'missing' }, { actor: owner }));
  expect(foreign).toMatchObject({ errorCode: 'SUBAGENT_NOT_FOUND' });
  run.resolve(completed);
});

// Actual parent AgentRunner -> ToolRegistry -> production spawn/access handlers
// -> child AgentRunner. Controlled provider, no external model/database.
it('runs the complete parent/child lifecycle through actual runners and tools', async () => {
  const registry = new SubagentRegistry();
  let childCalls = 0;
  const answer = { content: 'child answer', toolCalls: [], hasToolCalls: false, shouldExecuteTools: false, usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
  const provider: LLMProvider = {
    getDefaultModel: () => 'controlled',
    chat: async () => { childCalls++; return answer; },
    chatStream: async () => { throw new Error('streaming not expected'); },
  };
  const manager = new SubagentManager(new AgentRunner(provider), undefined, undefined, registry);
  setSubagentManager(manager);
  const tools = new ToolRegistry();
  let id: string;
  for (const tool of [createSpawnSubagentTool(), createSubagentAccessTool()]) {
    tools.register({ name: tool.name, description: tool.description, parameters: tool.parameters,
      readOnly: false, concurrencySafe: true, exclusive: false,
      execute: async args => {
        const result = await tool.handler(args, { actor: owner });
        if (tool.name === 'spawn_subagent') {
          expect(result.success).toBe(true);
          id = (result.data as { runId: string }).runId;
          await vi.waitFor(async () => expect((await manager.access(id, owner)).status).toBe('completed'));
        } else expect(result).toMatchObject({ success: true, data: { runId: id, status: 'completed', result: 'child answer', resolution: { kind: 'response_ready' } } });
        return result;
      },
    });
  }
  let step = 0;
  const parentProvider: LLMProvider = { ...provider, chat: async () => {
    step++;
    if (step === 3) return { ...answer, content: 'parent answer' };
    return { ...answer, content: null, hasToolCalls: true, shouldExecuteTools: true, finishReason: 'tool_calls',
      toolCalls: [{ id: `call-${step}`, name: step === 1 ? 'spawn_subagent' : 'access_subagent', arguments: step === 1 ? { task: 'inspect', agentId: 'agent' } : { runId: id } }] };
  } };
  const result = await new AgentRunner(parentProvider).run({
    initialMessages: [{ role: 'user', content: 'delegate inspection' }], tools,
    model: 'controlled', maxIterations: 100, maxTokens: 100, maxToolResultChars: 1000,
    contextWindowTokens: 200_000, hook: new NoopHook(), budgetLimits: budget,
  });
  expect(result.stopReason).toBe('completed');
  expect(result.finalContent).toBe('parent answer');
  expect(childCalls).toBe(1);
  expect(result.runtimeState!.delegated!.tokens).toBeGreaterThan(0);
});
