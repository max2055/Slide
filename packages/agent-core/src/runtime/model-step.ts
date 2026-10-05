import { currentTime, projectContextBlocks, runtimeBlock } from '../context-block.js';
import type { AgentHook, AgentHookContext, AgentRunSpec, LLMResponse, Message } from '../types.js';
import { ContextManager, normalizeToolGroups } from './context-manager.js';
import { RuntimeError, cancellationError } from './recovery-policy.js';
import { StreamingCoordinator } from './streaming-coordinator.js';

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
    let queue: StreamingCoordinator<{ type: 'text' | 'reasoning' | 'tool'; delta: string }> | undefined;
    const stop = (error: unknown) => {
      if (!active) return;
      active = false; rejectBoundary(error); controller.abort(error); queue?.fail(error);
    };
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
      if (hook.wantsStreaming()) queue = new StreamingCoordinator(async (event, signal) => {
        if (event.type === 'text') await hook.onStream(context, event.delta, signal);
        else if (event.type === 'reasoning') await hook.emitReasoning(event.delta, signal);
        else await hook.onToolInput?.(context, JSON.parse(event.delta), signal);
      }, {
        ...spec.streamingLimits,
        size: event => Buffer.byteLength(event.delta, 'utf8') + 32,
        // Raw content deltas concatenate. Reasoning/control boundaries never merge.
        merge: (a, b) => a.type === 'text' && b.type === 'text' ? { type: 'text', delta: a.delta + b.delta } : undefined,
        onError: stop,
      });
      const options = { model: spec.model, temperature: spec.temperature, maxTokens: spec.maxTokens,
        reasoningEffort: spec.reasoningEffort, timeoutS, streamIdleTimeoutS: idleS, signal: controller.signal };
      let outputStarted = false;
      const output = async () => {
        if (outputStarted) return;
        outputStarted = true;
        await spec.onRuntimePhase?.('generating');
      };
      const request = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        await spec.onRuntimePhase?.('waiting_model');
        controller.signal.throwIfAborted();
        const definitions = spec.tools.getDefinitions();
        // Ordinary requests carry the step's snapshot; internal summary requests
        // receive one here. Text that resembles a clock inside user data is untouched.
        const hasTime = messages.some(m => m.source === 'runtime' && String(m.content).startsWith('Current Time:'));
        const normalized = normalizeToolGroups(hasTime ? messages : [...messages, ...projectContextBlocks([runtimeBlock('runtime', currentTime())])]);
        const projection = this.provider.projectMessages?.(normalized, spec.model) ?? normalized;
        new ContextManager(spec, this.provider).assertFits(projection, undefined, definitions);
        return hook.wantsStreaming() ? this.provider.chatStream(projection, definitions, {
          // Idle is semantic provider output, not transport heartbeats/metadata.
          // Content, thinking and tool fragments below own the deadline.
          onContentDelta: async delta => {
            if (!active || controller.signal.aborted) return;
            if (delta) { await output(); activity(); context.streamedContent = true; if (context.provisionalBytes) context.provisionalBytes.text += Buffer.byteLength(delta); }
            await queue!.enqueue({ type: 'text', delta });
          },
          onThinkingDelta: async delta => {
            if (!active || controller.signal.aborted) return;
            if (delta) { await output(); activity(); context.streamedReasoning = true; if (context.provisionalBytes) context.provisionalBytes.reasoning += Buffer.byteLength(delta); await queue!.enqueue({ type: 'reasoning', delta }); }
          },
          onToolCallDelta: async delta => {
            if (!active || controller.signal.aborted) return;
            await output();
            activity();
            if (context.provisionalBytes) context.provisionalBytes.tool += Buffer.byteLength(JSON.stringify(delta));
            // Tool arguments remain provider-owned. This marker fences text
            // coalescing; actual tool_start waits for the model boundary drain.
            await queue!.enqueue({ type: 'tool', delta: JSON.stringify(delta) });
          },
        }, options) : this.provider.chat(projection, definitions, options);
      });
      // Observe the original promise, never the timeout race.
      spec.onProviderRequest?.(request);
      const delivered = request.then(async response => {
        // Reader EOF is no longer an idle stream; wall-clock and consumer timers
        // continue covering drain before tool/control/terminal hooks can run.
        clearTimeout(idle);
        await queue?.drain();
        return response;
      });
      return await Promise.race([delivered, boundary]);
    } finally {
      active = false;
      queue?.fail(controller.signal.reason ?? new RuntimeError('STREAM_CLOSED', 'Model boundary closed'));
      clearTimeout(timer); clearTimeout(idle);
      spec.signal?.removeEventListener('abort', cancel);
    }
  }
}
