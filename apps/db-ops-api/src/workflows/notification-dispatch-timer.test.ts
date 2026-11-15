import { afterEach, expect, it, vi } from 'vitest';
import { WorkerStartup } from '../lifecycle/worker-startup.js';
import { NotificationDispatchReconciler } from './notification-dispatch.js';
import { BoundedWorkflowRuntime } from './bounded-worker.js';
import type { WorkflowStore } from './worker-runtime.js';
import { mountWorkflowTimer } from './notification-dispatch-timer-fixture.js';
import { deferred } from './delivery-test-recipients.js';

const lease = () => ({ acquire: async () => true, renew: async () => true, release: async () => {} });
const pending = (startup: WorkerStartup) => (startup as unknown as { pending: Set<unknown> }).pending.size;
afterEach(() => vi.useRealTimers());

it('R1: actual server timer runs other lanes for 90 seconds with only one unresolved repair and drains it on cancellation', async () => {
  vi.useFakeTimers();
  const held = deferred<void>();
  const enqueue = vi.fn(() => held.promise);
  const repair = new NotificationDispatchReconciler({ enqueue });
  const startup = new WorkerStartup(lease(), async () => {});
  const runtime = { runOnce: vi.fn(async () => 'idle' as const) };
  const registry = { execute: vi.fn() };
  await startup.start(async () => {}, async () => {});
  const timer = mountWorkflowTimer(startup, repair, runtime, registry);
  try {
    await vi.advanceTimersByTimeAsync(90_000);
    const observed = { SQLWrites: enqueue.mock.calls.length, pending: pending(startup), runs: runtime.runOnce.mock.calls.length };
    console.info('R1_STALLED_REPAIR', observed);
    expect(observed).toEqual({ SQLWrites: 1, pending: 1, runs: 90 });
    expect(timer.ready()).toBe(true);
    await startup.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(runtime.runOnce).toHaveBeenCalledTimes(90);
    let drained = false;
    const draining = startup.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    expect(pending(startup)).toBe(1); // Abort releases the waiter, not the pending SQL.
    held.resolve(); await draining;
    expect(pending(startup)).toBe(0);
  } finally {
    timer.close(); held.resolve(); await startup.drain();
  }
});

it('R1: actual timer keeps polling independent lanes while one runtime lane is pending', async () => {
  vi.useFakeTimers();
  const held = deferred<void>();
  let generalClaims = 0, deliveries = 0, runtimeWaiters = 0, maxRuntimeWaiters = 0;
  const store: WorkflowStore = {
    claim: vi.fn(async (_id, _seconds, filter) => {
      const type = filter?.exclude ? 'capacity.collect' : filter?.types.includes('report.notify') ? 'report.notify' : null;
      if (!type) return null;
      if (type === 'capacity.collect' && ++generalClaims > 1) return null;
      return { id: `${type}-${deliveries}`, type, payload: {}, attempts: 1, maxAttempts: 5, fencingToken: 1 };
    }),
    heartbeat: async () => true, complete: async () => true, fail: async () => true,
  };
  const runtime = new BoundedWorkflowRuntime(store, 'timer-test', 3, async job => [job.type]);
  const run = runtime.runOnce.bind(runtime);
  vi.spyOn(runtime, 'runOnce').mockImplementation(async handler => {
    maxRuntimeWaiters = Math.max(maxRuntimeWaiters, ++runtimeWaiters);
    try { return await run(handler); } finally { runtimeWaiters--; }
  });
  const registry = { execute: vi.fn(async (job: { type: string }) => {
    if (job.type === 'capacity.collect') await held.promise;
    else deliveries++;
  }) };
  const startup = new WorkerStartup(lease(), async () => { await runtime.shutdown(); });
  await startup.start(async () => {}, async () => {});
  const timer = mountWorkflowTimer(startup, new NotificationDispatchReconciler({ enqueue: async () => {} }), runtime, registry);
  try {
    await vi.advanceTimersByTimeAsync(90_000);
    expect(generalClaims).toBe(1);
    expect(deliveries).toBe(90);
    expect(runtimeWaiters).toBe(1);
    expect(maxRuntimeWaiters).toBeLessThanOrEqual(2);
    expect(pending(startup)).toBe(0);
  } finally {
    timer.close(); held.resolve(); await startup.drain();
  }
});

it('R1: actual timer reports repair errors and resumes after settlement without replacing pending SQL', async () => {
  vi.useFakeTimers();
  const held = deferred<void>();
  const startup = new WorkerStartup(lease(), async () => {});
  const enqueue = vi.fn().mockRejectedValueOnce(new Error('STORE_OFFLINE')).mockImplementationOnce(() => held.promise).mockResolvedValue(undefined);
  const error = vi.fn();
  const runtime = { runOnce: vi.fn(async () => 'idle' as const) };
  await startup.start(async () => {}, async () => {});
  const timer = mountWorkflowTimer(startup, new NotificationDispatchReconciler({ enqueue }), runtime, { execute: vi.fn() }, { error });
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(error).toHaveBeenCalledWith('[NotificationDispatch] RECONCILIATION_FAILED');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(runtime.runOnce).toHaveBeenCalledTimes(92);
    held.resolve(); await vi.advanceTimersByTimeAsync(1_000);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(pending(startup)).toBe(0);
  } finally { timer.close(); held.resolve(); await startup.drain(); }
});
