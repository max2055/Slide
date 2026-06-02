/**
 * DeepSeek LLM 提供商配置
 *
 * 复用上游 provider-catalog 模式
 * 文档：https://platform.deepseek.com/api-docs/
 */

import type { ModelProviderConfig, ModelDefinitionConfig } from '../types.js';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEEPSEEK_DEFAULT_MODEL_ID = 'deepseek-chat';

/**
 * DeepSeek 模型目录
 *
 * 成本单位：USD / 1K tokens
 */
export const DEEPSEEK_MODEL_CATALOG = [
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.00039,   // ¥0.002/1K tokens
      output: 0.0016,   // ¥0.008/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 65536,
    maxTokens: 4096,
  },
  {
    id: 'deepseek-coder',
    name: 'DeepSeek Coder',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.00039,   // ¥0.002/1K tokens
      output: 0.0016,   // ¥0.008/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 16384,
    maxTokens: 4096,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    reasoning: true,
    input: ['text'],
    cost: {
      input: 0.00077,   // ¥0.004/1K tokens
      output: 0.0032,   // ¥0.016/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 65536,
    maxTokens: 8192,
  },
] as const;

/**
 * 判断是否是 DeepSeek 的原生 Base URL
 */
export function isNativeDeepSeekBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return baseUrl.includes('api.deepseek.com');
}

/**
 * 构建 DeepSeek 提供商配置
 */
export function buildDeepSeekProvider(): ModelProviderConfig {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: DEEPSEEK_BASE_URL,
    api: 'openai-completions',
    models: DEEPSEEK_MODEL_CATALOG.map((model) => ({
      ...model,
      input: [...model.input],
    })),
    defaultModelId: DEEPSEEK_DEFAULT_MODEL_ID,
  };
}

/**
 * 获取模型定义
 */
export function buildDeepSeekModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  cost?: typeof DEEPSEEK_MODEL_CATALOG[0]['cost'];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = DEEPSEEK_MODEL_CATALOG.find((model) => model.id === params.id);
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? params.id,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input: (params.input ?? (catalog?.input ?? ['text'])) as ('text' | 'image')[],
    cost: params.cost ?? catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 65536,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 4096,
  } as ModelDefinitionConfig;
}
