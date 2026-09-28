import type { AgentHook, AgentHookContext, AgentRunSpec, LLMResponse, Message } from "../types.js";

function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutS: number, signal?: AbortSignal, onRequest?: (request: Promise<T>) => void): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      cleanup();
      const error = signal?.reason ?? new Error('Cancelled');
      reject(error);
      controller.abort(error);
    };
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    if (timeoutS > 0) timer = setTimeout(() => {
      cleanup();
      const error = new TimeoutError(`LLM request timed out after ${timeoutS}s`);
      reject(error);
      controller.abort(error);
    }, timeoutS * 1000);
    const request = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    });
    request.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    onRequest?.(request);
  });
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class ModelStep {
  constructor(private readonly provider: import("../types.js").LLMProvider) {}
  async request(
    spec: AgentRunSpec,
    messages: Message[],
    hook: AgentHook,
    context: AgentHookContext
  ): Promise<LLMResponse> {
    const wantsStreaming = hook.wantsStreaming();
    const tools = spec.tools.getDefinitions();
    const timeoutS = spec.llmTimeoutS ?? parseFloat(process.env.NANOBOT_LLM_TIMEOUT_S || '300');

    if (wantsStreaming) {
      return withTimeout(signal => this.provider.chatStream(
        messages,
        tools,
        {
          onContentDelta: async (delta: string) => {
            if (delta) context.streamedContent = true;
            await hook.onStream(context, delta);
          },
          onThinkingDelta: async (delta: string) => {
            if (delta) {
              context.streamedReasoning = true;
              await hook.emitReasoning(delta);
            }
          },
        },
        {
          model: spec.model,
          temperature: spec.temperature,
          maxTokens: spec.maxTokens,
          reasoningEffort: spec.reasoningEffort,
          timeoutS,
          streamIdleTimeoutS: spec.llmTimeoutS
            ? spec.llmTimeoutS
            : parseFloat(process.env.NANOBOT_STREAM_IDLE_TIMEOUT_S || '0') || undefined,
          signal,
        }
      ), 0, spec.signal, spec.onProviderRequest);
    }

    // Non-streaming: wrap with wall-clock timeout
    return withTimeout(
      signal => this.provider.chat(messages, tools, {
        model: spec.model,
        temperature: spec.temperature,
        maxTokens: spec.maxTokens,
        reasoningEffort: spec.reasoningEffort,
        timeoutS,
        signal,
      }),
      timeoutS,
      spec.signal,
      spec.onProviderRequest,
    );
  }

}

export async function requestFinalizationRetry(
  spec: AgentRunSpec,
  messages: Message[],
  provider: import("../types.js").LLMProvider
): Promise<LLMResponse> {
  const retryMessages = [
    ...messages,
    {
      role: "user" as const,
      content:
        "[System: Your previous response was empty. " +
        "Please provide a substantive response to the user's request.]",
    },
  ];
  const timeoutS = spec.llmTimeoutS ?? parseFloat(process.env.NANOBOT_LLM_TIMEOUT_S || '300');
  try {
    return await withTimeout(
      signal => provider.chat(retryMessages, [], {
        model: spec.model,
        temperature: spec.temperature,
        maxTokens: spec.maxTokens,
        reasoningEffort: spec.reasoningEffort,
        timeoutS,
        signal,
      }),
      timeoutS,
      spec.signal,
      spec.onProviderRequest,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = error instanceof TimeoutError;
    return {
      content: null,
      finishReason: 'error',
      toolCalls: [],
      usage: {},
      shouldExecuteTools: false,
      hasToolCalls: false,
      errorKind: timedOut ? 'timeout' : 'provider_error',
      error: message,
    };
  }
}

