import { expect, it, vi } from 'vitest';
import { WorkerRuntime } from './worker-runtime.js';
import { platformLogs } from '../platform/structured-log-evidence-adapter.js';
it('records queue lifecycle outcomes without job payloads or error text', async () => {
  const record = vi.spyOn(platformLogs, 'record');
  const job = { id: 'job-test', type: 'notification.deliver', payload: { secret: 'must-not-appear' }, attempts: 1, maxAttempts: 1, fencingToken: 1 };
  const store = { claim: vi.fn(async () => job), complete: vi.fn(async () => true), fail: vi.fn(async () => true), heartbeat: vi.fn(async () => true) };
  const worker = new WorkerRuntime(store, 'worker');
  expect(await worker.runOnce(async () => { throw new Error('must-not-appear'); })).toBe('dead_letter');
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ component: 'queue', eventType: 'job.claimed', correlationId: job.id }));
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ component: 'queue', eventType: 'job.dead_letter', status: 'failed' }));
  expect(JSON.stringify(record.mock.calls)).not.toContain('must-not-appear');
  record.mockRestore();
});
