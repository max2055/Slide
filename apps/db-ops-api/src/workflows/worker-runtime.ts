export type WorkflowState = 'queued' | 'running' | 'retry' | 'completed' | 'dead_letter' | 'cancelled';
export interface ClaimedJob { id: string; type: string; payload: Record<string, unknown>; attempts: number; maxAttempts: number; fencingToken: number; }
export interface WorkflowStore {
  claim(workerId: string, leaseSeconds: number): Promise<ClaimedJob | null>;
  heartbeat(jobId: string, workerId: string, fencingToken: number, leaseSeconds: number): Promise<boolean>;
  complete(jobId: string, workerId: string, fencingToken: number): Promise<boolean>;
  fail(job: ClaimedJob, workerId: string, error: Error, retryAt: Date | null): Promise<boolean>;
}
export class WorkerRuntime {
  constructor(private readonly store: WorkflowStore, readonly workerId: string, private readonly leaseSeconds = 30) {}
  async claim(): Promise<ClaimedJob | null> { return this.store.claim(this.workerId, this.leaseSeconds); }
  async heartbeat(job: ClaimedJob): Promise<boolean> { return this.store.heartbeat(job.id, this.workerId, job.fencingToken, this.leaseSeconds); }
  async runOnce(handler: (job: ClaimedJob) => Promise<void>, now = Date.now()): Promise<'idle' | WorkflowState> {
    const job = await this.claim();
    if (!job) return 'idle';
    try { await handler(job); return await this.store.complete(job.id, this.workerId, job.fencingToken) ? 'completed' : 'retry'; }
    catch (error) {
      const retryAt = job.attempts >= job.maxAttempts ? null : new Date(now + Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1)));
      await this.store.fail(job, this.workerId, error instanceof Error ? error : new Error(String(error)), retryAt);
      return retryAt ? 'retry' : 'dead_letter';
    }
  }
}
