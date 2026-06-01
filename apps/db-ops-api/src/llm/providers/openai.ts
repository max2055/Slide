/**
 * OpenAI LLM 提供商配置
 *
 * 文档：https://platform.openai.com/docs/api-reference
 */

import type { ModelProviderConfig, ModelDefinitionConfig } from '../types.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL_ID = 'gpt-4o';

export const OPENAI_MODEL_CATALOG = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    reasoning: false,
    input: ['text', 'image'] as const,
    cost: { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    reasoning: false,
    input: ['text', 'image'] as const,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    reasoning: false,
    input: ['text', 'image'] as const,
    cost: { input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: 'o4-mini',
    name: 'o4 Mini',
    reasoning: true,
    input: ['text'] as const,
    cost: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 100000,
  },
] as const;

export function isNativeOpenAIBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return baseUrl.includes('api.openai.com');
}

export function buildOpenAIProvider(): ModelProviderConfig {
  return {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: OPENAI_BASE_URL,
    api: 'openai-completions',
    models: OPENAI_MODEL_CATALOG.map((model) => ({
      ...model,
      input: [...model.input],
    })),
    defaultModelId: OPENAI_DEFAULT_MODEL_ID,
  };
}

export function buildOpenAIModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  cost?: typeof OPENAI_MODEL_CATALOG[0]['cost'];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = OPENAI_MODEL_CATALOG.find((model) => model.id === params.id);
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? params.id,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input: (params.input ?? (catalog?.input ?? ['text'])) as ('text' | 'image')[],
    cost: params.cost ?? catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 128000,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 16384,
  } as ModelDefinitionConfig;
}
