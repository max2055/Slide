import { afterEach, expect, it, vi } from 'vitest';
import { WorkerRuntime, type WorkflowStore } from './worker-runtime.js';
import { JobRegistry } from './job-registry.js';

const job = { id: 'cancel-job', type: 'test.effect', payload: {}, attempts: 1, maxAttempts: 3, fencingToken: 1 };
function setup(heartbeat: WorkflowStore['heartbeat']) {
  const store = { claim: vi.fn(async () => job), heartbeat, complete: vi.fn(async () => true), fail: vi.fn(async () => true) };
  return { store, worker: new WorkerRuntime(store, 'a', 3) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it.each(['false', 'error', 'timeout'])('propagates %s renewal cancellation through registry before another effect', async (mode) => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { store, worker } = setup(async () => {
    if (mode === 'error') throw new Error('offline');
    if (mode === 'timeout') return new Promise<boolean>(() => {});
    return false;
  });
  const registry = new JobRegistry();
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const effect = vi.fn();
  registry.register(job.type, async (_payload, _job, context) => {
    signal = context?.signal;
    await gate;
    context?.signal.throwIfAborted();
    effect();
  });
  const run = worker.runOnce((claimed, context) => registry.execute(claimed, context));
  await vi.advanceTimersByTimeAsync(1500);
  release();
  await run;
  expect(signal?.aborted).toBe(true);
  expect(effect).not.toHaveBeenCalled();
  expect(store.complete).not.toHaveBeenCalled();
  expect(store.fail).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
