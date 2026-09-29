/** Runtime response readiness is not durable business completion. */
export type TurnPhase = 'preparing' | 'model_running' | 'tools_running'
  | 'candidate_final' | 'recovering' | 'response_ready' | 'terminal';

/** Process-local resources never belong in a persisted state snapshot. */
export interface RunControl {
  signal?: AbortSignal;
  observeProviderRequest?: (request: Promise<unknown>) => void;
}

/** T1 persists only structural counters. Message checkpoints retain the legacy API. */
export interface RuntimeStateSnapshot {
  schemaVersion: 1;
  phase: TurnPhase;
  modelSteps: number;
  providerAttempts: number;
  toolCalls: number;
}

/** Versioned cumulative recovery/usage ledger persisted as runtime_state_v1. */
export type { RecoverySnapshot, RecoveryKind, RecoveryLimits } from "./recovery-policy.js";

/** Optional for legacy callers; finite for every opted-in runtime entry. */
export interface RuntimeBudgetLimits {
  maxToolCalls: number;
  maxProviderAttempts: number;
  maxTotalTokens: number;
  maxNoProgressSteps: number;
}
