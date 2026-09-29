import type { AgentRunResult, AgentRunSpec, LLMProvider } from '../types.js';
import { RuntimeError, validateRecoverySnapshot } from './recovery-policy.js';
import { TurnLoop } from './turn-loop.js';
import type { ToolExecutor } from './tool-executor.js';

export class AgentRuntime {
  constructor(
    private readonly getProvider: () => LLMProvider,
    private readonly executor: Pick<ToolExecutor, 'runTool'>,
  ) {}

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    if (spec.budgetLimits) {
      for (const value of [spec.maxIterations, spec.contextWindowTokens ?? 200_000, spec.maxTokens ?? 4096, spec.budgetLimits.maxToolCalls, spec.budgetLimits.maxProviderAttempts, spec.budgetLimits.maxTotalTokens, spec.budgetLimits.maxNoProgressSteps]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new RuntimeError('INVALID_POLICY', 'Runtime budgets must be finite positive integers');
      }
    }
    const restored = spec.resumeCheckpoint?.runtime_state_v1;
    const previousDeadline = restored ? validateRecoverySnapshot(restored).deadlineAt : undefined;
    if (spec.runTimeoutMs === undefined && previousDeadline === undefined) return new TurnLoop(this.getProvider, this.executor).run(spec);
    if (spec.runTimeoutMs !== undefined && (!Number.isSafeInteger(spec.runTimeoutMs) || spec.runTimeoutMs <= 0)) throw new RuntimeError('INVALID_POLICY', 'Run timeout must be a positive integer');
    const deadline = Math.min(previousDeadline ?? Infinity, spec.runTimeoutMs === undefined ? Infinity : Date.now() + spec.runTimeoutMs);
    const controller = new AbortController();
    const cancel = () => controller.abort(spec.signal?.reason);
    spec.signal?.addEventListener('abort', cancel, { once: true });
    if (spec.signal?.aborted) cancel();
    const expire = () => controller.abort(new RuntimeError('RUN_DEADLINE', 'Run deadline exceeded'));
    if (deadline <= Date.now()) expire();
    const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
    try {
      return await new TurnLoop(this.getProvider, this.executor).run({ ...spec, signal: controller.signal,
        runTimeoutMs: Math.max(1, deadline - Date.now()),
        resumeCheckpoint: { ...spec.resumeCheckpoint, runtime_deadline_at: deadline } });
    } finally { clearTimeout(timer); spec.signal?.removeEventListener('abort', cancel); }
  }
}
