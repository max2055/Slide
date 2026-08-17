/**
 * DB-Ops 技能加载器
 *
 * 复用上游技能加载模式：
 * - 从目录扫描 SKILL.md 文件
 * - 解析 frontmatter 和验证
 * - Skill 代码不得在 API 进程内加载或执行
 * - 注册技能到运行时
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { SkillEntry, ParsedSkillFrontmatter, SkillCommandSpec } from './types.js';
import { parseSkillFrontmatter, normalizeFrontmatter, buildSkillEntry, extractSlideSkillMetadata } from './frontmatter.js';

// ============== 配置常量 ==============

/**
 * SKILL.md 文件名
 */
const SKILL_FILENAME = 'SKILL.md';

/**
 * 技能目录最大深度
 */
const MAX_DEPTH = 3;
const MAX_SKILL_BYTES = 256 * 1024;

type SkillSource = 'bundled' | 'operator' | 'temporary';

// ============== 技能加载 ==============

/**
 * 从目录加载技能
 *
 * @param rootDir 技能根目录
 * @param options 加载选项
 */
export async function loadSkillsFromDirectory(
  rootDir: string,
  options?: {
    /** 是否递归子目录 */
    recursive?: boolean;
    /** 最大深度 */
    maxDepth?: number;
    /** 技能过滤器 */
    skillFilter?: string[];
    /** Trust source assigned by the operator-owned root configuration. */
    source?: SkillSource;
    /** Required for operator skills; keyed by frontmatter skill name. */
    expectedDigests?: Readonly<Record<string, string>>;
  },
): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = [];
  const recursive = options?.recursive ?? true;
  const maxDepth = options?.maxDepth ?? MAX_DEPTH;
  const source = options?.source ?? 'temporary';
  let trustedRoot: string;

  try {
    trustedRoot = await fs.promises.realpath(rootDir);
    await scanDirectory(rootDir, 0);
  } catch (error) {
    console.error('[SkillLoader] 加载技能失败:', error);
  }

  async function scanDirectory(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      console.warn(`[SkillLoader] 无法读取目录：${dir}`, error);
      return;
    }

    for (const entry of entries) {
      // 跳过隐藏目录和文件
      if (entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      // 检查是否是 SKILL.md 文件
      if (entry.isFile() && entry.name === SKILL_FILENAME) {
        const skillEntry = await loadSkillFromFile(fullPath, {
          trustedRoot,
          source,
          expectedDigests: options?.expectedDigests,
        });
        if (skillEntry) {
          // 应用技能过滤器
          if (!options?.skillFilter || options.skillFilter.includes(skillEntry.skill.name)) {
            skills.push(skillEntry);
          }
        }
        continue;
      }

      // 递归子目录
      if (entry.isDirectory() && recursive) {
        await scanDirectory(fullPath, depth + 1);
      }
    }
  }

  return skills;
}

/**
 * 从文件加载技能
 */
export async function loadSkillFromFile(
  filePath: string,
  securityOptions?: {
    trustedRoot?: string;
    source?: SkillSource;
    expectedDigests?: Readonly<Record<string, string>>;
  },
): Promise<SkillEntry | null> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) return null;
    const realPath = await fs.promises.realpath(filePath);
    const trustedRoot = securityOptions?.trustedRoot
      ? await fs.promises.realpath(securityOptions.trustedRoot)
      : path.dirname(realPath);
    const relative = path.relative(trustedRoot, realPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

    // 读取文件内容
    const content = await fs.promises.readFile(realPath, 'utf-8');
    const digest = createHash('sha256').update(content, 'utf8').digest('hex');

    // 解析 frontmatter
    const { frontmatter, body, valid, error } = parseSkillFrontmatter(content);

    if (!valid) {
      console.warn(`[SkillLoader] Frontmatter 解析失败 (${filePath}): ${error}`);
      return null;
    }

    // 规范化 frontmatter
    const normalizedFrontmatter = normalizeFrontmatter(frontmatter);
    const name = normalizedFrontmatter.name?.toString() || 'unknown';
    const source = securityOptions?.source ?? 'temporary';
    const expectedDigest = securityOptions?.expectedDigests?.[name];
    const trusted = source === 'bundled' || (source === 'operator' && expectedDigest === digest);
    if (source === 'operator' && !trusted) {
      console.warn(`[SkillLoader] Skill digest mismatch or missing: ${name}`);
      return null;
    }

    // 构建技能条目
    const skill = {
      name,
      description: normalizedFrontmatter.description?.toString() || 'No description',
      filePath,
      source: body,
    };

    const entry: SkillEntry = {
      skill,
      frontmatter: normalizedFrontmatter,
      metadata: extractSlideSkillMetadata(normalizedFrontmatter),
      invocation: extractInvocationPolicy(normalizedFrontmatter),
      exposure: extractExposure(normalizedFrontmatter),
      security: { source, digest, trusted, root: trustedRoot },
    };

    return entry;
  } catch (error: unknown) {
    console.error(`[SkillLoader] 加载技能失败 (${filePath}):`, error);
    return null;
  }
}

// ============== 辅助函数 ==============

/**
 * 提取调用策略
 */
function extractInvocationPolicy(frontmatter: ParsedSkillFrontmatter) {
  const userInvocable = frontmatter.user_invocable ?? frontmatter['user-invocable'] ?? true;
  const disableModelInvocation = frontmatter.disable_model_invocation ?? frontmatter['disable-model-invocation'] ?? false;

  return {
    userInvocable: Boolean(userInvocable),
    disableModelInvocation: Boolean(disableModelInvocation),
  };
}

