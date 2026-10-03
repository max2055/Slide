import { OpenAIProvider, UNKNOWN_CONTEXT_WINDOW, type ModelCapabilities, type LLMProvider as AgentProvider } from '@slide/agent-core';
import type { llmDatabaseService } from '../llm-database-service.js';
import { resolveSceneModel, LLMConfigurationError } from '../llm/scene-routing.js';
import { resolveProviderConnection } from '../llm/provider-connection.js';
import { AnthropicProvider } from './llm-provider.js';
import { getAllProviders } from '../llm/provider-catalog.js';
import type { LLMProvider } from '../llm-database-service.js';
import { setAnalysisProviderIdentity } from '../analysis/analysis-execution.js';
import { evidenceHash } from '../analysis/analysis-evidence.js';
import { providerForModel } from '../llm/model-parameters.js';

type ProviderStore = Pick<typeof llmDatabaseService, 'getAllProviders' | 'getSceneBindings' | 'getProviderApiKey'>;

/** Stored limits remain authoritative; a catalog can only tighten them. No route changes. */
export function configuredModelCapabilities(provider: LLMProvider, model: string): ModelCapabilities {
  provider = providerForModel(provider, model);
  const selected = provider.models_supported?.find(m => m.id === model);
  const catalogs = getAllProviders();
  const catalog = catalogs.flatMap(p => p.models).find(m => m.id === model);
  const configured = provider.context_window;
  if (configured !== undefined && (!Number.isSafeInteger(configured) || configured <= 0)) throw new Error('INVALID_MODEL_CONTEXT');
  if (provider.max_tokens !== undefined && (!Number.isSafeInteger(provider.max_tokens) || provider.max_tokens <= 0)) throw new Error('INVALID_MODEL_OUTPUT');
  if (selected?.maxTokens !== undefined && (!Number.isSafeInteger(selected.maxTokens) || selected.maxTokens <= 0)) throw new Error('INVALID_MODEL_OUTPUT');
  const nativeCatalog = catalogs.find(p => {
    try {
      const actual = new URL(provider.api_base_url ?? '');
      return actual.protocol === 'https:' && actual.hostname === new URL(p.baseUrl).hostname;
    } catch { return false; }
  })?.models.find(m => m.id === model);
  // Custom endpoints cannot inherit a large window solely from an OpenAI-like model name.
  const window = configured !== undefined ? Math.min(configured, catalog?.contextWindow ?? Infinity)
    : nativeCatalog?.contextWindow ?? UNKNOWN_CONTEXT_WINDOW;
  return { model, contextWindowTokens: window,
    ...(selected?.maxTokens !== undefined || catalog ? { maxOutputTokens: selected?.maxTokens ?? catalog!.maxTokens } : {}),
    ...(provider.max_tokens !== undefined ? { preferredOutputTokens: Math.min(provider.max_tokens, selected?.maxTokens ?? catalog?.maxTokens ?? Infinity, window - 1025) } : {}),
    supportsTools: !!provider.supports_function_call,
    supportsVision: !!provider.supports_vision && (!catalog || catalog.input.includes('image')),
    source: configured !== undefined ? 'configuration' : nativeCatalog ? 'catalog' : 'conservative-fallback',
    version: 'slide-provider-config/catalog-v1' };
}

export async function createConfiguredAgentProvider(store: ProviderStore, purpose = 'chat', requiresFunctionCall = true, allowUnconfigured = true): Promise<AgentProvider> {
  let provider;
  let model;
  try {
    ({ provider, model } = await resolveSceneModel(store, purpose, { requiresFunctionCall }));
  } catch (error) {
    if (!(error instanceof LLMConfigurationError) || !allowUnconfigured) throw error;
    // Keep configuration repair available at bootstrap; request resolution is strict.
    const unavailable = async (): Promise<never> => { throw error; };
    return { getDefaultModel: () => 'unconfigured', chat: unavailable, chatStream: unavailable };
  }
  const apiKey = await store.getProviderApiKey(provider.name);
  const connection = resolveProviderConnection({ ...provider, default_model: model }, apiKey);
  const capabilities = configuredModelCapabilities(provider, model);
  const identity = { provider: provider.name, providerId: provider.id, routeVersion: evidenceHash([provider.id, provider.updated_at, model, purpose, connection.format]) };
  if (connection.format === 'anthropic-messages') {
    const selected = new AnthropicProvider({ ...connection, capabilities });
    setAnalysisProviderIdentity(selected, identity); return selected;
  }
  const baseURL = connection.format === 'ollama'
    ? `${connection.baseURL!.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`
    : connection.baseURL;
  const selected = new OpenAIProvider({ ...connection, baseURL, capabilities });
  setAnalysisProviderIdentity(selected, identity); return selected;
}
