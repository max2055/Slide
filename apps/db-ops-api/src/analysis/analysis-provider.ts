import type { LLMProvider, LLMResponse } from '@slide/agent-core';

/** Guard the actual provider calls, including SDK/runner recovery and context compaction. */
export function guardedAnalysisProvider(provider: LLMProvider, beforeSend: () => Promise<void>, signal?: AbortSignal): LLMProvider {
  let uncertain = false;
  return new Proxy(provider, {
    get(target, key) {
      const method = Reflect.get(target, key);
      if (key !== 'chat' && key !== 'chatStream') return typeof method === 'function' ? method.bind(target) : method;
      return async (...args: unknown[]): Promise<LLMResponse> => {
        signal?.throwIfAborted();
        if (uncertain) throw new Error('ANALYSIS_PROVIDER_RESULT_UNKNOWN');
        await beforeSend();
        signal?.throwIfAborted();
        try {
          const response = await method.apply(target, args);
          if (response.finishReason === 'error' || response.error) uncertain = true;
          return response;
        } catch (error) { uncertain = true; throw error; }
      };
    },
  });
}
