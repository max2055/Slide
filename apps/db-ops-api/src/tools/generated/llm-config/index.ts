/**
 * LLM 配置管理工具
 *
 * 复用 OpenClaw tool 模式
 */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import {
  getAllProviders,
  getProvider,
  isSupportedProvider,
  SUPPORTED_PROVIDER_IDS,
} from '../../../llm/provider-catalog.js';
import type { ModelProviderConfig } from '../../../llm/types.js';
import { memoryUsageStore, getUsageStats } from '../../../llm/llm-usage-tracker.js';
import { llmDatabaseService } from '../../../llm-database-service.js';

// ============== 工具：列出所有 LLM 提供商 ==============

/**
 * 列出所有已配置的 LLM 提供商
 */
export function createListLLMProvidersTool(): AnyAgentTool {
  return {
    name: 'slide_list_llm_providers',
    description: '列出所有已配置的 LLM 提供商及其支持的模型',
    parameters: {
      type: 'object',
      properties: {
        includeDetails: {
          type: 'boolean',
          description: '是否包含详细信息（模型列表、成本等）',
        },
      },
      required: [],
    },
    handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const includeDetails = args['includeDetails'] as boolean;
      const providers = getAllProviders();

      if (includeDetails) {
        return {
          success: true,
          data: {
            providers: providers.map(p => ({
              id: p.id,
              name: p.name,
              baseUrl: p.baseUrl,
              defaultModelId: p.defaultModelId,
              models: p.models.map(m => ({
                id: m.id,
                name: m.name,
                contextWindow: m.contextWindow,
                cost: m.cost,
              })),
            })),
            total: providers.length,
          },
        };
      }

      return {
        success: true,
        data: {
          providers: providers.map(p => ({
            id: p.id,
            name: p.name,
            defaultModelId: p.defaultModelId,
          })),
          total: providers.length,
        },
      };
    },
  };
}

// ============== 工具：添加 LLM 提供商 ==============

/**
 * 添加新的 LLM 提供商配置
 */
export function createAddLLMProviderTool(): AnyAgentTool {
  return {
    name: 'slide_add_llm_provider',
    description: '添加新的 LLM 提供商配置',
    parameters: {
      type: 'object',
      properties: {
        providerId: {
          type: 'string',
          description: '提供商 ID',
          enum: SUPPORTED_PROVIDER_IDS,
        },
        apiKey: {
          type: 'string',
          description: 'API Key',
        },
        baseUrl: {
          type: 'string',
          description: '自定义 Base URL（可选）',
        },
      },
      required: ['providerId'],
    },
    handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const providerId = args['providerId'] as string;
      const apiKey = args['apiKey'] as string | undefined;
      const baseUrl = args['baseUrl'] as string | undefined;

      if (!isSupportedProvider(providerId)) {
        return {
          success: false,
          error: `不支持的提供商 ID: ${providerId}。支持的提供商：${SUPPORTED_PROVIDER_IDS.join(', ')}`,
        };
      }

      const provider = getProvider(providerId);
      if (!provider) {
        return {
          success: false,
          error: `无法获取提供商配置：${providerId}`,
        };
      }

      // 保存到数据库配置
      const result = await llmDatabaseService.configureProvider({
        name: provider.id,
        displayName: provider.name,
        deploymentType: 'api',
        apiKey: apiKey || undefined,
        baseURL: baseUrl || provider.baseUrl,
        model: provider.defaultModelId,
        modelsSupported: provider.models.map(m => ({
          id: m.id,
          name: m.name,
          recommended: false,
          desc: `${m.contextWindow} ctx, $${m.cost?.input || 0}/1K input`,
        })),
        contextWindow: provider.models[0]?.contextWindow || 4096,
        supportsFunctionCall: provider.models.some(m => m.reasoning === false),
        supportsVision: provider.models.some(m => m.input?.includes('image')),
        inputCostPer1k: provider.models[0]?.cost?.input || 0,
        outputCostPer1k: provider.models[0]?.cost?.output || 0,
        enabled: true,
      });

      if (!result.success) {
        return { success: false, error: result.error || '保存提供商配置失败' };
      }

      return {
        success: true,
        data: {
          message: `已添加 ${provider.name} 提供商配置`,
          provider: {
            id: provider.id,
            name: provider.name,
            baseUrl: baseUrl || provider.baseUrl,
            apiKeyConfigured: !!apiKey,
            models: provider.models.length,
          },
        },
      };
    },
  };
}

// ============== 工具：更新 API Key ==============

/**
 * 更新 LLM 提供商的 API Key
 */
export function createUpdateAPIKeyTool(): AnyAgentTool {
  return {
    name: 'slide_update_api_key',
    description: '更新 LLM 提供商的 API Key',
    parameters: {
      type: 'object',
      properties: {
        providerId: {
          type: 'string',
          description: '提供商 ID',
          enum: SUPPORTED_PROVIDER_IDS,
        },
        apiKey: {
          type: 'string',
          description: '新的 API Key',
        },
      },
      required: ['providerId', 'apiKey'],
    },
    handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const providerId = args['providerId'] as string;
      const apiKey = args['apiKey'] as string;

      if (!isSupportedProvider(providerId)) {
        return {
          success: false,
          error: `不支持的提供商 ID: ${providerId}`,
        };
      }

      const provider = getProvider(providerId);
      if (!provider) {
        return {
          success: false,
          error: `找不到提供商：${providerId}`,
        };
      }

      // 更新数据库配置并加密存储
      const result = await llmDatabaseService.configureProvider({
        name: providerId,
        apiKey,
      });

      if (!result.success) {
        return { success: false, error: result.error || '更新 API Key 失败' };
      }

      return {
        success: true,
        data: {
          message: `已更新 ${provider.name} 的 API Key`,
          providerId: provider.id,
          apiKeyUpdated: true,
        },
      };
    },
  };
}

