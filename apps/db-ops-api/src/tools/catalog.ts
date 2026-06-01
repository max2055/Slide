/**
 * DB-Ops 工具目录管理
 *
 * 复用 OpenClaw 的 tool-catalog 和 tool-policy 设计模式
 * - 工具注册表管理
 * - 工具名称规范化
 * - 工具分组管理
 * - 工具发现机制
 */

import type {
  AnyAgentTool,
  ToolRegistryEntry,
  ToolGroup,
  ToolDefinition,
} from './types.js';

// ============== 工具名称规范化（复用 OpenClaw string-coerce.ts 模式） ==============

/**
 * 规范化工具名称
 * - 转小写
 * - 替换特殊字符为下划线
 * - 去除首尾下划线
 */
export function normalizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim();
}

/**
 * 规范化可选工具名称（允许空值）
 */
export function normalizeOptionalToolName(name: string | undefined | null): string {
  if (!name) return '';
  return normalizeToolName(name);
}

/**
 * 批量规范化工具名称列表
 */
export function normalizeToolList(names: string[]): string[] {
  return names.map(normalizeToolName).filter(name => name.length > 0);
}

// ============== 工具注册表 ==============

/**
 * 工具注册表管理类
 *
 * 单例模式，全局唯一工具注册表
 */
class ToolCatalog {
  private tools: Map<string, ToolRegistryEntry> = new Map();
  private groups: Map<string, ToolGroup> = new Map();
  private initialized = false;

  /**
   * 注册单个工具
   */
  register(tool: AnyAgentTool): void {
    const normalizedName = normalizeToolName(tool.name);

    if (this.tools.has(normalizedName)) {
      console.warn(`[ToolCatalog] 工具已存在，跳过注册：${normalizedName}`);
      return;
    }

    this.tools.set(normalizedName, {
      tool,
      registeredAt: new Date(),
      callCount: 0,
    });

    // 如果工具有分组，添加到分组
    if (tool.group) {
      this.addToGroup(tool.group, normalizedName);
    }

    console.log(`[ToolCatalog] 工具注册成功：${normalizedName}`);
  }

  /**
   * 批量注册工具
   */
  registerAll(tools: AnyAgentTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * 获取工具
   */
  get(name: string): AnyAgentTool | undefined {
    const normalizedName = normalizeToolName(name);
    const entry = this.tools.get(normalizedName);
    return entry?.tool;
  }

  /**
   * 获取所有工具
   */
  getAll(): AnyAgentTool[] {
    return Array.from(this.tools.values()).map(entry => entry.tool);
  }

  /**
   * 获取工具名称列表
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    const normalizedName = normalizeToolName(name);
    return this.tools.has(normalizedName);
  }

  /**
   * 添加工具到分组
   */
  addToGroup(groupName: string, toolName: string): void {
    const normalizedGroup = normalizeToolName(groupName);
    const normalizedTool = normalizeToolName(toolName);

    let group = this.groups.get(normalizedGroup);
    if (!group) {
      group = {
        name: normalizedGroup,
        description: normalizedGroup,
        tools: [],
      };
      this.groups.set(normalizedGroup, group);
    }

    if (!group.tools.includes(normalizedTool)) {
      group.tools.push(normalizedTool);
    }
  }

  /**
   * 创建工具分组
   */
  createGroup(group: ToolGroup): void {
    const normalizedName = normalizeToolName(group.name);
    this.groups.set(normalizedName, {
      ...group,
      name: normalizedName,
      tools: normalizeToolList(group.tools),
    });
  }

  /**
   * 获取分组
   */
  getGroup(name: string): ToolGroup | undefined {
    const normalizedName = normalizeToolName(name);
    return this.groups.get(normalizedName);
  }

  /**
   * 获取所有分组
   */
  getGroups(): ToolGroup[] {
    return Array.from(this.groups.values());
  }

  /**
   * 获取分组下的所有工具名称（展开嵌套分组）
   */
  expandGroup(name: string): string[] {
    const group = this.getGroup(name);
    if (!group) return [];

    const result: string[] = [];
    const visited = new Set<string>();

    const expand = (groupName: string) => {
      if (visited.has(groupName)) return;
      visited.add(groupName);

      const g = this.getGroup(groupName);
      if (!g) return;

      for (const toolName of g.tools) {
        // 检查是否是嵌套分组引用
        if (this.groups.has(toolName)) {
          expand(toolName);
        } else {
          result.push(toolName);
        }
      }
    };

    expand(normalizeToolName(name));
    return result;
  }

  /**
   * 记录工具调用
   */
  recordToolCall(name: string, executionTimeMs: number): void {
    const normalizedName = normalizeToolName(name);
    const entry = this.tools.get(normalizedName);
    if (entry) {
      entry.callCount++;
      entry.lastCalledAt = new Date();
      // 计算移动平均执行时间
      const prevAvg = entry.avgExecutionTime || 0;
      const count = entry.callCount;
      entry.avgExecutionTime = prevAvg + (executionTimeMs - prevAvg) / count;
    }
  }

  /**
   * 获取工具统计信息
   */
  getToolStats(name: string): ToolRegistryEntry | undefined {
    const normalizedName = normalizeToolName(name);
    return this.tools.get(normalizedName);
  }

  /**
   * 清空注册表（用于测试）
   */
  clear(): void {
    this.tools.clear();
    this.groups.clear();
  }

  /**
   * 导出工具定义为 OpenAI 兼容格式（用于 LLM Tool Calling）
   */
  exportToOpenAIFormat(): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> {
    return this.getAll().map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Record<string, unknown>,
      },
    }));
  }

  /**
   * 导出工具定义列表（用于系统提示）
   */
  exportToolDescriptions(): string {
    const tools = this.getAll();
    return tools
      .map(
        tool =>
          `- **${tool.name}**: ${tool.description}\n  参数：${JSON.stringify(tool.parameters.properties, null, 2)}`,
      )
      .join('\n\n');
  }
}

