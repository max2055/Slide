/**
 * Ollama 本地 LLM 提供商配置
 *
 * 复用上游 provider-catalog 模式
 * 文档：https://ollama.ai/
 */

import type { ModelProviderConfig, ModelDefinitionConfig } from '../types.js';

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';
export const OLLAMA_DEFAULT_MODEL_ID = 'qwen2.5-coder:32b';

/**
 * Ollama 常用模型目录
 *
 * 本地部署，成本为 0
 */
export const OLLAMA_MODEL_CATALOG = [
  // Qwen 系列
  {
    id: 'qwen2.5-coder:32b',
    name: 'Qwen2.5-Coder 32B',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: 'qwen2.5-coder:14b',
    name: 'Qwen2.5-Coder 14B',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: 'qwen2.5:32b',
    name: 'Qwen2.5 32B',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: 'qwen2.5:14b',
    name: 'Qwen2.5 14B',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  // DeepSeek 系列
  {
    id: 'deepseek-coder:33b',
    name: 'DeepSeek-Coder 33B',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 16384,
    maxTokens: 4096,
  },
  {
    id: 'deepseek-r1:8b',
    name: 'DeepSeek-R1 8B',
    reasoning: true,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  // Llama 系列
  {
    id: 'llama3.1:70b',
    name: 'Llama 3.1 70B',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 8192,
    maxTokens: 4096,
  },
  {
    id: 'llama3.1:8b',
    name: 'Llama 3.1 8B',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 8192,
    maxTokens: 2048,
  },
  // Code 专用
  {
    id: 'codellama:34b',
    name: 'Code Llama 34B',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 16384,
    maxTokens: 4096,
  },
] as const;

/**
 * 判断是否是 Ollama 的原生 Base URL
 */
export function isNativeOllamaBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return baseUrl.includes('localhost:11434') || baseUrl.includes('127.0.0.1:11434');
}

/**
 * 构建 Ollama 提供商配置
 */
export function buildOllamaProvider(baseUrl?: string): ModelProviderConfig {
  return {
    id: 'ollama',
    name: 'Ollama 本地',
    baseUrl: baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
    api: 'openai-completions',
    models: OLLAMA_MODEL_CATALOG.map((model) => ({
      ...model,
      input: [...model.input],
    })),
    defaultModelId: OLLAMA_DEFAULT_MODEL_ID,
  };
}

/**
 * 获取模型定义
 */
export function buildOllamaModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  cost?: typeof OLLAMA_MODEL_CATALOG[0]['cost'];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = OLLAMA_MODEL_CATALOG.find((model) => model.id === params.id);
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
