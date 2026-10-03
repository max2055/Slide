import { analysisHash } from './analysis-dispatch-store.js';
import type { JobRegistry } from '../workflows/job-registry.js';
import type { WorkflowJobInput } from '../workflows/worker-runtime.js';

export function createAnalysisRecoveryJob(availableAt = new Date()): WorkflowJobInput {
  const slot = Math.floor(availableAt.getTime() / 10_000);
  const hash = analysisHash(['analysis.recover', slot]);
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  return { id, type: 'analysis.recover', schemaVersion: 1, payload: {}, idempotencyKey: `analysis.recover:${slot}`, availableAt };
}

export function registerAnalysisRecoveryHandler(registry: JobRegistry, store: { recover(): Promise<void> }, enqueue: (job: WorkflowJobInput) => Promise<void>): void {
  registry.register('analysis.recover', async (_payload, _job, { signal }) => {
    signal.throwIfAborted();
    await enqueue(createAnalysisRecoveryJob(new Date(Date.now() + 10_000)));
    signal.throwIfAborted();
    await store.recover();
  });
}
