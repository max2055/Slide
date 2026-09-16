import { OpenAIProvider, type LLMProvider as AgentProvider } from '@slide/agent-core';
import type { llmDatabaseService } from '../llm-database-service.js';
import { resolveSceneModel, LLMConfigurationError } from '../llm/scene-routing.js';
import { resolveProviderConnection } from '../llm/provider-connection.js';
import { AnthropicProvider } from './llm-provider.js';

type ProviderStore = Pick<typeof llmDatabaseService, 'getAllProviders' | 'getSceneBindings' | 'getProviderApiKey'>;

export async function createConfiguredAgentProvider(store: ProviderStore, purpose = 'chat'): Promise<AgentProvider> {
  let provider;
  let model;
  try {
    ({ provider, model } = await resolveSceneModel(store, purpose, { requiresFunctionCall: true }));
  } catch (error) {
    if (!(error instanceof LLMConfigurationError)) throw error;
    // Keep configuration repair available at bootstrap; requests fail with the exact error.
    const unavailable = async (): Promise<never> => { throw error; };
    return { getDefaultModel: () => 'unconfigured', chat: unavailable, chatStream: unavailable };
  }
  const apiKey = await store.getProviderApiKey(provider.name);
  const connection = resolveProviderConnection({ ...provider, default_model: model }, apiKey);
  if (connection.format === 'anthropic-messages') return new AnthropicProvider(connection);
  const baseURL = connection.format === 'ollama'
    ? `${connection.baseURL!.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`
    : connection.baseURL;
  return new OpenAIProvider({ ...connection, baseURL });
}
