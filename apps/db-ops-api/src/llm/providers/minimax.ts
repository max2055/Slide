/**
 * MiniMax LLM 提供商配置
 *
 * 复用上游 provider-catalog 模式
 * 文档：https://platform.minimaxi.com/
 */

import type { ModelProviderConfig, ModelDefinitionConfig } from '../types.js';

export const MINIMAX_BASE_URL = 'https://api.minimax.chat/v1';
export const MINIMAX_DEFAULT_MODEL_ID = 'MiniMax-Text-01';

/**
 * MiniMax 模型目录
 *
 * 成本单位：USD / 1K tokens
 */
export const MINIMAX_MODEL_CATALOG = [
  {
    id: 'MiniMax-Text-01',
    name: 'MiniMax Text 01',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.001,
      output: 0.001,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 245760,
    maxTokens: 65536,
  },
  {
    id: 'MiniMax-VL-01',
    name: 'MiniMax VL 01',
    reasoning: false,
    input: ['text', 'image'],
    cost: {
      input: 0.001,
      output: 0.001,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 245760,
    maxTokens: 65536,
  },
  {
    id: 'abab6.5s',
    name: 'abab6.5s',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.0007,
      output: 0.0007,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: 'abab6.5g',
    name: 'abab6.5g',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.0035,
      output: 0.0035,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: 'abab5.5s',
    name: 'abab5.5s',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.0007,
      output: 0.0007,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 8192,
    maxTokens: 4096,
  },
] as const;

/**
 * 判断是否是 MiniMax 的原生 Base URL
 */
export function isNativeMiniMaxBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return baseUrl.includes('api.minimax.chat');
}

/**
 * 构建 MiniMax 提供商配置
 */
export function buildMiniMaxProvider(): ModelProviderConfig {
  return {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: MINIMAX_BASE_URL,
    api: 'openai-completions',
    models: MINIMAX_MODEL_CATALOG.map((model) => ({
      ...model,
      input: [...model.input],
    })),
    defaultModelId: MINIMAX_DEFAULT_MODEL_ID,
  };
}

/**
 * 获取模型定义
 */
export function buildMiniMaxModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  cost?: typeof MINIMAX_MODEL_CATALOG[0]['cost'];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = MINIMAX_MODEL_CATALOG.find((model) => model.id === params.id);
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? params.id,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input: (params.input ?? (catalog?.input ?? ['text'])) as ('text' | 'image')[],
    cost: params.cost ?? catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 32768,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 8192,
  } as ModelDefinitionConfig;
}
