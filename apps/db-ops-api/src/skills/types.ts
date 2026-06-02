/**
 * DB-Ops 技能系统类型定义
 *
 * 复用上游技能设计模式：
 * - SKILL.md 文件 + frontmatter 元数据
 * - 技能命令绑定
 * - 工具分发策略
 */

import type { AnyAgentTool, ToolDefinition } from '../tools/types.js';

// ============== 技能基础类型 ==============

/**
 * 技能定义（复用上游 Skill 接口）
 */
export interface Skill {
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 技能文件路径 */
  filePath: string;
  /** 技能来源 */
  source?: string;
}

/**
 * 技能来源范围
 */
export type SourceScope = 'user' | 'project' | 'temporary';

/**
 * 技能来源类型
 */
export type SourceOrigin = 'package' | 'top-level';

/**
 * 技能来源信息
 */
export interface SourceInfo {
  /** 文件路径 */
  path: string;
  /** 源代码内容 */
  source: string;
  /** 来源范围 */
  scope?: SourceScope;
  /** 来源类型 */
  origin?: SourceOrigin;
  /** 基础目录 */
  baseDir?: string;
}

/**
 * 创建合成来源信息
 */
export function createSyntheticSourceInfo(
  path: string,
  options: {
    source: string;
    scope?: SourceScope;
    origin?: SourceOrigin;
    baseDir?: string;
  },
): SourceInfo {
  return {
    path,
    source: options.source,
    scope: options.scope ?? 'temporary',
    origin: options.origin ?? 'top-level',
    baseDir: options.baseDir,
  };
}

// ============== Frontmatter 类型 ==============

/**
 * 技能 Frontmatter 元数据（解析后的）
 */
export interface ParsedSkillFrontmatter {
  /** 技能名称（覆盖 name） */
  name?: string;
  /** 技能描述（覆盖 description） */
  description?: string;
  /** 命令分发类型 */
  'command-dispatch'?: string;
  'command_dispatch'?: string;
  /** 命令绑定的工具名称 */
  'command-tool'?: string;
  'command_tool'?: string;
  /** 命令参数模式 */
  'command-arg-mode'?: string;
  'command_arg_mode'?: string;
  /** 是否用户可调用 */
  'user-invocable'?: boolean;
  'user_invocable'?: boolean;
  /** 是否禁用模型调用 */
  'disable-model-invocation'?: boolean;
  'disable_model_invocation'?: boolean;
  /** 是否包含在运行时注册表 */
  'include-in-runtime-registry'?: boolean;
  'include_in_runtime_registry'?: boolean;
  /** 是否包含在可用技能提示中 */
  'include-in-available-skills-prompt'?: boolean;
  'include_in_available_skills_prompt'?: boolean;
  /** 主要环境 */
  'primary-env'?: string;
  'primary_env'?: string;
  /** 表情符号 */
  emoji?: string;
  /** 主页 */
  homepage?: string;
  /** 支持的操作系统 */
  os?: string[];
  /** 依赖要求 */
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  /** 是否始终启用 */
  always?: boolean | string;
  /** 技能键 */
  skillKey?: string;
  /** Prompt 模板 */
  'prompt-template'?: string;
  'prompt_template'?: string;
  /** 版本号 */
  version?: number | string;
}

/**
 * 技能元数据（legacy 命名）
 */
export interface SlideSkillMetadata {
  /** 是否始终启用 */
  always?: boolean;
  /** 技能键 */
  skillKey?: string;
  /** 主要环境 */
  primaryEnv?: string;
  /** 表情符号 */
  emoji?: string;
  /** 主页 */
  homepage?: string;
  /** 支持的操作系统 */
  os?: string[];
  /** 依赖要求 */
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  /** 安装规范 */
  install?: SkillInstallSpec[];
}

/**
 * 技能安装规范
 */
export type SkillInstallSpec = {
  id?: string;
  kind: 'brew' | 'node' | 'go' | 'uv' | 'download';
  label?: string;
  bins?: string[];
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
};

// ============== 技能调用策略 ==============

/**
 * 技能调用策略
 */
export type SkillInvocationPolicy = {
  /** 是否用户可调用 */
  userInvocable: boolean;
  /** 是否禁用模型调用 */
  disableModelInvocation: boolean;
};