// ============== 工具发现机制 ==============

/**
 * 从模块目录自动发现工具
 *
 * @param modulePath 模块路径（如 './generated/slide-self-mgmt'）
 * @returns 工具数组
 */
export async function discoverToolsFromModule(
  modulePath: string,
): Promise<AnyAgentTool[]> {
  try {
    const module = await import(modulePath);
    const tools: AnyAgentTool[] = [];

    // 查找导出的工具
    if (module.generatedTools && Array.isArray(module.generatedTools)) {
      tools.push(...module.generatedTools);
    }

    // 查找以 Tool 结尾的导出
    for (const [key, value] of Object.entries(module) as Array<[string, unknown]>) {
      if (key.endsWith('Tool') && typeof value === 'object' && value !== null && 'name' in value) {
        tools.push(value as AnyAgentTool);
      }
    }

    return tools;
  } catch (error: unknown) {
    console.error(`[ToolCatalog] 工具发现失败 (${modulePath}):`, error);
    return [];
  }
}

/**
 * 从目录自动发现所有工具模块
 *
 * @param dirPath 目录路径
 * @param pattern 文件匹配模式（如 '*.ts' 或 '*.js'）
 */
export async function discoverToolsFromDirectory(
  dirPath: string,
  pattern = '*.ts',
): Promise<AnyAgentTool[]> {
  // 注意：Node.js 运行时无法直接进行文件系统 glob
  // 这个函数主要用于构建时工具生成
  console.log(
    `[ToolCatalog] 目录工具发现：${dirPath} (pattern: ${pattern}) - 需要构建时支持`,
  );
  return [];
}

// ============== 全局单例 ==============

/**
 * 全局工具注册表实例
 *
 * 使用方式：
 * ```typescript
 * import { toolCatalog } from './catalog.js';
 *
 * // 注册工具
 * toolCatalog.register(myTool);
 *
 * // 获取工具
 * const tool = toolCatalog.get('my_tool');
 * ```
 */
export const toolCatalog = new ToolCatalog();

// ============== 预定义工具分组 ==============

/**
 * 注册预定义的 Slide 运维工具分组
 */
export function registerPredefinedToolGroups(): void {
  const groups: ToolGroup[] = [
    {
      name: 'slide_self_mgmt',
      description: 'Slide 自管理工具',
      tools: [],
    },
    {
      name: 'db_ops',
      description: '数据库运维工具',
      tools: [],
    },
    {
      name: 'llm_ops',
      description: 'LLM 配置管理工具',
      tools: [],
    },
    {
      name: 'health_check',
      description: '健康检查工具',
      tools: [],
    },
    {
      name: 'performance',
      description: '性能分析工具',
      tools: [],
    },
    {
      name: 'diagnosis',
      description: '故障诊断工具',
      tools: [],
    },
    {
      name: 'admin_only',
      description: '仅管理员可用工具',
      tools: [],
    },
  ];

  for (const group of groups) {
    toolCatalog.createGroup(group);
  }

  console.log('[ToolCatalog] 已注册预定义工具分组');
}