// ============== 工具：测试 LLM 连接 ==============

/**
 * 测试 LLM 提供商连接
 */
export function createTestLLMConnectionTool(): AnyAgentTool {
  return {
    name: 'slide_test_llm_connection',
    description: '测试 LLM 提供商的连接是否正常',
    parameters: {
      type: 'object',
      properties: {
        providerId: {
          type: 'string',
          description: '提供商 ID',
          enum: SUPPORTED_PROVIDER_IDS,
        },
        modelId: {
          type: 'string',
          description: '要测试的模型 ID（可选，使用默认模型）',
        },
      },
      required: ['providerId'],
    },
    handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const providerId = args['providerId'] as string;
      const modelId = args['modelId'] as string | undefined;

      if (!isSupportedProvider(providerId)) {
        return {
          success: false,
          error: `不支持的提供商 ID: ${providerId}`,
        };
      }

      const provider = getProvider(providerId);
      if (!provider) {
        return {
          success: false,
          error: `找不到提供商：${providerId}`,
        };
      }

      const testModel = modelId || provider.defaultModelId;

      // 获取数据库中的 API Key
      const apiKey = await llmDatabaseService.getProviderApiKey(providerId);
      if (!apiKey) {
        // 尝试从 provider-catalog 获取预设 Key
        return {
          success: false,
          error: `未配置 API Key，请先使用 slide_add_llm_provider 工具添加提供商配置`,
        };
      }

      // 实际调用 LLM API 测试连接
      try {
        if (provider.api === 'anthropic') {
          const { default: Anthropic } = await import('@anthropic-ai/sdk');
          const client = new Anthropic({ apiKey });
          await client.messages.create({
            model: testModel,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'hi' }],
          });
        } else {
          const { default: OpenAI } = await import('openai');
          const client = new OpenAI({
            apiKey,
            baseURL: provider.baseUrl || undefined,
          });
          await client.chat.completions.create({
            model: testModel,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 10,
          });
        }

        return {
          success: true,
          data: {
            message: `连接测试成功，模型: ${testModel}`,
            provider: {
              id: provider.id,
              name: provider.name,
              baseUrl: provider.baseUrl,
            },
            model: {
              id: testModel,
              configured: true,
            },
          },
        };
      } catch (error: any) {
        return {
          success: false,
          error: `连接测试失败: ${error.status ? `${error.status} ` : ''}${error.message || String(error)}`,
          data: {
            provider: {
              id: provider.id,
              name: provider.name,
            },
            model: testModel,
          },
        };
      }
    },
  };
}

// ============== 工具：查看用量统计 ==============

/**
 * 查看 LLM 用量统计
 */
export function createLLMUsageStatsTool(): AnyAgentTool {
  return {
    name: 'slide_llm_usage_stats',
    description: '查看 LLM 用量统计和成本',
    parameters: {
      type: 'object',
      properties: {
        providerId: {
          type: 'string',
          description: '提供商 ID（可选，筛选特定提供商）',
        },
        userId: {
          type: 'string',
          description: '用户 ID（可选，筛选特定用户）',
        },
        days: {
          type: 'number',
          description: '查看最近几天的数据',
          default: 7,
        },
      },
      required: [],
    },
    handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const providerId = args['providerId'] as string | undefined;
      const userId = args['userId'] as string | undefined;
      const days = (args['days'] as number) || 7;

      const startTime = Date.now() - (days * 24 * 60 * 60 * 1000);
      const endTime = Date.now();

      const stats = getUsageStats({
        providerId,
        userId,
        startTime,
        endTime,
      });

      return {
        success: true,
        data: {
          period: {
            days,
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
          },
          total: {
            tokens: stats.totalTokens,
            inputTokens: stats.totalInputTokens,
            outputTokens: stats.totalOutputTokens,
            costUsd: stats.totalCostUsd.toFixed(6),
            requestCount: stats.requestCount,
          },
          byProvider: stats.byProvider,
          byModel: stats.byModel,
        },
      };
    },
  };
}

// ============== 工具：清除用量记录 ==============

/**
 * 清除 LLM 用量记录
 */
export function createClearLLMUsageTool(): AnyAgentTool {
  return {
    name: 'slide_clear_llm_usage',
    description: '清除所有 LLM 用量记录（用于测试或重置）',
    parameters: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: '确认清除（必须为 true）',
        },
      },
      required: ['confirm'],
    },
    handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const confirm = args['confirm'] as boolean;

      if (!confirm) {
        return {
          success: false,
          error: '需要设置 confirm=true 来确认清除操作',
        };
      }

      memoryUsageStore.clear();

      return {
        success: true,
        data: {
          message: '已清除所有 LLM 用量记录',
        },
      };
    },
  };
}

// ============== 导出所有工具 ==============

/**
 * 创建所有 LLM 配置管理工具
 */
export function createAllLLMConfigTools(): AnyAgentTool[] {
  return [
    createListLLMProvidersTool(),
    createAddLLMProviderTool(),
    createUpdateAPIKeyTool(),
    createTestLLMConnectionTool(),
    createLLMUsageStatsTool(),
    createClearLLMUsageTool(),
  ];
}
