/**
 * Prompt Manager — 管理 AI 分析提示词的版本和加载
 *
 * 设计：
 * - 从 prompts/versions/ 目录加载 .md 提示词文件
 * - 版本命名规范：{type}-v{number}.md（如 fault-diagnosis-v2.md）
 * - 通过环境变量 PROMPT_VERSION 切换版本（默认 v2）
 * - 支持运行时动态切换版本、内联编辑、文件写回、热重载
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSIONS_DIR = path.resolve(__dirname, 'versions');

interface PromptVersion {
  version: number;
  content: string;
  length: number;
  fileName: string;
}

interface PromptTypeInfo {
  type: string;
  versions: PromptVersion[];
  activeVersion: number;
}

class PromptManager {
  private prompts: Map<string, PromptVersion[]> = new Map();
  private activeVersion: number = 2;
  private abTest = false;
  private watcher: fs.FSWatcher | null = null;

  /**
   * 初始化：加载 prompts/versions/ 目录下的所有 .md 文件
   */
  async initialize(): Promise<void> {
    const version = process.env.PROMPT_VERSION;
    if (version !== undefined) {
      const parsed = parseInt(version, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this.activeVersion = parsed;
      }
    }
    this.abTest = process.env.PROMPT_AB_TEST === 'true';

    if (!fs.existsSync(VERSIONS_DIR)) {
      console.warn(`[PromptManager] 提示词目录不存在：${VERSIONS_DIR}`);
      return;
    }

    await this.reloadAll();
    console.log(`[PromptManager] 已加载 ${this.countEntries()} 个提示词文件，${this.prompts.size} 种类型，当前版本：v${this.activeVersion}${this.abTest ? '（A/B 测试模式）' : ''}`);
  }

  /**
   * 重新加载所有提示词文件
   */
  private async reloadAll(): Promise<void> {
    this.prompts.clear();
    const files = await fs.promises.readdir(VERSIONS_DIR);

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const match = file.match(/^(.+)-v(\d+)\.md$/);
      if (!match) continue;

      const type = match[1];
      const version = parseInt(match[2], 10);

      try {
        const content = await fs.promises.readFile(path.join(VERSIONS_DIR, file), 'utf-8');
        if (!this.prompts.has(type)) {
          this.prompts.set(type, []);
        }
        this.prompts.get(type)!.push({ version, content, length: content.length, fileName: file });
      } catch (err) {
        console.warn(`[PromptManager] 读取失败：${file}`, err);
      }
    }
  }

  private countEntries(): number {
    let count = 0;
    for (const versions of this.prompts.values()) {
      count += versions.length;
    }
    return count;
  }

  // ══════════════ 读取方法 ══════════════

  /**
   * 获取指定类型的提示词内容
   */
  getPrompt(type: string, overrideVersion?: number): string {
    const versions = this.prompts.get(type);
    if (!versions || versions.length === 0) {
      console.warn(`[PromptManager] 未找到类型 "${type}" 的提示词`);
      return '';
    }

    const version = overrideVersion ?? this.activeVersion;

    if (this.abTest) {
      const v1 = versions.find(e => e.version === 1);
      const v2 = versions.find(e => e.version === 2);
      if (v1 && v2) {
        const picked = Math.random() < 0.5 ? v1 : v2;
        return picked.content;
      }
    }

    const entry = versions.find(e => e.version === version)
      ?? versions.reduce((a, b) => a.version > b.version ? a : b);
    return entry.content;
  }

  /**
   * 获取特定版本的提示词内容
   */
  getVersionContent(type: string, version: number): string | null {
    const versions = this.prompts.get(type);
    if (!versions) return null;
    const entry = versions.find(e => e.version === version);
    return entry?.content ?? null;
  }

  /**
   * 获取所有类型的完整信息
   */
  getAllTypes(): PromptTypeInfo[] {
    const result: PromptTypeInfo[] = [];
    for (const [type, versions] of this.prompts) {
      result.push({
        type,
        versions: versions.sort((a, b) => a.version - b.version),
        activeVersion: this.activeVersion,
      });
    }
    return result.sort((a, b) => a.type.localeCompare(b.type));
  }

  /**
   * 获取单个类型的完整信息
   */
  getTypeInfo(type: string): PromptTypeInfo | null {
    const versions = this.prompts.get(type);
    if (!versions) return null;
    return {
      type,
      versions: versions.sort((a, b) => a.version - b.version),
      activeVersion: this.activeVersion,
    };
  }

  getActiveVersion(): number { return this.activeVersion; }
  getVersionsDir(): string { return VERSIONS_DIR; }

  // ══════════════ 运行时更新方法 ══════════════

  /**
   * 切换活跃版本
   */
  setActiveVersion(version: number): void {
    if (version < 1) return;
    this.activeVersion = version;
    console.log(`[PromptManager] 切换到 v${version}`);
  }

  /**
   * 更新指定版本的提示词内容，并写回文件
   */
  async setVersionContent(type: string, version: number, content: string): Promise<boolean> {
    const versions = this.prompts.get(type);
    if (!versions) return false;

    const entry = versions.find(e => e.version === version);
    if (!entry) return false;

    // 更新内存
    entry.content = content;
    entry.length = content.length;

    // 写回文件
    try {
      await fs.promises.writeFile(path.join(VERSIONS_DIR, entry.fileName), content, 'utf-8');
      console.log(`[PromptManager] 已保存 ${entry.fileName} (${content.length} chars)`);
      return true;
    } catch (err) {
      console.error(`[PromptManager] 写回文件失败：${entry.fileName}`, err);
      return false;
    }
  }

  /**
   * 创建新版本
   */
  async createVersion(type: string, content: string): Promise<{ version: number; fileName: string } | null> {
    const versions = this.prompts.get(type);
    const maxVersion = versions ? Math.max(...versions.map(v => v.version)) : 0;
    const newVersion = maxVersion + 1;
    const fileName = `${type}-v${newVersion}.md`;

    const fullPath = path.join(VERSIONS_DIR, fileName);
    try {
      await fs.promises.writeFile(fullPath, content, 'utf-8');
      const entry: PromptVersion = { version: newVersion, content, length: content.length, fileName };
      if (!this.prompts.has(type)) {
        this.prompts.set(type, []);
      }
      this.prompts.get(type)!.push(entry);
      console.log(`[PromptManager] 已创建 ${fileName} (${content.length} chars)`);
      return { version: newVersion, fileName };
    } catch (err) {
      console.error(`[PromptManager] 创建版本文件失败：${fileName}`, err);
      return null;
    }
  }

  // ══════════════ 热重载 ══════════════

  /**
   * 启动文件监听，prompt 文件变化时自动重载
   */
  startWatch(): void {
    if (this.watcher) return;

    try {
      this.watcher = fs.watch(VERSIONS_DIR, (eventType, fileName) => {
        if (!fileName || !fileName.endsWith('.md')) return;
        // 延迟一小段等文件写入完成
        setTimeout(async () => {
          const oldCount = this.countEntries();
          await this.reloadAll();
          const newCount = this.countEntries();
          if (oldCount !== newCount || eventType === 'change') {
            console.log(`[PromptManager] 热重载：${fileName} (${eventType})`);
          }
        }, 200);
      });
      console.log(`[PromptManager] 文件监听已启动：${VERSIONS_DIR}`);
    } catch (err) {
      console.warn(`[PromptManager] 文件监听启动失败：`, err);
    }
  }

  /**
   * 停止文件监听
   */
  stopWatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log(`[PromptManager] 文件监听已停止`);
    }
  }
}

export const promptManager = new PromptManager();
