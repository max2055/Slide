/**
 * LLM 配置管理工具单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createListLLMProvidersTool,
  createAddLLMProviderTool,
  createUpdateAPIKeyTool,
  createTestLLMConnectionTool,
  createLLMUsageStatsTool,
  createClearLLMUsageTool,
  createAllLLMConfigTools,
} from './index.js';
import { memoryUsageStore, recordUsage } from '../../../llm/llm-usage-tracker.js';

describe('createListLLMProvidersTool', () => {
  const tool = createListLLMProvidersTool();

  it('应该列出所有提供商', async () => {
    const result = await tool.handler({});

    expect(result.success).toBe(true);
    expect(result.data?.total).toBeGreaterThanOrEqual(5);
    expect(result.data?.providers).toBeDefined();
  });

  it('应该包含详细信息当 includeDetails=true', async () => {
    const result = await tool.handler({ includeDetails: true });

    expect(result.success).toBe(true);
    expect(result.data?.providers[0]?.models).toBeDefined();
  });

  it('应该包含 bailian 提供商', async () => {
    const result = await tool.handler({});

    const bailian = result.data?.providers.find((p: any) => p.id === 'bailian');
    expect(bailian).toBeDefined();
    expect(bailian?.name).toBe('阿里云百炼');
  });
});

describe('createAddLLMProviderTool', () => {
  const tool = createAddLLMProviderTool();

  it('应该添加提供商配置', async () => {
    const result = await tool.handler({
      providerId: 'bailian',
      apiKey: 'test-api-key',
    });

    expect(result.success).toBe(true);
    expect(result.data?.message).toContain('阿里云百炼');
  });

  it('应该拒绝不支持的提供商', async () => {
    const result = await tool.handler({
      providerId: 'unknown-provider',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('不支持');
  });

  it('应该要求 providerId 参数', async () => {
    const result = await tool.handler({});

    // 工具应该处理缺失参数的情况
    expect(result.success).toBe(false);
  });
});

describe('createUpdateAPIKeyTool', () => {
  const tool = createUpdateAPIKeyTool();

  it('应该更新 API Key', async () => {
    const result = await tool.handler({
      providerId: 'deepseek',
      apiKey: 'new-api-key',
    });

    expect(result.success).toBe(true);
    expect(result.data?.message).toContain('DeepSeek');
    expect(result.data?.apiKeyUpdated).toBe(true);
  });

  it('应该拒绝不支持的提供商', async () => {
    const result = await tool.handler({
      providerId: 'unknown',
      apiKey: 'test',
    });

    expect(result.success).toBe(false);
  });
});

describe('createTestLLMConnectionTool', () => {
  const tool = createTestLLMConnectionTool();

  it('应该测试连接', async () => {
    const result = await tool.handler({
      providerId: 'bailian',
    });

    expect(result.success).toBe(true);
    expect(result.data?.provider).toBeDefined();
  });

  it('应该测试指定模型', async () => {
    const result = await tool.handler({
      providerId: 'bailian',
      modelId: 'qwen-plus',
    });

    expect(result.success).toBe(true);
    expect(result.data?.model?.id).toBe('qwen-plus');
  });

  it('应该拒绝不支持的提供商', async () => {
    const result = await tool.handler({
      providerId: 'unknown',
    });

    expect(result.success).toBe(false);
  });
});

describe('createLLMUsageStatsTool', () => {
  const tool = createLLMUsageStatsTool();

  beforeEach(() => {
    memoryUsageStore.clear();
  });

  it('应该获取用量统计', async () => {
    recordUsage({
      providerId: 'bailian',
      modelId: 'qwen-plus',
      inputTokens: 1000,
      outputTokens: 500,
      costRates: { input: 0.0005, output: 0.002 },
      userId: 'user1',
    });

    const result = await tool.handler({ days: 7 });

    expect(result.success).toBe(true);
    expect(result.data?.total.requestCount).toBe(1);
    expect(result.data?.total.tokens).toBe(1500);
  });

  it('应该按提供商过滤', async () => {
    recordUsage({
      providerId: 'bailian',
      modelId: 'qwen-plus',
      inputTokens: 1000,
      outputTokens: 500,
      costRates: { input: 0.0005, output: 0.002 },
    });

    recordUsage({
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      inputTokens: 500,
      outputTokens: 250,
      costRates: { input: 0.00039, output: 0.0016 },
    });

    const result = await tool.handler({ providerId: 'bailian', days: 7 });

    expect(result.success).toBe(true);
    expect(result.data?.total.requestCount).toBe(1);
  });

  it('应该返回时间段信息', async () => {
    const result = await tool.handler({ days: 30 });

    expect(result.success).toBe(true);
    expect(result.data?.period.days).toBe(30);
  });
});

describe('createClearLLMUsageTool', () => {
  const tool = createClearLLMUsageTool();

  beforeEach(() => {
    memoryUsageStore.clear();
  });

  it('应该清除用量记录', async () => {
    recordUsage({
      providerId: 'bailian',
      modelId: 'qwen-plus',
      inputTokens: 1000,
      outputTokens: 500,
      costRates: { input: 0.0005, output: 0.002 },
    });

    const clearResult = await tool.handler({ confirm: true });

    expect(clearResult.success).toBe(true);

    const statsResult = await createLLMUsageStatsTool().handler({ days: 7 });
    expect(statsResult.data?.total.requestCount).toBe(0);
  });

  it('应该要求确认', async () => {
    const result = await tool.handler({ confirm: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain('确认');
  });
});

describe('createAllLLMConfigTools', () => {
  it('应该创建所有工具', () => {
    const tools = createAllLLMConfigTools();

    expect(tools.length).toBe(6);
    expect(tools.map(t => t.name)).toEqual([
      'slide_list_llm_providers',
      'slide_add_llm_provider',
      'slide_update_api_key',
      'slide_test_llm_connection',
      'slide_llm_usage_stats',
      'slide_clear_llm_usage',
    ]);
  });
});
