import { OpenAIProvider, type LLMProvider as AgentProvider } from '@slide/agent-core';
import type { llmDatabaseService } from '../llm-database-service.js';
import { resolveProviderConnection } from '../llm/provider-connection.js';
import { AnthropicProvider } from './llm-provider.js';

type ProviderStore = Pick<typeof llmDatabaseService, 'getEnabledProviders' | 'getProviderApiKey'>;

export async function createConfiguredAgentProvider(store: ProviderStore): Promise<AgentProvider> {
  const providers = await store.getEnabledProviders();
  const provider = providers[0];
  if (!provider) {
    // Configuration is optional at bootstrap, but a request cannot select an implicit fallback.
    const unavailable = async (): Promise<never> => { throw new Error('LLM_PROVIDER_NOT_CONFIGURED'); };
    return { getDefaultModel: () => 'unconfigured', chat: unavailable, chatStream: unavailable };
  }
  const apiKey = provider.deployment_type === 'local' ? null : await store.getProviderApiKey(provider.name);
  const connection = resolveProviderConnection(provider, apiKey);
  if (connection.format === 'anthropic-messages') return new AnthropicProvider(connection);
  const baseURL = connection.format === 'ollama'
    ? `${connection.baseURL!.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`
    : connection.baseURL;
  return new OpenAIProvider({ ...connection, baseURL });
}