/**
 * 提取暴露配置
 */
function extractExposure(frontmatter: ParsedSkillFrontmatter) {
  const { userInvocable } = extractInvocationPolicy(frontmatter);

  return {
    includeInRuntimeRegistry: frontmatter.include_in_runtime_registry !== false,
    includeInAvailableSkillsPrompt: frontmatter.include_in_available_skills_prompt !== false,
    userInvocable,
  };
}

// ============== 技能命令构建 ==============

/**
 * 从技能条目构建命令规范
 */
export function buildSkillCommandSpecs(entries: SkillEntry[]): SkillCommandSpec[] {
  const specs: SkillCommandSpec[] = [];
  const usedNames = new Set<string>();

  for (const entry of entries) {
    // 检查是否用户可调用
    if (entry.invocation?.userInvocable === false) {
      continue;
    }

    // 生成命令名称
    const commandName = sanitizeCommandName(entry.skill.name);
    const uniqueName = resolveUniqueCommandName(commandName, usedNames);
    usedNames.add(uniqueName.toLowerCase());

    // 提取命令分发规范
    const dispatch = extractCommandDispatch(entry.frontmatter);

    const spec: SkillCommandSpec = {
      name: uniqueName,
      skillName: entry.skill.name,
      description: entry.skill.description,
    };

    if (dispatch.kind === 'tool') {
      spec.dispatch = { kind: 'tool', toolName: dispatch.toolName!, argMode: dispatch.argMode };
    } else if (dispatch.kind === 'prompt') {
      spec.promptTemplate = dispatch.promptTemplate;
    }

    specs.push(spec);
  }

  return specs;
}

/**
 * 规范化命令名称
 */
function sanitizeCommandName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'skill';
}

/**
 * 解析唯一命令名称
 */
function resolveUniqueCommandName(base: string, used: Set<string>): string {
  const normalized = base.toLowerCase();

  if (!used.has(normalized)) {
    return base;
  }

  // 添加后缀直到唯一
  for (let i = 2; i < 100; i++) {
    const candidate = `${base.slice(0, 30 - i.toString().length)}_${i}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `${base.slice(0, 30)}_x`;
}

/**
 * 提取命令分发规范
 */
function extractCommandDispatch(frontmatter: ParsedSkillFrontmatter): {
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

// ============== 技能注册 ==============

/**
 * 技能注册表
 */
class SkillRegistry {
  private skills: Map<string, SkillEntry> = new Map();

  /**
   * 注册技能
   */
  register(entry: SkillEntry): void {
    const normalizedName = entry.skill.name.toLowerCase();

    if (this.skills.has(normalizedName)) {
      console.warn(`[SkillRegistry] 技能已存在，跳过注册：${normalizedName}`);
      return;
    }

    this.skills.set(normalizedName, entry);
    console.log(`[SkillRegistry] 技能注册成功：${normalizedName}`);
  }

  /**
   * 批量注册
   */
  registerAll(entries: SkillEntry[]): void {
    for (const entry of entries) {
      this.register(entry);
    }
  }

  /**
   * 获取技能
   */
  get(name: string): SkillEntry | undefined {
    const normalizedName = name.toLowerCase();
    return this.skills.get(normalizedName);
  }

  /**
   * 获取所有技能
   */
  getAll(): SkillEntry[] {
    return Array.from(this.skills.values());
  }

  /**
   * 获取技能名称列表
   */
  getSkillNames(): string[] {
    return Array.from(this.skills.keys());
  }

  /**
   * 检查技能是否存在
   */
  has(name: string): boolean {
    return this.skills.has(name.toLowerCase());
  }

  /**
   * 清空注册表
   */
  clear(): void {
    this.skills.clear();
  }
}

/**
 * 全局技能注册表
 */
export const skillRegistry = new SkillRegistry();

// ============== 预定义技能目录 ==============

/**
 * 预定义的技能目录列表
 */
export const PREDEFINED_SKILL_DIRS = [
  // 应用内技能目录
  path.resolve(path.dirname(fileURLToPath(import.meta.url))),
  // 外部技能目录（基于源码文件位置解析，而非 CWD）
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db-ops-skills'),
];

/**
 * 加载所有预定义目录的技能
 */
export async function loadPredefinedSkills(): Promise<SkillEntry[]> {
  const allSkills: SkillEntry[] = [];

  for (const dir of PREDEFINED_SKILL_DIRS) {
    // 检查目录是否存在
    if (!fs.existsSync(dir)) {
      continue;
    }

    const skills = await loadSkillsFromDirectory(dir, { source: 'bundled' });
    allSkills.push(...skills);
  }

  const operatorDirs = (process.env.AGENT_SKILL_DIRS || '').split(',').map((dir) => dir.trim()).filter(Boolean);
  if (operatorDirs.length > 0) {
    let expectedDigests: Record<string, string> = {};
    try {
      expectedDigests = JSON.parse(process.env.AGENT_SKILL_DIGESTS || '{}') as Record<string, string>;
    } catch {
      console.warn('[SkillLoader] AGENT_SKILL_DIGESTS is not valid JSON; operator skills disabled');
    }
    for (const dir of operatorDirs) {
      const skills = await loadSkillsFromDirectory(path.resolve(dir), { source: 'operator', expectedDigests });
      allSkills.push(...skills);
    }
  }

  return allSkills;
}
