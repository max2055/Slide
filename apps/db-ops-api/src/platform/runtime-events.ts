import type { RuntimeEvent } from '@slide/agent-core';
import { platformLogs } from './structured-log-evidence-adapter.js';

/** No provider/model/user/tool text is accepted into platform log labels. */
export function recordRuntimeEvent(event: RuntimeEvent): void {
  platformLogs.record({ component: 'agent', eventType: `runtime.${event.type}`,
    status: event.type === 'candidate.reject' ? 'unknown' : 'ok',
    correlationId: event.runId, traceId: `${event.turnId}:${event.modelStep}:${event.sequence}${event.toolIndex === undefined ? '' : `:tool:${event.toolIndex}`}`,
    ...(event.type === 'stream.reset' ? { streamBoundary: { anchorId: event.anchorId, sourceRequestId: event.sourceRequestId, discardedBytes: event.discardedBytes } } : {}),
    runtimeCounters: { modelStep: event.modelStep, providerAttempts: event.providerAttempts, toolCalls: event.toolCalls, recoveryCount: event.recoveryCount,
      inputTokens: event.inputTokens, cachedInputTokens: event.cachedInputTokens, outputTokens: event.outputTokens, unknownRequests: event.unknownRequests, reservedTokens: event.reservedTokens } });
}
