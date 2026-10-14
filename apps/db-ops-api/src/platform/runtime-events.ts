import type { RuntimeEvent } from '@slide/agent-core';
import { platformLogs } from './structured-log-evidence-adapter.js';
import { publishSystemFailure } from './system-failure-publisher.js';

/** No provider/model/user/tool text is accepted into platform log labels. */
export function recordRuntimeEvent(event: RuntimeEvent): void {
  if (event.type === 'candidate.reject') publishSystemFailure({ component: 'agent',
    sourceEventId: `${event.runId}:${event.turnId}:${event.sequence}`, occurredAt: new Date().toISOString(),
    correlationId: event.runId, stableErrorCode: 'RUNTIME_CANDIDATE_REJECTED', callsite: 'runtime:candidate.reject', origin: 'investigation_engine',
    releaseId: process.env.SLIDE_RELEASE_ID,
    commitSha: /^[a-f0-9]{40}$/.test(process.env.SLIDE_COMMIT_SHA ?? '') ? process.env.SLIDE_COMMIT_SHA : undefined });
  platformLogs.record({ component: 'agent', eventType: `runtime.${event.type}`,
    // The body-free terminal event has no stop reason; cancellation and failure
    // cannot be distinguished here, and neither is response readiness.
    status: event.type === 'candidate.reject' || event.type === 'turn.terminal' ? 'unknown' : 'ok',
    ...(event.type === 'turn.terminal' ? { errorCode: 'RUNTIME_TERMINAL_OUTCOME_UNKNOWN' } : {}),
    correlationId: event.runId, traceId: `${event.turnId}:${event.modelStep}:${event.sequence}${event.toolIndex === undefined ? '' : `:tool:${event.toolIndex}`}`,
    ...(event.type === 'stream.reset' ? { streamBoundary: { anchorId: event.anchorId, sourceRequestId: event.sourceRequestId, discardedBytes: event.discardedBytes } } : {}),
    runtimeCounters: { modelStep: event.modelStep, providerAttempts: event.providerAttempts, toolCalls: event.toolCalls, recoveryCount: event.recoveryCount,
      inputTokens: event.inputTokens, cachedInputTokens: event.cachedInputTokens, outputTokens: event.outputTokens, unknownRequests: event.unknownRequests, reservedTokens: event.reservedTokens } });
}
