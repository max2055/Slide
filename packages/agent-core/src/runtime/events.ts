import { randomUUID } from 'node:crypto';
import type { AgentRunSpec } from '../types.js';
import type { RecoverySnapshot } from './recovery-policy.js';

export interface RuntimeEvent {
  schemaVersion: 1;
  runId: string;
  turnId: string;
  sequence: number;
  type: 'model.start' | 'tools.start' | 'tool.start' | 'tool.returned' | 'candidate.reject' | 'candidate.observe_repetition' | 'recovery.start' | 'compact.saved' | 'response.ready' | 'turn.terminal';
  toolIndex?: number;
  modelStep: number;
  providerAttempts: number;
  toolCalls: number;
  recoveryCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  unknownRequests: number;
  reservedTokens: number;
}

/** Body-free whitelist, bounded by the run's existing step/recovery budgets. */
export function runtimeEvents(spec: AgentRunSpec, state: RecoverySnapshot) {
  const runId = /^[a-f0-9-]{36}$/i.test(spec.runtimeRunId ?? '') ? spec.runtimeRunId! : randomUUID();
  const turnId = randomUUID();
  let sequence = 0;
  return (type: RuntimeEvent['type'], toolIndex?: number) => {
    if (!spec.onRuntimeEvent) return;
    const event: RuntimeEvent = { schemaVersion: 1, runId, turnId, sequence: ++sequence, type, ...(toolIndex === undefined ? {} : { toolIndex }),
      modelStep: state.modelSteps, providerAttempts: state.providerAttempts, toolCalls: state.toolCalls,
      recoveryCount: state.total, inputTokens: state.usage.prompt_tokens ?? 0,
      cachedInputTokens: state.usage.cached_tokens ?? 0, outputTokens: state.usage.completion_tokens ?? 0,
      unknownRequests: state.unknownRequests, reservedTokens: state.reservedTokens };
    // Observability must neither reject a valid run nor create unhandled rejections.
    try { Promise.resolve(spec.onRuntimeEvent(event)).catch(() => {}); } catch { /* observer isolated */ }
  };
}
