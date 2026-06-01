/**
 * 阿里云百炼 LLM 提供商配置
 *
 * 复用 OpenClaw provider-catalog 模式
 * 文档：https://help.aliyun.com/zh/model-studio/
 */

import type { ModelProviderConfig, ModelDefinitionConfig } from '../types.js';

export const BAILIAN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const BAILIAN_DEFAULT_MODEL_ID = 'qwen-plus';

/**
 * 阿里云百炼模型目录
 *
 * 成本单位：USD / 1K tokens
 * 实际成本在 llm-usage-tracker 中计算
 */
export const BAILIAN_MODEL_CATALOG = [
  {
    id: 'qwen-plus',
    name: 'Qwen-Plus',
    reasoning: false,
    input: ['text', 'image'],
    cost: {
      input: 0.0005,    // ￥0.0035/1K tokens
      output: 0.002,    // ￥0.015/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: 'qwen-max',
    name: 'Qwen-Max',
    reasoning: false,
    input: ['text', 'image'],
    cost: {
      input: 0.004,     // ￥0.028/1K tokens
      output: 0.012,    // ￥0.084/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: 'qwen-turbo',
    name: 'Qwen-Turbo',
    reasoning: false,
    input: ['text', 'image'],
    cost: {
      input: 0.0003,    // ￥0.002/1K tokens
      output: 0.0009,   // ￥0.006/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: 'qwen-long',
    name: 'Qwen-Long',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.0005,    // ￥0.005/1K tokens
      output: 0.002,    // ￥0.02/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: 'deepseek-v3',
    name: 'DeepSeek-V3 (阿里云)',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.0014,    // ￥0.01/1K tokens
      output: 0.004,    // ￥0.028/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 65536,
    maxTokens: 8192,
  },
] as const;

/**
 * 判断是否是阿里云百炼的原生 Base URL
 */
export function isNativeBailianBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return baseUrl.includes('dashscope.aliyuncs.com');
}

/**
 * 构建阿里云百炼提供商配置
 */
export function buildBailianProvider(): ModelProviderConfig {
  return {
    id: 'bailian',
    name: '阿里云百炼',
    baseUrl: BAILIAN_BASE_URL,
    api: 'openai-completions',
    models: BAILIAN_MODEL_CATALOG.map((model) => ({
      ...model,
      input: [...model.input],
    })),
    defaultModelId: BAILIAN_DEFAULT_MODEL_ID,
  };
}

/**
 * 获取模型定义
 */
export function buildBailianModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  cost?: typeof BAILIAN_MODEL_CATALOG[0]['cost'];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = BAILIAN_MODEL_CATALOG.find((model) => model.id === params.id);
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? params.id,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input: (params.input ?? (catalog?.input ?? ['text'])) as ('text' | 'image')[],
    cost: params.cost ?? catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 131072,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 65536,
  } as ModelDefinitionConfig;
}
