/**
 * DB-Ops 技能 Frontmatter 解析器
 *
 * 复用上游 frontmatter 解析模式：
 * - 解析 SKILL.md 文件头部的 YAML frontmatter
 * - 提取技能元数据
 * - 验证 frontmatter 字段
 */

import { isMap, parseDocument } from 'yaml';
import type { ParsedSkillFrontmatter, Skill } from './types.js';

// ============== Frontmatter 解析 ==============

/**
 * 解析 SKILL.md 文件的 frontmatter
 *
 * SKILL.md 文件格式：
 * ```markdown
 * ---
 * name: health-check
 * description: 数据库健康检查
 * command-dispatch: tool
 * command-tool: db_check_health
 * ---
 *
 * # 技能详细说明
 * ...
 * ```
 */
export function parseSkillFrontmatter(content: string): {
  frontmatter: ParsedSkillFrontmatter;
  body: string;
  valid: boolean;
  error?: string;
} {
  // 提取 frontmatter 部分（--- 包裹的 YAML）
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return {
      frontmatter: {},
      body: content,
      valid: false,
      error: '未找到有效的 frontmatter（--- 包裹的 YAML）',
    };
  }

  const [, frontmatterStr, body] = match;

  // 解析 YAML
  let frontmatter: ParsedSkillFrontmatter;
  try {
    frontmatter = parseYaml(frontmatterStr);
  } catch (error) {
    return {
      frontmatter: {},
      body,
      valid: false,
      error: `YAML 解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 验证必要字段
  if (!frontmatter.name) {
    return {
      frontmatter,
      body,
      valid: false,
      error: '缺少必要字段：name',
    };
  }

  if (!frontmatter.description) {
    return {
      frontmatter,
      body,
      valid: false,
      error: '缺少必要字段：description',
    };
  }

  return {
    frontmatter,
    body,
    valid: true,
  };
}

/**
 * 使用标准 YAML 解析器处理 flow/block 列表及引号，禁止将语法错误当成部分成功。
 */
function parseYaml(yaml: string): ParsedSkillFrontmatter {
  const document = parseDocument(yaml);
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw issue;
  if (!isMap(document.contents)) {
    throw new Error('frontmatter 必须是 YAML 映射');
  }
  return document.toJS({ maxAliasCount: 100 }) as ParsedSkillFrontmatter;
}

// ============== Frontmatter 规范化 ==============

/**
 * 规范化 frontmatter 字段（处理 kebab-case 和 snake_case 混用）
 */
export function normalizeFrontmatter(frontmatter: ParsedSkillFrontmatter): ParsedSkillFrontmatter {
  const normalized: ParsedSkillFrontmatter = { ...frontmatter };

  // 处理 command-dispatch / command_dispatch
  if (frontmatter['command-dispatch'] && !frontmatter.command_dispatch) {
    normalized.command_dispatch = frontmatter['command-dispatch'];
  }
  if (frontmatter.command_dispatch && !frontmatter['command-dispatch']) {
    normalized['command-dispatch'] = frontmatter.command_dispatch;
  }

  // 处理 command-tool / command_tool
  if (frontmatter['command-tool'] && !frontmatter.command_tool) {
    normalized.command_tool = frontmatter['command-tool'];
  }
  if (frontmatter.command_tool && !frontmatter['command-tool']) {
    normalized['command-tool'] = frontmatter.command_tool;
  }

  // 处理 command-arg-mode / command_arg_mode
  if (frontmatter['command-arg-mode'] && !frontmatter.command_arg_mode) {
    normalized.command_arg_mode = frontmatter['command-arg-mode'];
  }
  if (frontmatter.command_arg_mode && !frontmatter['command-arg-mode']) {
    normalized['command-arg-mode'] = frontmatter.command_arg_mode;
  }

  // 处理 user-invocable / user_invocable
  if (typeof frontmatter['user-invocable'] === 'boolean' && typeof frontmatter.user_invocable !== 'boolean') {
    normalized.user_invocable = frontmatter['user-invocable'];
  }
  if (typeof frontmatter.user_invocable === 'boolean' && typeof frontmatter['user-invocable'] !== 'boolean') {
    normalized['user-invocable'] = frontmatter.user_invocable;
  }

  // 处理 primary-env / primary_env
  if (frontmatter['primary-env'] && !frontmatter.primary_env) {
    normalized.primary_env = frontmatter['primary-env'];
  }
  if (frontmatter.primary_env && !frontmatter['primary-env']) {
    normalized['primary-env'] = frontmatter.primary_env;
  }

  return normalized;
}

// ============== Frontmatter 提取 ==============

/**
 * 从 frontmatter 提取元数据
 */
export function extractSlideSkillMetadata(frontmatter: ParsedSkillFrontmatter) {
  return {
    always: frontmatter.always === true || frontmatter.always === 'true',
    skillKey: frontmatter.skillKey?.toString(),
    primaryEnv: frontmatter.primary_env?.toString() || frontmatter['primary-env']?.toString(),
    emoji: frontmatter.emoji?.toString(),
    homepage: frontmatter.homepage?.toString(),
    os: Array.isArray(frontmatter.os) ? frontmatter.os : [],
    requires: frontmatter.requires as { bins?: string[]; anyBins?: string[]; env?: string[]; config?: string[] } | undefined,
  };
}

/**
 * 从 frontmatter 提取调用策略
 */
export function extractInvocationPolicy(frontmatter: ParsedSkillFrontmatter): {
  userInvocable: boolean;
  disableModelInvocation: boolean;
} {
  const userInvocable = frontmatter.user_invocable ?? frontmatter['user-invocable'] ?? true;
  const disableModelInvocation = frontmatter.disable_model_invocation ?? frontmatter['disable-model-invocation'] ?? false;

  return {
    userInvocable: Boolean(userInvocable),
    disableModelInvocation: Boolean(disableModelInvocation),
  };
}

/**
 * 从 frontmatter 提取暴露配置
 */
export function extractExposure(frontmatter: ParsedSkillFrontmatter): {
  includeInRuntimeRegistry: boolean;
  includeInAvailableSkillsPrompt: boolean;
  userInvocable: boolean;
} {
  const { userInvocable } = extractInvocationPolicy(frontmatter);

  return {
    includeInRuntimeRegistry: frontmatter.include_in_runtime_registry !== false,
    includeInAvailableSkillsPrompt: frontmatter.include_in_available_skills_prompt !== false,
    userInvocable,
  };
}

/**
 * 从 frontmatter 提取命令分发规范
 */
export function extractCommandDispatch(frontmatter: ParsedSkillFrontmatter): {
  kind?: 'tool' | 'prompt';
  toolName?: string;
  argMode?: 'raw';
  promptTemplate?: string;
} {
  const dispatchType = frontmatter.command_dispatch?.toString() || frontmatter['command-dispatch']?.toString();

  if (dispatchType === 'tool') {
    const toolName = frontmatter.command_tool?.toString() || frontmatter['command-tool']?.toString();
    const argMode = (frontmatter.command_arg_mode?.toString() || frontmatter['command-arg-mode']?.toString()) as 'raw' | undefined;

    return {
      kind: 'tool',
      toolName: toolName || undefined,
      argMode: argMode === 'raw' ? 'raw' : undefined,
    };
  }

  if (dispatchType === 'prompt') {
    const promptTemplate = frontmatter.prompt_template?.toString() || frontmatter['prompt-template']?.toString();
    return {
      kind: 'prompt',
      promptTemplate: promptTemplate || undefined,
    };
  }

  return {};
}

// ============== 技能构建 ==============

/**
 * 从文件和 frontmatter 构建技能条目
 */
export function buildSkillEntry(
  filePath: string,
  frontmatter: ParsedSkillFrontmatter,
  body: string,
): {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
  metadata: ReturnType<typeof extractSlideSkillMetadata>;
  invocation: ReturnType<typeof extractInvocationPolicy>;
  exposure: ReturnType<typeof extractExposure>;
} {
  const normalizedFrontmatter = normalizeFrontmatter(frontmatter);

  const skill: Skill = {
    name: normalizedFrontmatter.name?.toString() || 'unknown',
    description: normalizedFrontmatter.description?.toString() || 'No description',
    filePath,
    source: body,
  };

  return {
    skill,
    frontmatter: normalizedFrontmatter,
    metadata: extractSlideSkillMetadata(normalizedFrontmatter),
    invocation: extractInvocationPolicy(normalizedFrontmatter),
    exposure: extractExposure(normalizedFrontmatter),
  };
}
