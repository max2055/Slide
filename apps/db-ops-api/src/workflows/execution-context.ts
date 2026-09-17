import { AsyncLocalStorage } from 'node:async_hooks';
import type { JobExecutionContext } from './worker-runtime.js';

// Each invocation owns its context; concurrent API requests and other workers
// never share a mutable global signal. Nested business services retain it across awaits.
export const workflowExecution = new AsyncLocalStorage<JobExecutionContext>();

export function assertWorkflowActive(): void {
  workflowExecution.getStore()?.signal.throwIfAborted();
}
