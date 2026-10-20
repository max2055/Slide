import type { createOperationsComposition } from '../composition.js';
import { WorkerRuntime, type WorkflowStore } from '../../workflows/worker-runtime.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { verifiedActionWorkflowHandler, verificationWorkflowHandler } from './verification-handler.js';

export const ACTION_JOB_TYPES = ['operations.action.execute', 'operations.action.verify'];
/** Keep write jobs outside the general/read-only dispatcher, in every lane. */
export function excludeActionJobs(store: WorkflowStore): WorkflowStore {
  return {
    claim: (owner, lease, filter) => filter?.exclude === false && filter.types.every(type => ACTION_JOB_TYPES.includes(type))
      ? Promise.resolve(null) : store.claim(owner, lease, filter?.exclude === false
      ? { types: filter.types.filter(type => !ACTION_JOB_TYPES.includes(type)), exclude: false }
      : { types: [...new Set([...(filter?.types ?? []), ...ACTION_JOB_TYPES])], exclude: true }),
    heartbeat: (...args) => store.heartbeat(...args),
    complete: (...args) => store.complete(...args),
    fail: (...args) => store.fail(...args),
  };
}
export function createActionWorker(composition: ReturnType<typeof createOperationsComposition>,
  store: WorkflowStore, workerId: string) {
  const registry = new JobRegistry();
  registry.register('operations.action.execute', (_payload, job) =>
    verifiedActionWorkflowHandler(composition.verification, composition.executor, workerId, composition.persistedCaller)(job));
  registry.register('operations.action.verify', (_payload, job) =>
    verificationWorkflowHandler(composition.verification, composition.persistedCaller)(job));
  const worker = new WorkerRuntime({
    claim: (id, lease) => store.claim(id, lease, { types: ACTION_JOB_TYPES, exclude: false }),
    heartbeat: (...args) => store.heartbeat(...args), complete: (...args) => store.complete(...args), fail: (...args) => store.fail(...args),
  }, workerId);
  return {
    async runOnce() {
      await composition.executions.recoverExpiredDispatches();
      return worker.runOnce((job, context) => registry.execute(job, context));
    },
    shutdown: (timeout?: number) => worker.shutdown(timeout),
  };
}
