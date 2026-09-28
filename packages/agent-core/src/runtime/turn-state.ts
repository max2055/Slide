import type { AgentRunResult, Message } from '../types.js';
import type { RuntimeStateSnapshot, TurnPhase } from './contracts.js';

/** One run's working data. Serialize only through snapshotTurnState. */
export interface TurnState extends RuntimeStateSnapshot, AgentRunResult {
  externalLookupCounts: Record<string, number>;
  // Legacy consecutive counters still reset after tools; cumulative counters above never do.
  emptyContentRetries: number;
  lengthRecoveryCount: number;
  injectionCycles: number;
}

export function createTurnState(messages: Message[] = []): TurnState {
  return {
    schemaVersion: 1, phase: 'preparing', modelSteps: 0, providerAttempts: 0, toolCalls: 0,
    messages: [...messages], finalContent: null, toolsUsed: [],
    usage: { prompt_tokens: 0, completion_tokens: 0 }, error: null, stopReason: 'completed',
    toolEvents: [], hadInjections: false, externalLookupCounts: {},
    emptyContentRetries: 0, lengthRecoveryCount: 0, injectionCycles: 0,
  };
}

const transitions: Record<TurnPhase, readonly TurnPhase[]> = {
  preparing: ['model_running', 'terminal'],
  model_running: ['tools_running', 'candidate_final', 'terminal'],
  // Legacy injection + iteration exhaustion can retain an earlier finalContent.
  tools_running: ['model_running', 'recovering', 'response_ready', 'terminal'],
  candidate_final: ['model_running', 'recovering', 'response_ready', 'terminal'],
  recovering: ['model_running', 'candidate_final', 'terminal'],
  response_ready: [],
  terminal: [],
};

export function transition(state: TurnState, phase: TurnPhase): TurnState {
  if (!transitions[state.phase].includes(phase)) {
    throw new Error(`Illegal runtime transition: ${state.phase} -> ${phase}`);
  }
  return { ...state, phase };
}

/** Whitelist prevents messages, tool arguments, credentials and live handles leaking. */
export function snapshotTurnState(state: RuntimeStateSnapshot): RuntimeStateSnapshot {
  const { schemaVersion, phase, modelSteps, providerAttempts, toolCalls } = state;
  if (schemaVersion !== 1 || !Object.hasOwn(transitions, phase)
    || ![modelSteps, providerAttempts, toolCalls].every(n => Number.isSafeInteger(n) && n >= 0)
    || providerAttempts < modelSteps) {
    throw new Error('Invalid runtime state snapshot');
  }
  return { schemaVersion, phase, modelSteps, providerAttempts, toolCalls };
}

/** Validate before resuming; an older checkpoint cannot reset accrued counters. */
export function restoreTurnState(snapshot: RuntimeStateSnapshot, current = createTurnState()): TurnState {
  const restored = snapshotTurnState(snapshot);
  for (const key of ['modelSteps', 'providerAttempts', 'toolCalls'] as const) {
    if (restored[key] < current[key]) throw new Error(`Runtime counter decreased: ${key}`);
  }
  return { ...current, ...restored };
}
