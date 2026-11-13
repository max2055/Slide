import type { AgentRunResult, AgentRunSpec, LLMProvider } from '../types.js';
import { RuntimeError, validateRecoverySnapshot } from './recovery-policy.js';
import { TurnLoop } from './turn-loop.js';
import type { ToolExecutor } from './tool-executor.js';
import { resolveContextConfig } from '../model-context.js';
import { summaryOutputAllocation } from './auto-compact.js';
import { MAX_TIMEOUT_MS } from './timeout-policy.js';

export class AgentRuntime {
  constructor(
    private readonly getProvider: () => LLMProvider,
    private readonly executor: Pick<ToolExecutor, 'runTool'>,
  ) {}

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    try {
      const context = resolveContextConfig(spec, this.getProvider());
      spec = { ...spec, maxTokens: context.maxTokens };
    } catch { throw new RuntimeError('INVALID_POLICY', 'Invalid model context configuration'); }
    // A frozen summary allocation the model cannot emit must fail here, before
    // any ordinary or summary request, even when compaction is not due.
    summaryOutputAllocation(spec, this.getProvider());
    if (spec.budgetLimits) {
      for (const value of [spec.maxIterations, spec.maxTokens!, spec.budgetLimits.maxToolCalls, spec.budgetLimits.maxProviderAttempts, spec.budgetLimits.maxTotalTokens, spec.budgetLimits.maxNoProgressSteps]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new RuntimeError('INVALID_POLICY', 'Runtime budgets must be finite positive integers');
      }
    }
    const restored = spec.resumeCheckpoint?.runtime_state_v1;
    const previousDeadline = restored ? validateRecoverySnapshot(restored).deadlineAt : undefined;
    if (spec.runTimeoutMs === undefined && previousDeadline === undefined) return new TurnLoop(this.getProvider, this.executor).run(spec);
    if (spec.runTimeoutMs !== undefined && (!Number.isSafeInteger(spec.runTimeoutMs) || spec.runTimeoutMs <= 0 || spec.runTimeoutMs > MAX_TIMEOUT_MS)) throw new RuntimeError('INVALID_POLICY', `Run timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}ms`);
    const deadline = Math.min(previousDeadline ?? Infinity, spec.runTimeoutMs === undefined ? Infinity : Date.now() + spec.runTimeoutMs);
    const remainingMs = deadline - Date.now();
    if (remainingMs > MAX_TIMEOUT_MS) throw new RuntimeError('INVALID_POLICY', `Remaining run deadline must not exceed ${MAX_TIMEOUT_MS}ms`);
    const controller = new AbortController();
    const cancel = () => controller.abort(spec.signal?.reason);
    spec.signal?.addEventListener('abort', cancel, { once: true });
    if (spec.signal?.aborted) cancel();
    const expire = () => controller.abort(new RuntimeError('RUN_DEADLINE', 'Run deadline exceeded'));
    if (deadline <= Date.now()) expire();
    const timer = setTimeout(expire, Math.max(0, remainingMs));
    try {
      return await new TurnLoop(this.getProvider, this.executor).run({ ...spec, signal: controller.signal,
        runTimeoutMs: Math.max(1, deadline - Date.now()),
        resumeCheckpoint: { ...spec.resumeCheckpoint, runtime_deadline_at: deadline } });
    } finally { clearTimeout(timer); spec.signal?.removeEventListener('abort', cancel); }
  }
}
