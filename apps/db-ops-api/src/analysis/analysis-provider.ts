import { executionRequest, type AnalysisExecutionEvent } from './analysis-execution.js';
import type { LLMProvider, LLMResponse } from '@slide/agent-core';

/** Guard the actual provider calls, including SDK/runner recovery and context compaction. */
export function guardedAnalysisProvider(provider: LLMProvider, beforeSend: () => Promise<void>, signal?: AbortSignal, record?: (event: AnalysisExecutionEvent) => Promise<void>): LLMProvider {
  let uncertain = false;
  let requestNumber = 0;
  return new Proxy(provider, {
    get(target, key) {
      const method = Reflect.get(target, key);
      if (key !== 'chat' && key !== 'chatStream') return typeof method === 'function' ? method.bind(target) : method;
      return async (...args: unknown[]): Promise<LLMResponse> => {
        signal?.throwIfAborted();
        if (uncertain) throw new Error('ANALYSIS_PROVIDER_RESULT_UNKNOWN');
        await beforeSend();
        signal?.throwIfAborted();
        const number = ++requestNumber;
        const options = args[key === 'chat' ? 2 : 3] as { model?: string } | undefined;
        await record?.({ kind: 'request', request: executionRequest(target, args[0] as any, args[1] as any, options?.model ?? target.getDefaultModel(), number) });
        try {
          const response = await method.apply(target, args);
          await record?.({ kind: 'response', requestNumber: number, usage: Object.keys(response.usage ?? {}).length ? response.usage : null });
          if (response.finishReason === 'error' || response.error) uncertain = true;
          return response;
        } catch (error) { uncertain = true; throw error; }
      };
    },
  });
}
