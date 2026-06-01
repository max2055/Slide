/**
 * Anthropic LLM 提供商配置
 *
 * 文档：https://docs.anthropic.com/en/api
 */

import type { ModelProviderConfig, ModelDefinitionConfig } from '../types.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_DEFAULT_MODEL_ID = 'claude-sonnet-4-20250929';

export const ANTHROPIC_MODEL_CATALOG = [
  {
    id: 'claude-sonnet-4-20250929',
    name: 'Claude Sonnet 4',
    reasoning: false,
    input: ['text', 'image'] as const,
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: 'claude-opus-4-20250514',
    name: 'Claude Opus 4',
    reasoning: false,
    input: ['text', 'image'] as const,
    cost: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    reasoning: false,
    input: ['text', 'image'] as const,
    cost: { input: 0.80, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
] as const;

export function isNativeAnthropicBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return baseUrl.includes('api.anthropic.com');
}

export function buildAnthropicProvider(): ModelProviderConfig {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: ANTHROPIC_BASE_URL,
    api: 'anthropic',
    models: ANTHROPIC_MODEL_CATALOG.map((model) => ({
      ...model,
      input: [...model.input],
    })),
    defaultModelId: ANTHROPIC_DEFAULT_MODEL_ID,
  };
}

export function buildAnthropicModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  cost?: typeof ANTHROPIC_MODEL_CATALOG[0]['cost'];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = ANTHROPIC_MODEL_CATALOG.find((model) => model.id === params.id);
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? params.id,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input: (params.input ?? (catalog?.input ?? ['text'])) as ('text' | 'image')[],
    cost: params.cost ?? catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 200000,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 64000,
  } as ModelDefinitionConfig;
}
