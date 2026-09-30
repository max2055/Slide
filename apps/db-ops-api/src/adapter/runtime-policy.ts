import type { AgentRunSpec, RuntimeBudgetLimits } from '@slide/agent-core';
import { loadAgentRuntimeLimits } from '../security/agent-runtime-limits.js';

export type RuntimeEntry = 'chat' | 'invoke' | 'subagent' | 'cron';
export interface RuntimePolicy {
  entry: RuntimeEntry;
  source: string;
  longChat: boolean;
  supervisorMode?: 'observe' | 'enforce';
  runTimeoutMs?: number;
  maxIterations: number;
  toolTimeoutMs?: number;
  llmTimeoutS?: number;
  streamIdleTimeoutS?: number;
  budgetLimits?: RuntimeBudgetLimits;
}
function positive(env: NodeJS.ProcessEnv, name: string): number | undefined {
  if (env[name] === undefined) return undefined;
  const value = Number(env[name]);
  if (!/^\d+$/.test(env[name]!) || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`Invalid runtime configuration: ${name} must be a positive integer`);
  return value;
}
export function resolveRuntimePolicy(entry: RuntimeEntry, options: { env?: NodeJS.ProcessEnv; cronTimeoutSeconds?: number; maxIterations?: number; parentRemaining?: RuntimePolicy } = {}): Readonly<RuntimePolicy> {
  const env = options.env ?? process.env;
  const legacy = loadAgentRuntimeLimits(env);
  const supervisorMode = env.AGENT_RUNTIME_SUPERVISOR_MODE ?? 'enforce';
  if (supervisorMode !== 'observe' && supervisorMode !== 'enforce') throw new Error('Invalid runtime configuration: AGENT_RUNTIME_SUPERVISOR_MODE');
  const enabled = env.AGENT_RUNTIME_LONG_CHAT === 'true';
  if (env.AGENT_RUNTIME_LONG_CHAT !== undefined && !['true', 'false'].includes(env.AGENT_RUNTIME_LONG_CHAT)) throw new Error('Invalid runtime configuration: AGENT_RUNTIME_LONG_CHAT must be true or false');
  // Chat has no implicit whole-run deadline. Both timeout variables are still
  // accepted as explicit operator limits, independently of rollout mode.
  const oldTimeout = entry === 'chat' || enabled ? positive(env, 'AGENT_RUN_TIMEOUT_MS') : undefined;
  const chatTimeout = entry === 'chat' ? positive(env, 'AGENT_CHAT_RUN_TIMEOUT_MS') : undefined;
  const steps = enabled ? positive(env, 'AGENT_MAX_ITERATIONS') : undefined;
  // maxIterations remains the compatibility name, but for long chat it is an
  // emergency runaway fuse above the ordinary resource budgets.
  const defaults = { chat: enabled ? 1000 : legacy.maxIterations, invoke: 8, subagent: 25, cron: 40 };
  let timeout = entry === 'chat' ? chatTimeout ?? oldTimeout : enabled ? oldTimeout ?? 120_000 : legacy.runTimeoutMs;
  if (entry === 'subagent') timeout = Math.min(timeout ?? 120_000, 120_000);
  if (entry === 'cron') {
    const seconds = options.cronTimeoutSeconds ?? 300;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid cron timeout');
    // job.timeout_seconds remains the authoritative Cron deadline, as before.
    timeout = seconds * 1000;
  } else if (entry !== 'chat' && enabled && oldTimeout !== undefined) timeout = Math.min(timeout ?? oldTimeout, oldTimeout);
  const policy: RuntimePolicy = { entry, source: entry === 'cron' ? 'job.timeout_seconds' : entry === 'chat' && chatTimeout !== undefined ? 'AGENT_CHAT_RUN_TIMEOUT_MS' : oldTimeout !== undefined ? 'AGENT_RUN_TIMEOUT_MS' : entry === 'chat' ? 'chat-default' : 'legacy-default',
    supervisorMode, longChat: enabled && entry === 'chat', runTimeoutMs: timeout,
    maxIterations: Math.min(defaults[entry], steps ?? (entry === 'chat' ? defaults.chat : legacy.maxIterations), options.maxIterations ?? Infinity),
    llmTimeoutS: entry === 'invoke' ? 60 : entry === 'cron' ? options.cronTimeoutSeconds ?? 300 : undefined,
  };
  if (enabled) {
    if (entry === 'chat') policy.maxIterations = Math.min(steps ?? 1000, options.maxIterations ?? Infinity);
    policy.llmTimeoutS ??= 300;
    policy.streamIdleTimeoutS = 60;
    policy.toolTimeoutMs = 60_000;
    policy.budgetLimits = Object.freeze({ maxToolCalls: 500, maxProviderAttempts: 600, maxTotalTokens: 1_000_000, maxNoProgressSteps: 12 });
  }
  const parent = options.parentRemaining;
  if (parent) {
    policy.maxIterations = Math.min(policy.maxIterations, parent.maxIterations);
    if (parent.runTimeoutMs !== undefined) policy.runTimeoutMs = Math.min(policy.runTimeoutMs ?? Infinity, parent.runTimeoutMs);
    if (parent.budgetLimits) {
      const own = policy.budgetLimits ?? parent.budgetLimits;
      policy.budgetLimits = Object.freeze(Object.fromEntries(Object.entries(parent.budgetLimits).map(([k, v]) => [k, Math.min(v, own[k as keyof RuntimeBudgetLimits])])) as unknown as RuntimeBudgetLimits);
    }
  }
  if (!Number.isSafeInteger(policy.maxIterations) || policy.maxIterations < 1 || (policy.runTimeoutMs !== undefined && policy.runTimeoutMs <= 0) || (policy.budgetLimits && Object.values(policy.budgetLimits).some(n => !Number.isSafeInteger(n) || n <= 0))) throw new Error('Runtime parent allowance exhausted or invalid');
  return Object.freeze(policy);
}
export function runtimeSpec(policy: RuntimePolicy): Pick<AgentRunSpec, 'maxIterations' | 'runTimeoutMs' | 'llmTimeoutS' | 'streamIdleTimeoutS' | 'toolTimeoutMs' | 'budgetLimits' | 'supervisorMode'> {
  return { supervisorMode: policy.supervisorMode, maxIterations: policy.maxIterations, runTimeoutMs: policy.runTimeoutMs, llmTimeoutS: policy.llmTimeoutS,
    streamIdleTimeoutS: policy.streamIdleTimeoutS, toolTimeoutMs: policy.toolTimeoutMs, budgetLimits: policy.budgetLimits };
}
