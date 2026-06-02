/**
 * DB-Ops 工具系统类型定义
 *
 * 复用上游 AnyAgentTool 接口设计模式
 * - 统一工具调用接口
 * - 支持链式调用和结果聚合
 * - 支持权限控制和审批流程
 */

// ============== 基础类型 ==============

/**
 * 工具参数 Schema 属性定义
 */
export interface ToolParameterProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: ToolParameterProperty;
}

/**
 * 工具参数 Schema
 */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

/**
 * 工具定义接口
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

// ============== 工具执行 ==============

/**
 * 工具执行结果
 */
export interface ToolResult<T = unknown> {
  /** 执行是否成功 */
  success: boolean;
  /** 结果数据 */
  data?: T;
  /** 错误信息 */
  error?: string;
  /** 错误代码 */
  errorCode?: string;
  /** 相关工具链结果（用于组合工具） */
  relatedResults?: ToolResult[];
  /** 摘要信息（用于快速预览） */
  summary?: string;
  /** 详细内容（用于完整展示） */
  details?: Record<string, unknown>;
}

/**
 * 工具处理器函数类型
 */
export type ToolHandler<T = unknown> = (
  args: Record<string, unknown>,
  context?: ToolExecutionContext
) => Promise<ToolResult<T>>;

/**
 * 工具执行上下文
 */
export interface ToolExecutionContext {
  /** 当前用户 ID */
  userId?: number;
  /** 当前用户角色 */
  userRole?: string;
  /** 当前会话 ID */
  sessionId?: string;
  /** 关联的数据库实例 ID */
  instanceId?: number;
  /** 调用其他工具的方法 */
  invokeTool?: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /** 生成摘要的辅助方法 */
  generateSummary?: (results: ToolResult[]) => string;
}

// ============== AnyAgentTool 接口（复用上游设计） ==============

/**
 * 统一工具接口（AnyAgentTool 风格）
 *
 * 设计原则：
 * 1. 与上游 AnyAgentTool 接口兼容
 * 2. 支持工具链式调用
 * 3. 支持权限控制
 * 4. 支持结果聚合
 */
export interface AnyAgentTool {
  /** 工具名称（唯一标识） */
  name: string;
  /** 工具描述 */
  description: string;
  /** 工具参数 Schema */
  parameters: ToolParameterSchema;
  /** 工具处理器 */
  handler: ToolHandler;
  /** 是否仅限 owner 调用（上游风格权限控制） */
  ownerOnly?: boolean;
  /** 工具分组（用于权限策略） */
  group?: string;
  /** 所属插件/模块（用于来源追踪） */
  pluginId?: string;
  /** 是否需要审批 */
  requiresApproval?: boolean;
  /** 危险等级（1-5，5 为最危险） */
  dangerLevel?: number;
}

// ============== 工具目录类型 ==============

/**
 * 工具注册表条目
 */
export interface ToolRegistryEntry {
  tool: AnyAgentTool;
  /** 注册时间 */
  registeredAt: Date;
  /** 调用次数统计 */
  callCount: number;
  /** 最后一次调用时间 */
  lastCalledAt?: Date;
  /** 平均执行时间（毫秒） */
  avgExecutionTime?: number;
}

/**
 * 工具分组
 */
export interface ToolGroup {
  /** 分组名称 */
  name: string;
  /** 分组描述 */
  description: string;
  /** 分组包含的工具名称列表 */
  tools: string[];
}

// ============== 工具策略类型（复用上游 tool-policy.ts） ==============

/**
 * 工具策略配置
 */
export interface ToolPolicy {
  /** 允许的工具列表（支持 * 通配符和 group: 前缀） */
  allow?: string[];
  /** 拒绝的工具列表 */
  deny?: string[];
}

/**
 * 用户角色权限映射
 */
export interface RoleToolPolicy {
  /** 角色名称 */
  roleName: string;
  /** 角色工具策略 */
  policy: ToolPolicy;
  /** 危险操作审批要求 */
  requiresApprovalFor?: string[];
}

// ============== 技能相关类型（为阶段二准备） ==============

/**
 * 技能命令分发规范
 */
export type SkillCommandDispatchSpec =
  | { kind: 'tool'; toolName: string; argMode?: 'raw' }
  | { kind: 'prompt'; promptTemplate: string };

/**
 * 技能命令规范
 */
export interface SkillCommandSpec {
  /** 命令名称（如 health-check） */
  name: string;
  /** 关联的技能名称 */
  skillName: string;
  /** 命令描述 */
  description: string;
  /** 分发规范 */
  dispatch?: SkillCommandDispatchSpec;
  /** 源文件路径 */
  sourceFilePath?: string;
}

// ============== 工具结果格式化 ==============

/**
 * 内容块类型
 */
export interface ContentBlock {
  type: 'text' | 'json' | 'markdown' | 'table';
  content: string | unknown;
}

/**
 * 格式化工具结果为可读文本
 */
export function formatToolResult<T>(result: ToolResult<T>): string {
  if (!result.success) {
    return `❌ 执行失败：${result.error}`;
  }

  if (result.summary) {
    return result.summary;
  }

  if (result.data && typeof result.data === 'object') {
    const dataObj = result.data as { content?: ContentBlock[] };
    if (Array.isArray(dataObj.content)) {
      return dataObj.content
        .filter(block => block.type === 'text')
        .map(block => String(block.content))
        .join('\n');
    }
  }

  return JSON.stringify(result.data, null, 2);
}
