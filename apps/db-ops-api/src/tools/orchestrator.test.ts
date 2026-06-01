/**
 * 工具编排器单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolOrchestrator, orchestrator, createDefaultContext } from './orchestrator.js';
import { toolCatalog } from './catalog.js';
import type { AnyAgentTool } from './types.js';

// ============== Mock 工具 ==============

const mockTool1: AnyAgentTool = {
  name: 'mock_tool_1',
  description: '模拟工具 1',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'string', description: '值' },
    },
  },
  handler: async (args) => ({
    success: true,
    data: { tool: 'mock_tool_1', ...args },
    summary: '工具 1 执行成功',
  }),
};

const mockTool2: AnyAgentTool = {
  name: 'mock_tool_2',
  description: '模拟工具 2',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'string', description: '值' },
    },
  },
  handler: async (args) => ({
    success: true,
    data: { tool: 'mock_tool_2', ...args },
    summary: '工具 2 执行成功',
  }),
};

const errorTool: AnyAgentTool = {
  name: 'error_tool',
  description: '总是失败的工具',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => ({
    success: false,
    error: '模拟错误',
    errorCode: 'SIMULATED_ERROR',
  }),
};

const conditionalTool: AnyAgentTool = {
  name: 'conditional_tool',
  description: '条件成功工具',
  parameters: {
    type: 'object',
    properties: {
      shouldFail: { type: 'boolean', description: '是否失败' },
    },
  },
  handler: async (args) => ({
    success: !args.shouldFail,
    data: { executed: true },
    error: args.shouldFail ? '条件失败' : undefined,
  }),
};

// ============== 测试套件 ==============

describe('ToolOrchestrator', () => {
  beforeEach(() => {
    toolCatalog.clear();
    toolCatalog.registerAll([mockTool1, mockTool2, errorTool, conditionalTool]);
  });

  describe('execute', () => {
    it('应该顺序执行多个工具', async () => {
      const orchestrator = new ToolOrchestrator();
      const context = createDefaultContext();

      const result = await orchestrator.execute([
        { name: 'step1', toolName: 'mock_tool_1', args: { value: 'test1' } },
        { name: 'step2', toolName: 'mock_tool_2', args: { value: 'test2' } },
      ], context);

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].success).toBe(true);
      expect(result.steps[1].success).toBe(true);
      expect(result.steps[0].result.data).toEqual({ tool: 'mock_tool_1', value: 'test1' });
      expect(result.steps[1].result.data).toEqual({ tool: 'mock_tool_2', value: 'test2' });
    });

    it('应该在失败时快速失败', async () => {
      const orchestrator = new ToolOrchestrator();
      const context = createDefaultContext();

      const result = await orchestrator.execute([
        { name: 'step1', toolName: 'mock_tool_1', args: {} },
        { name: 'step2', toolName: 'error_tool', args: {} },
        { name: 'step3', toolName: 'mock_tool_2', args: {} },
      ], context, { failureStrategy: 'fail-fast' });

      expect(result.success).toBe(false);
      expect(result.steps).toHaveLength(2); // 只执行了前两步
      expect(result.steps[0].success).toBe(true);
      expect(result.steps[1].success).toBe(false);
    });

    it('应该继续执行即使有失败（continue 模式）', async () => {
      const orchestrator = new ToolOrchestrator();
      const context = createDefaultContext();

      const result = await orchestrator.execute([
        { name: 'step1', toolName: 'mock_tool_1', args: {} },
        { name: 'step2', toolName: 'error_tool', args: {} },
        { name: 'step3', toolName: 'mock_tool_2', args: {} },
      ], context, { failureStrategy: 'continue' });

      expect(result.success).toBe(false);
      expect(result.steps).toHaveLength(3);
      expect(result.steps[1].success).toBe(false);
      expect(result.steps[2].success).toBe(true);
    });

    it('应该处理可选步骤', async () => {
      const orchestrator = new ToolOrchestrator();
      const context = createDefaultContext();

      const result = await orchestrator.execute([
        { name: 'step1', toolName: 'mock_tool_1', args: {} },
        { name: 'step2', toolName: 'error_tool', args: {}, optional: true },
        { name: 'step3', toolName: 'mock_tool_2', args: {} },
      ], context);

      expect(result.success).toBe(false); // 因为有步骤失败
      expect(result.steps).toHaveLength(3);
      expect(result.steps[2].success).toBe(true); // 后续步骤仍执行
    });

    it('应该支持动态参数（基于前序结果）', async () => {
      const orchestrator = new ToolOrchestrator();
      const context = createDefaultContext();

      const result = await orchestrator.execute([
        { name: 'step1', toolName: 'mock_tool_1', args: { value: 'initial' } },
        {
          name: 'step2',
          toolName: 'mock_tool_2',
          args: (previousResults) => ({
            value: `based_on_${(previousResults[0].result.data as { tool: string }).tool}`,
          }),
        },
      ], context);

      expect(result.success).toBe(true);
      expect((result.steps[1].result.data as { tool: string; value: string }).value).toBe('based_on_mock_tool_1');
    });

    it('应该处理超时', async () => {
      const orchestrator = new ToolOrchestrator();
      const context = createDefaultContext();

      // 创建一个慢速工具
      const slowTool: AnyAgentTool = {
        name: 'slow_tool',
        description: '慢速工具',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return { success: true, data: { slow: true } };
        },
      };
      toolCatalog.register(slowTool);

      const result = await orchestrator.execute([
        { name: 'step1', toolName: 'slow_tool', args: {} },
        { name: 'step2', toolName: 'slow_tool', args: {} },
      ], context, { timeout: 50 });

      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].success).toBe(true); // 第一步完成
      expect(result.steps[1].success).toBe(false); // 第二步超时
      expect(result.steps[1].error).toContain('超时');
    });

    it('应该生成自定义摘要', async () => {
      const orchestrator = new ToolOrchestrator();
      const context: typeof context = {
        ...createDefaultContext(),
        generateSummary: (results) => {
          const successCount = results.filter(r => r.success).length;
          return `自定义摘要：成功 ${successCount}/${results.length}`;
        },
      };

      const result = await orchestrator.execute([
        { name: 'step1', toolName: 'mock_tool_1', args: {} },
        { name: 'step2', toolName: 'mock_tool_2', args: {} },
      ], context);

      expect(result.summary).toContain('自定义摘要');
    });
  });

  describe('extractStepData', () => {
    it('应该提取指定步骤的数据', async () => {
      const orchestrator = new ToolOrchestrator();
      const context = createDefaultContext();

      const result = await orchestrator.execute([
        { name: 'get_data', toolName: 'mock_tool_1', args: { value: 'test' } },
        { name: 'process', toolName: 'mock_tool_2', args: {} },
      ], context);

      const data = orchestrator.extractStepData<{ tool: string; value: string }>(result, 'get_data');
      expect(data).toEqual({ tool: 'mock_tool_1', value: 'test' });
    });

    it('应该返回 undefined 如果步骤失败', async () => {
      const orchestrator = new ToolOrchestrator();
      const context = createDefaultContext();

      const result = await orchestrator.execute([
        { name: 'failing_step', toolName: 'error_tool', args: {} },
      ], context);

      const data = orchestrator.extractStepData(result, 'failing_step');
      expect(data).toBeUndefined();
    });
  });

  describe('aggregateResults', () => {
    it('应该聚合结果', async () => {
      const orchestrator = new ToolOrchestrator();
      const context = createDefaultContext();

      const result = await orchestrator.execute([
        { name: 'step1', toolName: 'mock_tool_1', args: {} },
        { name: 'step2', toolName: 'mock_tool_2', args: {} },
      ], context);

      const aggregated = orchestrator.aggregateResults(result.steps, (results) => {
        return {
          totalSteps: results.length,
          successCount: results.filter(r => r.success).length,
          totalTime: results.reduce((sum, r) => sum + r.executionTime, 0),
        };
      });

      expect(aggregated.totalSteps).toBe(2);
      expect(aggregated.successCount).toBe(2);
    });
  });
});

describe('orchestrator singleton', () => {
  it('应该导出单例', () => {
    expect(orchestrator).toBeInstanceOf(ToolOrchestrator);
  });
});

describe('createDefaultContext', () => {
  it('应该创建默认上下文', () => {
    const context = createDefaultContext();
    expect(context.invokeTool).toBeDefined();
    expect(context.generateSummary).toBeDefined();
  });

  it('应该能够调用 invokeTool', async () => {
    const context = createDefaultContext();
    toolCatalog.register(mockTool1);

    const result = await context.invokeTool('mock_tool_1', { value: 'test' });
    expect(result.success).toBe(true);
  });

  it('应该处理不存在的工具', async () => {
    const context = createDefaultContext();

    const result = await context.invokeTool('non_existent_tool', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('工具不存在');
  });
});
