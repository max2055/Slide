/**
 * LLM Provider 类型定义
 *
 * provider-model-shared 模式（复用上游设计）
 */

/**
 * 模型输入类型
 */
export type ModelInputType = 'text' | 'image' | 'audio' | 'video';

/**
 * 模型定义配置
 */
export interface ModelDefinitionConfig {
  /** 模型 ID */
  id: string;
  /** 模型显示名称 */
  name: string;
  /** 是否是推理模型 */
  reasoning: boolean;
  /** 支持的输入类型 */
  input: ModelInputType[];
  /** 成本配置（USD / 1K tokens） */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** 上下文窗口大小（tokens） */
  contextWindow: number;
  /** 最大输出 tokens */
  maxTokens: number;
}

/**
 * LLM 提供商配置
 */
export interface ModelProviderConfig {
  /** 提供商 ID */
  id: string;
  /** 提供商显示名称 */
  name: string;
  /** API Base URL */
  baseUrl: string;
  /** API 兼容模式 */
  api: 'openai-completions' | 'anthropic' | 'native';
  /** 支持的模型列表 */
  models: ModelDefinitionConfig[];
  /** 默认模型 ID */
  defaultModelId?: string;
  /** API Key（可选，运行时注入） */
  apiKey?: string;
}

/**
 * LLM 使用量记录
 */
export interface LLMUsageRecord {
  /** 提供商 ID */
  providerId: string;
  /** 模型 ID */
  modelId: string;
  /** 输入 tokens */
  inputTokens: number;
  /** 输出 tokens */
  outputTokens: number;
  /** 总 tokens */
  totalTokens: number;
  /** 成本（USD） */
  costUsd: number;
  /** 调用时间戳 */
  timestamp: number;
  /** 调用目的 */
  purpose?: string;
  /** 用户 ID */
  userId?: string;
  /** 会话 ID */
  sessionId?: string;
}

/**
 * LLM 响应结果
 */
export interface LLMResponse {
  success: boolean;
  content?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
  };
  model?: string;
  provider?: string;
  duration_ms?: number;
  error?: string;
}
