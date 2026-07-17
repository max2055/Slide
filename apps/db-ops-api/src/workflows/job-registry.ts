import type { ClaimedJob } from './worker-runtime.js';

export type TypedJobHandler = (payload: Record<string, unknown>, job: ClaimedJob) => Promise<void>;

export class JobRegistry {
  private readonly handlers = new Map<string, TypedJobHandler>();
  register(key: string, handler: TypedJobHandler): void {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(key)) throw new Error('WORKFLOW_HANDLER_INVALID');
    if (this.handlers.has(key)) throw new Error('WORKFLOW_HANDLER_DUPLICATE');
    this.handlers.set(key, handler);
  }
  has(key: string): boolean { return this.handlers.has(key); }
  async execute(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) throw new Error(`WORKFLOW_HANDLER_UNSUPPORTED:${job.type}`);
    await handler(job.payload, job);
  }
}
