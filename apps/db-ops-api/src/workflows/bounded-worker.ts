import { randomUUID } from 'node:crypto';
import { platformLogs } from '../platform/structured-log-evidence-adapter.js';
import { WorkerRuntime, type ClaimedJob, type ClaimFilter, type JobExecutionContext, type WorkflowStore } from './worker-runtime.js';

const notificationTypes = ['notification.deliver', 'report.notify'];
const collectionTypes = ['metrics.collect'];
export function workflowConcurrency(env: NodeJS.ProcessEnv = process.env): 1 | 3 {
  const value = env.WORKFLOW_CONCURRENCY ?? '3';
  if (value !== '1' && value !== '3') throw new Error('WORKFLOW_CONCURRENCY_INVALID');
  return Number(value) as 1 | 3;
}

/** D1-owned fixed slots: one potential model operation, one delivery, one collector.
 * Each WorkerRuntime retains runInFlight and pending-query quarantine. No replacement
 * workers are spawned when a handler ignores cancellation. Resources are shared
 * across all lanes; FIFO admission prevents a global waiter from being starved.
 */
export class BoundedWorkflowRuntime {
  private readonly workers: WorkerRuntime[];
  private readonly active = new Set<string[]>();
  private readonly waiting: Array<{ keys: string[]; signal: AbortSignal; enter: () => void }> = [];
  constructor(store: WorkflowStore, workerId: string, concurrency: number,
    private readonly resourcesFor: (job: ClaimedJob) => Promise<string[]>, leaseSeconds = 30) {
    if (concurrency !== 1 && concurrency !== 3) throw new Error('WORKFLOW_CONCURRENCY_INVALID');
    const lanes: Array<{ name: string; filter?: ClaimFilter }> = concurrency === 1 ? [{ name: 'serial' }] : [
      { name: 'general', filter: { types: [...notificationTypes, ...collectionTypes], exclude: true } },
      { name: 'notification', filter: { types: notificationTypes, exclude: false } },
      { name: 'collection', filter: { types: collectionTypes, exclude: false } },
    ];
    this.workers = lanes.map(lane => new WorkerRuntime({
      claim: (id, lease) => store.claim(id, lease, lane.filter),
      heartbeat: (...args) => store.heartbeat(...args),
      complete: (...args) => store.complete(...args),
      fail: (...args) => store.fail(...args),
    }, lane.name === 'general' || lane.name === 'serial' ? workerId : randomUUID(), leaseSeconds));
  }
  async runOnce(handler: (job: ClaimedJob, context: JobExecutionContext) => Promise<void>) {
    const results = await Promise.all(this.workers.map(worker => worker.runOnce(async (job, context) => {
      const start = performance.now();
      const resources = await this.resourcesFor(job);
      const release = await this.acquire([`job:${job.id}`, ...(resources.length ? resources : ['*'])], context.signal);
      try {
        context.signal.throwIfAborted();
        platformLogs.record({ component: 'queue', eventType: 'job.resource_wait', status: 'ok',
          correlationId: job.id, jobType: job.type, durationMs: performance.now() - start });
        await handler(job, context);
      } finally { release(); }
    })));
    return results.find(result => result !== 'running' && result !== 'cancelled') ?? results[0];
  }
  async shutdown(timeoutMs = 5000): Promise<boolean> {
    const results = await Promise.all(this.workers.map(worker => worker.shutdown(timeoutMs)));
    return results.every(Boolean);
  }
  private pump() {
    while (this.waiting.length) {
      const next = this.waiting[0];
      if ([...this.active].some(keys => keys.includes('*') || next.keys.includes('*') || keys.some(k => next.keys.includes(k)))) return;
      this.waiting.shift();
      this.active.add(next.keys);
      next.enter();
    }
  }
  private acquire(keys: string[], signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
        this.pump();
      };
      const entry = { keys, signal, enter: () => {
        signal.removeEventListener('abort', onAbort);
        resolve(() => { this.active.delete(keys); this.pump(); });
      } };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
      this.pump();
    });
  }
}
