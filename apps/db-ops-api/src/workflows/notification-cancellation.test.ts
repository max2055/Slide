import { afterEach, expect, it, vi } from 'vitest';
import { NotificationService } from '../notification-service.js';
import { WorkerRuntime } from './worker-runtime.js';
import { JobRegistry } from './job-registry.js';

const channel = { id: 1, name: 'cancel', type: 'webhook' as const, enabled: true, config: {}, created_at: new Date(), updated_at: new Date() };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('cancels the real notification retry loop when the worker loses its lease', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const service = new NotificationService();
  const send = vi.spyOn(service, 'send').mockResolvedValue({ success: false, error: 'offline' });
  const registry = new JobRegistry();
  registry.register('notification.deliver', async (_payload, _job, context) => {
    await service.sendWithRetry(channel, {}, 1, context.signal);
  });
  const complete = vi.fn();
  const fail = vi.fn();
  const worker = new WorkerRuntime({
    claim: async () => ({ id: 'n1', type: 'notification.deliver', payload: {}, attempts: 1, maxAttempts: 3, fencingToken: 1 }),
    heartbeat: async () => false, complete, fail,
  }, 'a', 3);
  const run = worker.runOnce((job, context) => registry.execute(job, context));
  await vi.advanceTimersByTimeAsync(30000);
  expect(await run).toBe('retry');
  expect(send).toHaveBeenCalledTimes(1);
  expect(complete).not.toHaveBeenCalled();
  expect(fail).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
