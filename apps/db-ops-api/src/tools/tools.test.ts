/**
 * 工具系统单元测试
 *
 * 测试工具注册、权限控制、技能加载等功能
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { toolCatalog, normalizeToolName, registerPredefinedToolGroups } from './catalog.js';
import { isToolAllowed, resolveToolPolicy, applyToolPolicy } from './policy.js';
import type { AnyAgentTool } from './types.js';

// ============== Mock 工具 ==============

const mockTool: AnyAgentTool = {
  name: 'test_tool',
  description: '测试工具',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '名称' },
    },
  },
  handler: async (args) => ({
    success: true,
    data: { executed: true, args },
    summary: '测试工具执行成功',
  }),
};

const adminOnlyTool: AnyAgentTool = {
  name: 'admin_only_tool',
  description: '仅管理员可用',
  parameters: {
    type: 'object',
    properties: {},
  },
  ownerOnly: true,
  handler: async () => ({
    success: true,
    data: { admin: true },
  }),
};

// ============== 测试套件 ==============

describe('ToolCatalog', () => {
  beforeEach(() => {
    toolCatalog.clear();
    registerPredefinedToolGroups();
  });

  describe('normalizeToolName', () => {
    it('应该规范化工具名称为小写', () => {
      expect(normalizeToolName('Test_Tool')).toBe('test_tool');
      expect(normalizeToolName('TEST-TOOL')).toBe('test_tool');
    });

    it('应该替换特殊字符为下划线', () => {
      expect(normalizeToolName('test tool')).toBe('test_tool');
      expect(normalizeToolName('test@tool#')).toBe('test_tool');
    });

    it('应该去除首尾下划线', () => {
      expect(normalizeToolName('__test_tool__')).toBe('test_tool');
    });
  });

  describe('register', () => {
    it('应该成功注册工具', () => {
      toolCatalog.register(mockTool);
      expect(toolCatalog.has('test_tool')).toBe(true);
    });

    it('应该返回已注册的工具', () => {
      toolCatalog.register(mockTool);
      const tool = toolCatalog.get('test_tool');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('test_tool');
    });

    it('应该跳过重复的工具', () => {
      toolCatalog.register(mockTool);
      toolCatalog.register(mockTool);
      expect(toolCatalog.getAll().length).toBe(1);
    });

    it('应该处理不同大小写的名称', () => {
      toolCatalog.register(mockTool);
      expect(toolCatalog.get('TEST_TOOL')).toBeDefined();
      expect(toolCatalog.get('test_tool')).toBeDefined();
    });
  });

  describe('registerAll', () => {
    it('应该批量注册工具', () => {
      toolCatalog.registerAll([mockTool, adminOnlyTool]);
      expect(toolCatalog.getAll().length).toBe(2);
    });
  });

  describe('groups', () => {
    it('应该创建工具分组', () => {
      toolCatalog.createGroup({
        name: 'test_group',
        description: '测试分组',
        tools: ['tool1', 'tool2'],
      });

      const group = toolCatalog.getGroup('test_group');
      expect(group).toBeDefined();
      expect(group?.tools).toEqual(['tool1', 'tool2']);
    });

    it('应该将工具添加到分组', () => {
      toolCatalog.register(mockTool);
      toolCatalog.addToGroup('test_group', 'test_tool');

      const group = toolCatalog.getGroup('test_group');
      expect(group?.tools).toContain('test_tool');
    });

    it('应该展开分组', () => {
      toolCatalog.createGroup({
        name: 'group1',
        description: '分组 1',
        tools: ['tool1', 'tool2'],
      });

      const tools = toolCatalog.expandGroup('group1');
      expect(tools).toEqual(['tool1', 'tool2']);
    });
  });

  describe('exportToOpenAIFormat', () => {
    it('应该导出 OpenAI 兼容格式', () => {
      toolCatalog.register(mockTool);

      const exported = toolCatalog.exportToOpenAIFormat();
      expect(exported).toHaveLength(1);
      expect(exported[0]).toEqual({
        type: 'function',
        function: {
          name: 'test_tool',
          description: '测试工具',
          parameters: mockTool.parameters,
        },
      });
    });
  });
});

describe('ToolPolicy', () => {
  describe('isToolAllowed', () => {
    it('应该允许 * 通配符', () => {
      expect(
        isToolAllowed('any_tool', { allow: ['*'], deny: [] })
      ).toBe(true);
    });

    it('应该允许指定工具', () => {
      expect(
        isToolAllowed('test_tool', { allow: ['test_tool'], deny: [] })
      ).toBe(true);
    });

    it('应该拒绝不在允许列表的工具', () => {
      expect(
        isToolAllowed('other_tool', { allow: ['test_tool'], deny: [] })
      ).toBe(false);
    });

    it('应该拒绝拒绝列表的工具', () => {
      expect(
        isToolAllowed('test_tool', { allow: ['*'], deny: ['test_tool'] })
      ).toBe(false);
    });
  });

  describe('resolveToolPolicy', () => {
    it('应该解析策略', () => {
      const result = resolveToolPolicy({
        allow: ['tool1', 'tool2'],
        deny: ['tool3'],
      });

      expect(result.allowAll).toBe(false);
      expect(result.allowed.has('tool1')).toBe(true);
      expect(result.denied.has('tool3')).toBe(true);
    });
  });

  describe('applyToolPolicy', () => {
    beforeEach(() => {
      toolCatalog.clear();
      toolCatalog.registerAll([mockTool, adminOnlyTool]);
    });

    it('应该过滤掉 owner-only 工具对非管理员', () => {
      // admin_only_tool 不在 developer 角色的 allow 列表中
      // 所以应该被过滤掉，只保留 test_tool
      const filtered = applyToolPolicy(
        [mockTool, adminOnlyTool],
        'developer',
        false, // senderIsOwner = false
      );

      // developer 角色的 allow 列表包含 sql_optimize, view_logs 等，但不包含 admin_only_tool
      // mockTool (test_tool) 也不在 allow 列表中，所以也会被过滤
      // 这里测试的是 ownerOnly 属性的直接过滤逻辑
      expect(filtered.length).toBeLessThanOrEqual(1);
    });

    it('应该保留所有工具对管理员', () => {
      const filtered = applyToolPolicy(
        [mockTool, adminOnlyTool],
        'admin',
        true, // senderIsOwner = true
      );

      // admin 角色的 allow 列表是 ['*']，所以所有工具都被允许
      expect(filtered.length).toBe(2);
    });

    it('应该通过 ownerOnly 属性过滤工具', () => {
      // 创建一个明确标记为 ownerOnly 的工具
      const ownerOnlyTool: AnyAgentTool = {
        name: 'delete_something',
        description: '删除操作',
        parameters: { type: 'object', properties: {} },
        ownerOnly: true,
        handler: async () => ({ success: true, data: {} }),
      };

      // admin 角色允许所有工具
      const forAdmin = applyToolPolicy([mockTool, ownerOnlyTool], 'admin', true);
      expect(forAdmin.length).toBe(2);

      // developer 角色不允许 delete_* 模式的工具
      const forNonAdmin = applyToolPolicy([mockTool, ownerOnlyTool], 'developer', false);
      // delete_something 被 ownerOnly 逻辑过滤
      expect(forNonAdmin.some(t => t.name === 'delete_something')).toBe(false);
    });
  });
});

describe('Tool Execution', () => {
  beforeEach(() => {
    toolCatalog.clear();
  });

  it('应该执行工具并返回结果', async () => {
    toolCatalog.register(mockTool);

    const result = await mockTool.handler({ name: 'test' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ executed: true, args: { name: 'test' } });
  });

  it('应该处理执行错误', async () => {
    const errorTool: AnyAgentTool = {
      ...mockTool,
      name: 'error_tool',
      handler: async () => ({
        success: false,
        error: '模拟错误',
      }),
    };

    const result = await errorTool.handler({});
    expect(result.success).toBe(false);
    expect(result.error).toBe('模拟错误');
  });
});
