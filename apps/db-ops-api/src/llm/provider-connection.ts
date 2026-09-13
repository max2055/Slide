import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { LLMProvider } from '../llm-database-service.js';

export function resolveProviderConnection(provider: LLMProvider, apiKey: string | null) {
  const local = provider.deployment_type === 'local';
  const format = provider.api_format || (local ? 'ollama' : 'openai-completions');
  if (!['anthropic-messages', 'openai-completions', 'ollama'].includes(format)) {
    throw new Error('LLM_API_FORMAT_UNSUPPORTED');
  }
  const key = apiKey || (local ? 'ollama' : '');
  if (!key) throw new Error('LLM_CREDENTIAL_NOT_CONFIGURED');
  return {
    format,
    apiKey: key,
    baseURL: provider.api_base_url || (local ? 'http://localhost:11434' : undefined),
    model: provider.default_model || (format === 'anthropic-messages' ? 'claude-sonnet-4-20250929' : 'gpt-4.1'),
  };
}

/** Connection tests and regular calls must construct the same SDK client. */
export function createServiceProviderClient(provider: LLMProvider, apiKey: string | null) {
  const connection = resolveProviderConnection(provider, apiKey);
  const type = connection.format === 'anthropic-messages' ? 'anthropic'
    : connection.format === 'ollama' ? 'ollama' : 'openai';
  return {
    name: provider.name,
    type,
    client: type === 'anthropic' ? new Anthropic(connection)
      : type === 'ollama' ? null : new OpenAI(connection),
    config: { ...provider, api_base_url: connection.baseURL, default_model: connection.model },
  } as const;
}