/**
 * 技能暴露配置
 */
export type SkillExposure = {
  /** 是否包含在运行时注册表 */
  includeInRuntimeRegistry: boolean;
  /** 是否包含在可用技能提示中 */
  includeInAvailableSkillsPrompt: boolean;
  /** 是否用户可调用 */
  userInvocable: boolean;
};

// ============== 技能命令规范 ==============

/**
 * 技能命令分发规范
 */
export type SkillCommandDispatchSpec =
  /** 工具分发模式 */
  | {
      kind: 'tool';
      /** 工具名称 */
      toolName: string;
      /** 参数模式：raw 表示不解析，直接透传 */
      argMode?: 'raw';
    }
  /** Prompt 模板模式 */
  | {
      kind: 'prompt';
      /** Prompt 模板 */
      promptTemplate: string;
    };

/**
 * 技能命令规范
 */
export type SkillCommandSpec = {
  /** 命令名称（如 health-check） */
  name: string;
  /** 关联的技能名称 */
  skillName: string;
  /** 命令描述 */
  description: string;
  /** 分发规范 */
  dispatch?: SkillCommandDispatchSpec;
  /** Prompt 模板（用于 bundle-backed 命令） */
  promptTemplate?: string;
  /** 源文件路径（用于 bundle-backed 命令） */
  sourceFilePath?: string;
};

// ============== 技能条目 ==============

/**
 * 技能条目（完整技能信息）
 */
export type SkillEntry = {
  /** 技能定义 */
  skill: Skill;
  /** 解析后的 frontmatter */
  frontmatter: ParsedSkillFrontmatter;
  /** 元数据（legacy 命名） */
  metadata?: SlideSkillMetadata;
  /** 调用策略 */
  invocation?: SkillInvocationPolicy;
  /** 暴露配置 */
  exposure?: SkillExposure;
};

/**
 * 技能资格上下文
 */
export type SkillEligibilityContext = {
  remote?: {
    platforms: string[];
    hasBin: (bin: string) => boolean;
    hasAnyBin: (bins: string[]) => boolean;
    note?: string;
  };
};

/**
 * 技能快照（用于缓存）
 */
export type SkillSnapshot = {
  /** Prompt 内容 */
  prompt: string;
  /** 技能列表 */
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  /** 技能过滤器 */
  skillFilter?: string[];
  /** 解析后的技能 */
  resolvedSkills?: Skill[];
  /** 版本号 */
  version?: number;
};

// ============== 技能工具类型 ==============

/**
 * 技能工具定义（用于 SKILL.md/tools.ts）
 */
export interface SkillToolModule {
  /** 生成的工具数组 */
  generatedTools: AnyAgentTool[];
}

/**
 * 技能工作流执行结果
 */
export interface SkillWorkflowResult<T = unknown> {
  /** 是否成功 */
  success: boolean;
  /** 步骤结果 */
  steps: Array<{
    name: string;
    result: unknown;
    success: boolean;
    error?: string;
  }>;
  /** 摘要 */
  summary: string;
  /** 详细数据 */
  data?: T;
}

// ============== XML 格式化 ==============

/**
 * 转义 XML 特殊字符
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 格式化技能列表为 Prompt 片段
 *
 * 复用上游 formatSkillsForPrompt 函数
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) {
    return '';
  }

  const lines = [
    '',
    'The following skills provide specialized instructions for specific tasks.',
    'Use the read tool to load a skill\'s file when the task matches its description.',
    'When a skill file references a relative path, resolve it against the skill directory',
    '(parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];

  for (const skill of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');

  return lines.join('\n');
}

// ============== 技能常量 ==============

/**
 * 技能文件最大长度（字符）
 */
export const SKILL_FILE_MAX_LENGTH = 50 * 1024; // 50KB

/**
 * 技能名称最大长度
 */
export const SKILL_NAME_MAX_LENGTH = 64;

/**
 * 技能描述最大长度
 */
export const SKILL_DESCRIPTION_MAX_LENGTH = 200;

/**
 * SKILL.md 文件名
 */
export const SKILL_FILENAME = 'SKILL.md';
