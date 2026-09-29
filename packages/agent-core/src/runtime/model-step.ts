import type { AgentHook, AgentHookContext, AgentRunSpec, LLMResponse, Message } from '../types.js';
import { ContextManager, normalizeToolGroups } from './context-manager.js';
import { RuntimeError, cancellationError } from './recovery-policy.js';

export class TimeoutError extends RuntimeError {
  constructor(message: string, code = 'MODEL_REQUEST_TIMEOUT') { super(code, message); this.name = 'TimeoutError'; }
}

/** Timers belong at the model boundary, including providers that ignore abort. */
export class ModelStep {
  constructor(private readonly provider: import('../types.js').LLMProvider) {}
  async request(spec: AgentRunSpec, messages: Message[], hook: AgentHook, context: AgentHookContext): Promise<LLMResponse> {
    const timeoutS = spec.llmTimeoutS ?? parseFloat(process.env.NANOBOT_LLM_TIMEOUT_S || '300');
    const idleS = spec.streamIdleTimeoutS ?? spec.llmTimeoutS ?? (parseFloat(process.env.NANOBOT_STREAM_IDLE_TIMEOUT_S || '0') || undefined);
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let rejectBoundary!: (error: unknown) => void;
    const stop = (error: unknown) => { active = false; rejectBoundary(error); controller.abort(error); };
    const cancel = () => stop(cancellationError(spec.signal));
    const activity = () => {
      if (!active || !idleS || !hook.wantsStreaming()) return;
      clearTimeout(idle);
      idle = setTimeout(() => stop(new TimeoutError(`LLM stream idle timed out after ${idleS}s`, 'MODEL_IDLE_TIMEOUT')), idleS * 1000);
    };
    const boundary = new Promise<never>((_, reject) => { rejectBoundary = reject; });
    try {
      if (spec.signal?.aborted) throw cancellationError(spec.signal);
      spec.signal?.addEventListener('abort', cancel, { once: true });
      if (timeoutS > 0) timer = setTimeout(() => stop(new TimeoutError(`LLM request timed out after ${timeoutS}s`)), timeoutS * 1000);
      activity();
      const options = { model: spec.model, temperature: spec.temperature, maxTokens: spec.maxTokens,
        reasoningEffort: spec.reasoningEffort, timeoutS, streamIdleTimeoutS: idleS, signal: controller.signal };
      const request = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        const definitions = spec.tools.getDefinitions();
        const projection = normalizeToolGroups(messages);
        new ContextManager(spec, this.provider).assertFits(projection, undefined, definitions);
        return hook.wantsStreaming() ? this.provider.chatStream(projection, definitions, {
          onActivity: activity,
          onContentDelta: async delta => {
            if (!active || controller.signal.aborted) return;
            if (delta) { activity(); context.streamedContent = true; }
            await hook.onStream(context, delta);
          },
          onThinkingDelta: async delta => {
            if (!active || controller.signal.aborted) return;
            if (delta) { activity(); context.streamedReasoning = true; await hook.emitReasoning(delta); }
          },
          onToolCallDelta: async () => { if (active) activity(); },
        }, options) : this.provider.chat(projection, definitions, options);
      });
      // Observe the original promise, never the timeout race.
      spec.onProviderRequest?.(request);
      return await Promise.race([request, boundary]);
    } finally {
      active = false;
      clearTimeout(timer); clearTimeout(idle);
      spec.signal?.removeEventListener('abort', cancel);
    }
  }
}
