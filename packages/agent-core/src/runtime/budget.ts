import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentRunSpec } from '../types.js';
import type { RecoverySnapshot } from './recovery-policy.js';
import { RuntimeError } from './recovery-policy.js';

export function consumedTokens(state: RecoverySnapshot): number {
  return (state.usage.prompt_tokens ?? 0) + (state.usage.completion_tokens ?? 0) + state.reservedTokens + (state.delegated?.tokens ?? 0);
}
export function assertRequestBudget(spec: AgentRunSpec, state: RecoverySnapshot, reservation: number): void {
  const limits = spec.budgetLimits;
  if (!limits) return;
  if ((state.providerAttempts + (state.delegated?.providerAttempts ?? 0)) >= limits.maxProviderAttempts) throw new RuntimeError('MAX_PROVIDER_ATTEMPTS', 'Provider attempt budget exhausted');
  if (consumedTokens(state) + reservation > limits.maxTotalTokens) throw new RuntimeError('TOKEN_BUDGET', 'Token budget cannot cover the next request');
}
export function assertTokenBudget(spec: AgentRunSpec, state: RecoverySnapshot): void {
  if (spec.budgetLimits && consumedTokens(state) > spec.budgetLimits.maxTotalTokens) throw new RuntimeError('TOKEN_BUDGET', 'Token budget exhausted');
}
export function assertToolBudget(spec: AgentRunSpec, state: RecoverySnapshot, calls: number): void {
  if (spec.budgetLimits && state.toolCalls + (state.delegated?.toolCalls ?? 0) + calls > spec.budgetLimits.maxToolCalls) throw new RuntimeError('MAX_TOOL_CALLS', 'Tool call budget exhausted');
}

const activeBudget = new AsyncLocalStorage<{ spec: AgentRunSpec; state: RecoverySnapshot; persist: () => Promise<void>; dispatchSignal?: AbortSignal }>();
export function withBudgetContext<T>(spec: AgentRunSpec, state: RecoverySnapshot, task: () => T, persist: () => Promise<void>): T {
  return activeBudget.run({ spec, state, persist }, task);
}
/** A tool may time out while awaiting durable child admission. */
export function withBudgetDispatchSignal<T>(signal: AbortSignal, task: () => T): T {
  const current = activeBudget.getStore();
  return current ? activeBudget.run({ ...current, dispatchSignal: signal }, task) : task();
}
/** Non-refundable child allocation prevents concurrent children spending the same parent remainder.
 * It is tracked separately from measured usage and persists through restart. */
export async function reserveChildBudget(request: { maxIterations: number; budgetLimits?: AgentRunSpec['budgetLimits']; runTimeoutMs?: number }) {
  const current = activeBudget.getStore();
  if (!current?.spec.budgetLimits) return undefined;
  const { spec, state } = current;
  spec.signal?.throwIfAborted();
  current.dispatchSignal?.throwIfAborted();
  const limits = spec.budgetLimits!;
  const used = state.delegated ?? { modelSteps: 0, providerAttempts: 0, toolCalls: 0, tokens: 0 };
  const own = request.budgetLimits ?? limits;
  const maxIterations = Math.min(request.maxIterations, spec.maxIterations - state.modelSteps - used.modelSteps);
  const budgetLimits = {
    maxProviderAttempts: Math.min(own.maxProviderAttempts, Math.floor((limits.maxProviderAttempts - state.providerAttempts - used.providerAttempts) / 2)),
    maxToolCalls: Math.min(own.maxToolCalls, Math.floor((limits.maxToolCalls - state.toolCalls - used.toolCalls) / 2)),
    // Keep half the unallocated allowance for the parent/further delegation.
    maxTotalTokens: Math.min(own.maxTotalTokens, Math.floor((limits.maxTotalTokens - consumedTokens(state)) / 2)),
    maxNoProgressSteps: Math.min(own.maxNoProgressSteps, limits.maxNoProgressSteps),
  };
  const remainingMs = state.deadlineAt === undefined ? request.runTimeoutMs : Math.min(request.runTimeoutMs ?? Infinity, state.deadlineAt - Date.now());
  if (maxIterations <= 0 || Object.values(budgetLimits).some(n => n <= 0) || (remainingMs !== undefined && remainingMs <= 0)) throw new RuntimeError('CHILD_BUDGET_EXHAUSTED', 'Parent remaining allowance cannot fund a child');
  state.delegated = { modelSteps: used.modelSteps + maxIterations, providerAttempts: used.providerAttempts + budgetLimits.maxProviderAttempts,
    toolCalls: used.toolCalls + budgetLimits.maxToolCalls, tokens: used.tokens + budgetLimits.maxTotalTokens };
  await current.persist();
  spec.signal?.throwIfAborted();
  current.dispatchSignal?.throwIfAborted();
  return { maxIterations, budgetLimits, runTimeoutMs: remainingMs, signal: spec.signal };
}
