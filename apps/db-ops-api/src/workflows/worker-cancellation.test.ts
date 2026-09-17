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

it('quarantines an uncooperative handler, drains shutdown boundedly, and ignores late renewal', async () => {
  vi.useFakeTimers();
  let renew!: (value: boolean) => void;
  const { worker, store } = setup(() => new Promise(resolve => { renew = resolve; }));
  let finish!: () => void;
  let signal!: AbortSignal;
  const run = worker.runOnce(async (_job, context) => {
    signal = context.signal;
    await new Promise<void>(resolve => { finish = resolve; });
  });
  await vi.advanceTimersByTimeAsync(1000);
  const closing = worker.shutdown(25);
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(25);
  expect(await closing).toBe(false);
  expect(await worker.runOnce(async () => {})).toBe('cancelled');
  renew(true);
  finish();
  expect(await run).toBe('cancelled');
  expect(await worker.shutdown()).toBe(true);
  expect(store.complete).not.toHaveBeenCalled();
  expect(store.fail).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not invoke a handler if shutdown wins a pending claim', async () => {
  const { worker, store } = setup(async () => true);
  let claim!: (value: typeof job) => void;
  store.claim.mockImplementation(() => new Promise(resolve => { claim = resolve; }));
  const handler = vi.fn();
  const run = worker.runOnce(handler);
  const closing = worker.shutdown();
  claim(job);
  expect(await run).toBe('cancelled');
  expect(await closing).toBe(true);
  expect(handler).not.toHaveBeenCalled();
});

it('does not accumulate uncancellable renewal requests after a heartbeat timeout', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let renew!: (value: boolean) => void;
  const { worker, store } = setup(() => new Promise(resolve => { renew = resolve; }));
  const run = worker.runOnce(async (_job, { signal }) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  await vi.advanceTimersByTimeAsync(1500);
  expect(await run).toBe('retry');
  for (let i = 0; i < 10; i++) expect(await worker.runOnce(async () => {})).toBe('running');
  expect(store.claim).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  renew(true);
  await vi.advanceTimersByTimeAsync(0);
  store.claim.mockResolvedValue(null as any);
  expect(await worker.runOnce(async () => {})).toBe('idle');
});
