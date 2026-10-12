import type { IAgentEngine } from '../adapter/types.js';
import type { TypedJobHandler } from '../workflows/job-registry.js';

/** Workflow owns delivery/lease; the adapter delegates to the single executor.
 * The queue carries IDs only, never a caller-selected actor/Profile/provider. */
export function createInvestigationWorkflowHandler(engine: () => Promise<IAgentEngine>): TypedJobHandler {
  return async (payload, job, context) => {
    if (
      typeof payload.investigationId !== 'string' ||
      typeof payload.requestId !== 'string' ||
      Object.keys(payload).some((key) => !['investigationId', 'requestId'].includes(key))
    )
      throw new Error('INVESTIGATION_JOB_INVALID');
    const adapter = await engine();
    if (!adapter.executeInvestigation) throw new Error('INVESTIGATION_EXECUTOR_UNAVAILABLE');
    return adapter.executeInvestigation({
      investigationId: payload.investigationId,
      requestId: payload.requestId,
      job,
      context,
    });
  };
}
