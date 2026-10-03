import { afterEach, expect, it, vi } from 'vitest';
import { BoundedWorkflowRuntime, workflowConcurrency } from './bounded-worker.js';
import { MysqlWorkflowStore, type ClaimedJob, type WorkflowStore } from './worker-runtime.js';

const job = (type: string, resource: string): ClaimedJob => ({ id: `${type}:${resource}`, type,
  payload: { resource }, attempts: 1, maxAttempts: 3, fencingToken: 1 });
function fixture(jobs: ClaimedJob[], concurrency = 3, heartbeat = async () => true) {
  const store: WorkflowStore = { claim: vi.fn(async (_owner, _lease, filter) => {
    const i = jobs.findIndex(j => !filter || (filter.exclude ? !filter.types.includes(j.type) : filter.types.includes(j.type)));
    return i < 0 ? null : jobs.splice(i, 1)[0];
  }), heartbeat, complete: vi.fn(async () => true), fail: vi.fn(async () => true) };
  const runtime = new BoundedWorkflowRuntime(store, 'test', concurrency, async j => [String(j.payload.resource)], 3);
  return { store, runtime };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('starts independent notification and collection during a ten-second report, with per-worker exclusion', async () => {
  vi.useFakeTimers();
  const { store, runtime } = fixture([job('report.occurrence', 'a')]);
  const starts: string[] = [];
  const handler = async (j: ClaimedJob) => { starts.push(j.type); if (j.type === 'report.occurrence') await new Promise(r => setTimeout(r, 10000)); };
  const first = runtime.runOnce(handler);
  await vi.advanceTimersByTimeAsync(0);
  // enqueue after the report starts
  const claim = store.claim as ReturnType<typeof vi.fn>;
  const pending = [job('notification.deliver', 'b'), job('metrics.collect', 'c')];
  claim.mockImplementation(async (_owner, _lease, filter) => {
    const i = pending.findIndex(j => !filter || (filter.exclude ? !filter.types.includes(j.type) : filter.types.includes(j.type)));
    return i < 0 ? null : pending.splice(i, 1)[0];
  });
  const tick = runtime.runOnce(handler);
  await vi.advanceTimersByTimeAsync(1000);
  expect(starts).toEqual(['report.occurrence', 'notification.deliver', 'metrics.collect']);
  expect(claim.mock.calls.filter(c => c[0].endsWith(':general'))).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(9000); await Promise.all([first, tick]);
  expect(await runtime.shutdown()).toBe(true);
});

it('retains same-resource guard after lease loss and shutdown until a noncooperative handler settles', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const { runtime, store } = fixture([job('report.occurrence', 'a'), job('notification.deliver', 'a')], 3, async () => false);
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const starts: string[] = [];
  const run = runtime.runOnce(async j => { starts.push(j.type); if (j.type === 'report.occurrence') await gate; });
  await vi.advanceTimersByTimeAsync(1500);
  expect(starts).toEqual(['report.occurrence']);
  const stop = runtime.shutdown(10); await vi.advanceTimersByTimeAsync(10);
  expect(await stop).toBe(false);
  await runtime.runOnce(async () => { throw new Error('must not start'); });
  expect(starts).toHaveLength(1);
  release(); await run;
  expect(store.complete).not.toHaveBeenCalled();
  expect(await runtime.shutdown()).toBe(true);
});

it('falls back to one serial worker and rejects unsafe concurrency values', async () => {
  expect(workflowConcurrency({})).toBe(3);
  expect(workflowConcurrency({ WORKFLOW_CONCURRENCY: '1' })).toBe(1);
  expect(() => workflowConcurrency({ WORKFLOW_CONCURRENCY: '20' })).toThrow('WORKFLOW_CONCURRENCY_INVALID');
  const { runtime } = fixture([job('report.occurrence', 'a'), job('notification.deliver', 'b')], 1);
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const starts: string[] = [];
  const first = runtime.runOnce(async j => { starts.push(j.type); await gate; });
  await vi.waitFor(() => expect(starts).toHaveLength(1));
  await runtime.runOnce(async j => { starts.push(j.type); });
  expect(starts).toHaveLength(1);
  release(); await first; await runtime.runOnce(async j => { starts.push(j.type); });
  expect(starts).toHaveLength(2); await runtime.shutdown();
});

it('filters atomic SQL claims by lane and resolves report/notification resources from authoritative rows', async () => {
  const execute = vi.fn(async () => [{ affectedRows: 0 }] as any);
  const store = new MysqlWorkflowStore(() => ({ execute }));
  await store.claim('lane', 30, { types: ['notification.deliver', 'report.notify'], exclude: false });
  expect(execute.mock.calls[0][0]).toContain('job_type IN (?, ?)');
  expect(execute.mock.calls[0][1]).toContain('notification.deliver');
  execute.mockResolvedValue([[{ instanceId: 9, type: 'health' }]] as any);
  expect(await store.resourcesFor({ ...job('report.occurrence', 'forged'), payload: { configId: 1, instanceId: 99 } })).toEqual(['instance:9']);
  expect(await store.resourcesFor({ ...job('notification.deliver', 'forged'), payload: { alertId: 1, channelId: 2 } })).toEqual(['instance:9']);
  expect(await store.resourcesFor(job('cron.execute', 'forged'))).toEqual(['*']);
});
