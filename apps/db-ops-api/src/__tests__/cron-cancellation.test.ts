// Regression adapted from the 2026-09-16 audit Cron overlap probe.
import { afterEach, expect, it, vi } from 'vitest';
import { AgentRunner, ToolRegistry } from '@slide/agent-core';
import type { LLMProvider, ToolExecutionContext } from '@slide/agent-core';
import { CronExecutor } from '../cron/cron-executor.js';
import { CronManager } from '../cron/cron-manager.js';
vi.mock('../db-connection', () => ({ dbConnection: { getPool: () => null } }));
vi.mock('../sql-executor', () => ({ sqlExecutor: {} }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
const done = { content: 'done', finishReason: 'stop', usage: {}, shouldExecuteTools: false, hasToolCalls: false, toolCalls: [] };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function setup(execute?: (_args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string>, chat?: LLMProvider['chat']) {
  const tools = new ToolRegistry();
  if (execute) tools.register({ name: 'probe', description: 'isolated counter', parameters: { type: 'object', properties: {} }, execute });
  const provider = { getDefaultModel: () => 'probe', chat: chat ?? vi.fn(async (messages) => {
    if (!execute || messages.some(m => m.role === 'tool')) return done;
    return { ...done, content: null, finishReason: 'tool_calls', shouldExecuteTools: true, hasToolCalls: true,
      toolCalls: [{ id: 'p', name: 'probe', arguments: {} }, { id: 'p2', name: 'probe', arguments: {} }] };
  }) } as LLMProvider;
  const runner = new AgentRunner(provider);
  const run = vi.spyOn(runner, 'run');
  const executor = new CronExecutor(runner, tools, provider);
  const service = { startLog: vi.fn(async () => 1), completeLog: vi.fn(async () => {}), updateRunResult: vi.fn(async () => {}) };
  const manager = new CronManager(service as any, executor);
  const config = { id: 1, name: 'probe', task_type: 'agent', task_description: 'probe', timeout_seconds: 1 } as any;
  return { executor, service, manager, config, run, provider };
}
it('retains ownership of an uncooperative tool after timeout and resumes only after settlement', async () => {
  vi.useFakeTimers();
  const blocked = gate();
  const contexts: ToolExecutionContext[] = [];
  let effects = 0;
  const { manager, config, run, service } = setup(async (_args, context) => { contexts.push(context!); await blocked.promise; effects++; return 'ok'; });
  const first = manager.executeJob(config);
  await vi.advanceTimersByTimeAsync(1001);
  await first;
  expect(service.updateRunResult).toHaveBeenLastCalledWith(1, 'error');
  const second = manager.executeJob(config);
  await vi.advanceTimersByTimeAsync(1001);
  await second;
  expect(run).toHaveBeenCalledTimes(1);
  expect(contexts).toHaveLength(1);
  expect(contexts[0].signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  blocked.release();
  await run.mock.results[0].value;
  await vi.advanceTimersByTimeAsync(0);
  expect(effects).toBe(1); // In-flight non-cooperative side effect is NOT claimed cancelled.
  expect(contexts).toHaveLength(1); // The second tool must never start.
  await manager.executeJob(config);
  expect(run).toHaveBeenCalledTimes(2);
  expect(service.updateRunResult).toHaveBeenLastCalledWith(1, 'success');
  expect(vi.getTimerCount()).toBe(0);
});
it('aborts cooperative tools without starting the next tool', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const { executor } = setup(async (_args, context) => {
    signals.push(context!.signal!);
    await new Promise<void>((_resolve, reject) => context?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return 'unreachable';
  });
  const pending = executor.execute(1, 'probe', 1);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await pending).toMatchObject({ stopReason: 'timeout', structuredResult: null });
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])('retains a non-cooperative provider until it settles (reject=%s)', async reject => {
  vi.useFakeTimers();
  const blocked = gate();
  let signal: AbortSignal | undefined;
  const chat = vi.fn(async (_m, _t, options) => { signal = options?.signal; await blocked.promise; if (reject) throw new Error('late failure'); return done; });
  const { manager, config, run } = setup(undefined, chat);
  const pending = manager.executeJob(config);
  await vi.advanceTimersByTimeAsync(1001);
  await pending;
  expect(signal?.aborted).toBe(true);
  const second = manager.executeJob(config);
  await vi.advanceTimersByTimeAsync(1001);
  await second;
  expect(run).toHaveBeenCalledTimes(1);
  blocked.release();
  await vi.advanceTimersByTimeAsync(0);
  await manager.executeJob(config);
  expect(run).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['success', 'failure', 'sync-failure'])('clears timers and ownership after %s', async mode => {
  vi.useFakeTimers();
  const { manager, config, run, service } = setup();
  if (mode === 'failure') run.mockRejectedValue(new Error('failure'));
  if (mode === 'sync-failure') run.mockImplementation(() => { throw new Error('failure'); });
  await manager.executeJob(config);
  await manager.executeJob(config);
  expect(run).toHaveBeenCalledTimes(2);
  expect(service.updateRunResult).toHaveBeenLastCalledWith(1, mode === 'success' ? 'success' : 'error');
  expect(vi.getTimerCount()).toBe(0);
});
it('retains ownership even when timeout log persistence fails', async () => {
  vi.useFakeTimers();
  const blocked = gate();
  const { manager, config, run, service } = setup(async () => { await blocked.promise; return 'ok'; });
  service.completeLog.mockRejectedValue(new Error('storage unavailable'));
  const pending = manager.executeJob(config).catch(() => {});
  await vi.advanceTimersByTimeAsync(1001);
  await pending;
  const second = manager.executeJob(config).catch(() => {});
  await vi.advanceTimersByTimeAsync(1001);
  await second;
  expect(run).toHaveBeenCalledTimes(1);
  blocked.release();
  await vi.advanceTimersByTimeAsync(0);
});
