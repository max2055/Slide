/**
 * GLM (智谱 AI) LLM 提供商配置
 *
 * 复用 OpenClaw provider-catalog 模式
 * 文档：https://open.bigmodel.cn/dev/api
 */

import type { ModelProviderConfig, ModelDefinitionConfig } from '../types.js';

export const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
export const GLM_DEFAULT_MODEL_ID = 'glm-4';

/**
 * GLM 模型目录
 *
 * 成本单位：USD / 1K tokens
 * 参考：https://open.bigmodel.cn/pricing
 */
export const GLM_MODEL_CATALOG = [
  {
    id: 'glm-4',
    name: 'GLM-4',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.0014,    // ￥0.01/1K tokens
      output: 0.0014,   // ￥0.01/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 4096,
  },
  {
    id: 'glm-4-flash',
    name: 'GLM-4 Flash',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.00014,   // ￥0.001/1K tokens
      output: 0.00014,  // ￥0.001/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 4096,
  },
  {
    id: 'glm-4-plus',
    name: 'GLM-4 Plus',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.0007,    // ￥0.005/1K tokens
      output: 0.0007,   // ￥0.005/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 4096,
  },
  {
    id: 'glm-4-long',
    name: 'GLM-4 Long',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.00014,   // ￥0.001/1K tokens
      output: 0.00014,  // ￥0.001/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 4096,
  },
  {
    id: 'glm-3-turbo',
    name: 'GLM-3 Turbo',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.00007,   // ￥0.0005/1K tokens
      output: 0.00007,  // ￥0.0005/1K tokens
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 4096,
  },
  {
    id: 'chatglm-4',
    name: 'ChatGLM-4',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.0014,
      output: 0.0014,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 4096,
  },
] as const;

/**
 * 判断是否是 GLM 的原生 Base URL
 */
export function isNativeGlmBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return baseUrl.includes('open.bigmodel.cn');
}

/**
 * 构建 GLM 提供商配置
 */
export function buildGlmProvider(): ModelProviderConfig {
  return {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: GLM_BASE_URL,
    api: 'openai-completions',
    models: GLM_MODEL_CATALOG.map((model) => ({
      ...model,
      input: [...model.input],
    })),
    defaultModelId: GLM_DEFAULT_MODEL_ID,
  };
}

/**
 * 获取模型定义
 */
export function buildGlmModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  cost?: typeof GLM_MODEL_CATALOG[0]['cost'];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = GLM_MODEL_CATALOG.find((model) => model.id === params.id);
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? params.id,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input: (params.input ?? (catalog?.input ?? ['text'])) as ('text' | 'image')[],
    cost: params.cost ?? catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 128000,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 4096,
  } as ModelDefinitionConfig;
}
