/**
 * DB-Ops 技能 Frontmatter 解析器
 *
 * 复用 OpenClaw 的 frontmatter 解析模式：
 * - 解析 SKILL.md 文件头部的 YAML frontmatter
 * - 提取技能元数据
 * - 验证 frontmatter 字段
 */

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
  const frontmatter = parseYaml(frontmatterStr);

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
 * 简易 YAML 解析器
 *
 * 支持常见的 YAML 语法：
 * - 键值对：key: value
 * - 数组：[item1, item2] 或 - item1
 * - 布尔值：true/false
 * - 数字：123
 * - 字符串："quoted" 或 unquoted
 */
function parseYaml(yaml: string): ParsedSkillFrontmatter {
  const result: ParsedSkillFrontmatter = {};

  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let arrayValue: string[] | null = null;

  for (const line of lines) {
    // 跳过空行和注释
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // 检查是否是数组项
    if (trimmed.startsWith('- ')) {
      if (currentKey && arrayValue) {
        const item = trimmed.slice(2).trim();
        arrayValue.push(parseYamlValue(item) as string);
      }
      continue;
    }

    // 检查是否是行内数组结束
    if (trimmed.startsWith(']')) {
      if (currentKey && arrayValue) {
        // 处理行内数组的剩余部分
        const remaining = trimmed.replace(']', '').trim();
        if (remaining) {
          arrayValue.push(parseYamlValue(remaining) as string);
        }
        result[currentKey] = arrayValue;
      }
      currentKey = null;
      arrayValue = null;
      continue;
    }

    // 解析键值对
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const valueStr = trimmed.slice(colonIndex + 1).trim();

    // 检查是否是行内数组开始
    if (valueStr.startsWith('[')) {
      const arrayContent = valueStr.slice(1);
      if (arrayContent.includes(']')) {
        // 行内数组在同一行结束
        const items = arrayContent.replace(']', '').split(',').map(s => s.trim()).filter(s => s);
        result[key] = items.map(item => parseYamlValue(item)) as string[];
      } else {
        // 多行数组
        arrayValue = arrayContent ? [parseYamlValue(arrayContent) as string] : [];
        currentKey = key;
        result[key] = arrayValue;
      }
      continue;
    }

    // 普通键值对
    if (valueStr) {
      result[key] = parseYamlValue(valueStr);
      currentKey = null;
      arrayValue = null;
    } else {
      // 值在下一行（多行数组）
      currentKey = key;
      arrayValue = [];
      result[key] = arrayValue;
    }
  }

  return result;
}

/**
 * 解析 YAML 值
 */
function parseYamlValue(value: string): string | boolean | number {
  const trimmed = value.trim();

  // 去除引号
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  // 布尔值
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // 数字（支持整数和小数）
  const num = Number(trimmed);
  if (!isNaN(num) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    // 如果是小数，返回浮点数；如果是整数，返回整数
    return trimmed.includes('.') ? num : Math.floor(num);
  }

  // 字符串
  return trimmed;
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
 * 从 frontmatter 提取 OpenClaw 风格元数据
 */
export function extractOpenClawMetadata(frontmatter: ParsedSkillFrontmatter) {
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
  metadata: ReturnType<typeof extractOpenClawMetadata>;
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
    metadata: extractOpenClawMetadata(normalizedFrontmatter),
    invocation: extractInvocationPolicy(normalizedFrontmatter),
    exposure: extractExposure(normalizedFrontmatter),
  };
}
