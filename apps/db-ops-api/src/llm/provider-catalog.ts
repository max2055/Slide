/**
 * LLM Provider Catalog
 *
 * 统一管理所有 LLM 提供商配置
 * 复用 OpenClaw provider-catalog 模式
 */

import {
  buildAnthropicProvider,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL_ID,
  ANTHROPIC_MODEL_CATALOG,
  isNativeAnthropicBaseUrl,
} from './providers/anthropic.js';
import {
  buildOpenAIProvider,
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL_ID,
  OPENAI_MODEL_CATALOG,
  isNativeOpenAIBaseUrl,
} from './providers/openai.js';
import {
  buildBailianProvider,
  BAILIAN_BASE_URL,
  BAILIAN_DEFAULT_MODEL_ID,
  BAILIAN_MODEL_CATALOG,
  isNativeBailianBaseUrl,
} from './providers/aliyun-bailian.js';
import {
  buildDeepSeekProvider,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL_ID,
  DEEPSEEK_MODEL_CATALOG,
  isNativeDeepSeekBaseUrl,
} from './providers/deepseek.js';
import {
  buildMiniMaxProvider,
  MINIMAX_BASE_URL,
  MINIMAX_DEFAULT_MODEL_ID,
  MINIMAX_MODEL_CATALOG,
  isNativeMiniMaxBaseUrl,
} from './providers/minimax.js';
import {
  buildGlmProvider,
  GLM_BASE_URL,
  GLM_DEFAULT_MODEL_ID,
  GLM_MODEL_CATALOG,
  isNativeGlmBaseUrl,
} from './providers/glm.js';
import {
  buildOllamaProvider,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL_ID,
  OLLAMA_MODEL_CATALOG,
  isNativeOllamaBaseUrl,
} from './providers/ollama.js';
import type { ModelProviderConfig } from './types.js';

/**
 * 支持的 LLM 提供商 ID 列表
 */
export const SUPPORTED_PROVIDER_IDS = ['anthropic', 'openai', 'bailian', 'deepseek', 'minimax', 'glm', 'ollama'] as const;

export type SupportedProviderId = typeof SUPPORTED_PROVIDER_IDS[number];

/**
 * 提供商注册表
 */
const PROVIDER_REGISTRY: Record<SupportedProviderId, () => ModelProviderConfig> = {
  anthropic: buildAnthropicProvider,
  openai: buildOpenAIProvider,
  bailian: buildBailianProvider,
  deepseek: buildDeepSeekProvider,
  minimax: buildMiniMaxProvider,
  glm: buildGlmProvider,
  ollama: buildOllamaProvider,
};

/**
 * 获取所有可用提供商
 */
export function getAllProviders(): ModelProviderConfig[] {
  return Object.values(PROVIDER_REGISTRY).map((buildFn) => buildFn());
}

/**
 * 获取指定提供商配置
 */
export function getProvider(providerId: string): ModelProviderConfig | null {
  const buildFn = PROVIDER_REGISTRY[providerId as SupportedProviderId];
  if (!buildFn) {
    return null;
  }
  return buildFn();
}

/**
 * 判断提供商 ID 是否支持
 */
export function isSupportedProvider(providerId: string): providerId is SupportedProviderId {
  return SUPPORTED_PROVIDER_IDS.includes(providerId as SupportedProviderId);
}

/**
 * 判断 Base URL 属于哪个提供商
 */
export function resolveProviderFromBaseUrl(baseUrl: string): SupportedProviderId | null {
  if (isNativeAnthropicBaseUrl(baseUrl)) return 'anthropic';
  if (isNativeOpenAIBaseUrl(baseUrl)) return 'openai';
  if (isNativeBailianBaseUrl(baseUrl)) return 'bailian';
  if (isNativeDeepSeekBaseUrl(baseUrl)) return 'deepseek';
  if (isNativeMiniMaxBaseUrl(baseUrl)) return 'minimax';
  if (isNativeGlmBaseUrl(baseUrl)) return 'glm';
  if (isNativeOllamaBaseUrl(baseUrl)) return 'ollama';
  return null;
}

/**
 * 获取默认提供商（优先返回阿里云百炼）
 */
export function getDefaultProvider(): ModelProviderConfig {
  return buildBailianProvider();
}

// 导出所有提供商的配置常量
export {
  // Anthropic
  ANTHROPIC_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL_ID,
  ANTHROPIC_MODEL_CATALOG,
  isNativeAnthropicBaseUrl,
  // OpenAI
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL_ID,
  OPENAI_MODEL_CATALOG,
  isNativeOpenAIBaseUrl,
  // 阿里云百炼
  BAILIAN_BASE_URL,
  BAILIAN_DEFAULT_MODEL_ID,
  BAILIAN_MODEL_CATALOG,
  isNativeBailianBaseUrl,
  // DeepSeek
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL_ID,
  DEEPSEEK_MODEL_CATALOG,
  isNativeDeepSeekBaseUrl,
  // MiniMax
  MINIMAX_BASE_URL,
  MINIMAX_DEFAULT_MODEL_ID,
  MINIMAX_MODEL_CATALOG,
  isNativeMiniMaxBaseUrl,
  // GLM
  GLM_BASE_URL,
  GLM_DEFAULT_MODEL_ID,
  GLM_MODEL_CATALOG,
  isNativeGlmBaseUrl,
  // Ollama
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL_ID,
  OLLAMA_MODEL_CATALOG,
  isNativeOllamaBaseUrl,
};

// 导出构建函数
export {
  buildAnthropicProvider,
  buildOpenAIProvider,
  buildBailianProvider,
  buildDeepSeekProvider,
  buildMiniMaxProvider,
  buildGlmProvider,
  buildOllamaProvider,
};
