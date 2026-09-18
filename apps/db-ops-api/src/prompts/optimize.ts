import type { LLMProvider } from '@slide/agent-core';
import { llmDatabaseService } from '../llm-database-service.js';
import { createConfiguredAgentProvider } from '../adapter/llm-provider-factory.js';

export async function optimizePromptContent(
  prompt: string,
  getProvider: () => Promise<LLMProvider> = () => createConfiguredAgentProvider(llmDatabaseService, 'prompt_optimize', false),
): Promise<string> {
  const provider = await getProvider();
  const signal = AbortSignal.timeout(45_000);
  const result = await provider.chat([{ role: 'user', content: prompt }], [], { signal });
  if (signal.aborted) throw new DOMException('模型响应超时，请稍后重试', 'TimeoutError');
  if (result.finishReason === 'error' || !result.content?.trim()) {
    throw new Error(result.error || '模型未返回优化结果');
  }
  return result.content;
}
