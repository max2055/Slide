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
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_VERSIONS_DIR = path.resolve(__dirname, 'versions');

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

interface PromptManagerOptions {
  versionsDir?: string;
  bundledVersionsDir?: string;
}

export class PromptManager {
  private prompts: Map<string, PromptVersion[]> = new Map();
  private activeVersion: number = 2;
  private abTest = false;
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpdate: Promise<unknown> = Promise.resolve();
  private readonly versionsDir: string;
  private readonly bundledVersionsDir: string;

  constructor(options: PromptManagerOptions = {}) {
    const configuredVersionsDir = options.versionsDir ?? process.env.PROMPT_VERSIONS_DIR?.trim();
    this.versionsDir = configuredVersionsDir || path.join(process.env.AGENT_WORKSPACE?.trim() || path.join(homedir(), '.slide'), 'prompts');
    this.bundledVersionsDir = options.bundledVersionsDir ?? BUNDLED_VERSIONS_DIR;
  }

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

    await this.prepareVersionsDirectory();

    await this.reloadAll();
    if (version !== undefined) {
      const missing = [...this.prompts].filter(([, versions]) => !versions.some(entry => entry.version === this.activeVersion));
      if (this.prompts.size === 0 || missing.length > 0) {
        throw new Error(`配置的提示词版本 v${this.activeVersion} 不存在于全部已加载类型中`);
      }
    }
    console.log(`[PromptManager] 已加载 ${this.countEntries()} 个提示词文件，${this.prompts.size} 种类型，当前版本：v${this.activeVersion}${this.abTest ? '（A/B 测试模式）' : ''}`);
  }

  /**
   * 重新加载所有提示词文件
   */
  private async reloadAll(): Promise<void> {
    return this.enqueueUpdate(async () => {
      const snapshot = new Map<string, PromptVersion[]>();
      await this.loadDirectory(this.bundledVersionsDir, snapshot);
      if (this.versionsDir !== this.bundledVersionsDir) {
        await this.loadDirectory(this.versionsDir, snapshot);
      }
      this.prompts = snapshot;
    });
  }

  // Serialize reloads and local writes so an older reload cannot discard a successful edit.
  private enqueueUpdate<T>(update: () => Promise<T>): Promise<T> {
    const result = this.pendingUpdate.then(update);
    this.pendingUpdate = result.catch(() => undefined);
    return result;
  }

  private async loadDirectory(directory: string, snapshot: Map<string, PromptVersion[]>): Promise<void> {
    const files = await fs.promises.readdir(directory);

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const match = file.match(/^(.+)-v(\d+)\.md$/);
      if (!match) continue;

      const type = match[1];
      const version = parseInt(match[2], 10);
      if (!Number.isSafeInteger(version) || version < 1) continue;

      const content = await fs.promises.readFile(path.join(directory, file), 'utf-8');
      if (!snapshot.has(type)) {
        snapshot.set(type, []);
      }
      const versions = snapshot.get(type)!;
      const existingIndex = versions.findIndex(entry => entry.version === version);
      const entry = { version, content, length: content.length, fileName: file };
      if (existingIndex === -1) {
        versions.push(entry);
      } else {
        versions[existingIndex] = entry;
      }
    }
  }

  private async prepareVersionsDirectory(): Promise<void> {
    if (this.versionsDir === this.bundledVersionsDir) {
      throw new Error('提示词写入目录不能与内置只读目录相同');
    }
    try {
      await fs.promises.mkdir(this.versionsDir, { recursive: true });
      await fs.promises.access(this.versionsDir, fs.constants.W_OK);
    } catch (error) {
      const cause = error as NodeJS.ErrnoException;
      throw new Error(`提示词写入目录不可用：${this.versionsDir} (${cause.code || cause.message})`, { cause: error });
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

    const entry = versions.find(e => e.version === version);
    if (!entry) {
      console.warn(`[PromptManager] 请求的提示词版本 v${version} 不存在，未返回其他版本`);
      return '';
    }
    if (this.abTest && overrideVersion === undefined) {
      const v1 = versions.find(e => e.version === 1);
      const v2 = versions.find(e => e.version === 2);
      if (v1 && v2) {
        const picked = Math.random() < 0.5 ? v1 : v2;
        return picked.content;
      }
    }

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
  getVersionsDir(): string { return this.versionsDir; }

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
    return this.enqueueUpdate(async () => {
      const versions = this.prompts.get(type);
      if (!versions) return false;

      const entry = versions.find(e => e.version === version);
      if (!entry) return false;

      await fs.promises.writeFile(path.join(this.versionsDir, entry.fileName), content, 'utf-8');
      entry.content = content;
      entry.length = content.length;
      console.log(`[PromptManager] 已保存 ${entry.fileName} (${content.length} chars)`);
      return true;
    });
  }

  /**
   * 创建新版本
   */
  async createVersion(type: string, content: string): Promise<{ version: number; fileName: string }> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(type)) throw new Error('提示词类型无效');
    return this.enqueueUpdate(async () => {
      const versions = this.prompts.get(type) ?? [];
      const files = await fs.promises.readdir(this.versionsDir);
      const diskVersions = files.flatMap(file => {
        const match = file.match(/^(.+)-v(\d+)\.md$/);
        const version = match ? Number(match[2]) : 0;
        return match?.[1] === type && Number.isSafeInteger(version) ? [version] : [];
      });
      let newVersion = Math.max(0, ...versions.map(v => v.version), ...diskVersions) + 1;
      const temporaryPath = path.join(this.versionsDir, `.${randomUUID()}.tmp`);
      const temporaryFile = await fs.promises.open(temporaryPath, 'wx');
      try {
        await temporaryFile.writeFile(content, 'utf-8');
        await temporaryFile.close();
        while (Number.isSafeInteger(newVersion)) {
          const fileName = `${type}-v${newVersion}.md`;
          try {
            // link publishes a complete file and fails exclusively if another process won.
            await fs.promises.link(temporaryPath, path.join(this.versionsDir, fileName));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            newVersion++;
            continue;
          }
          versions.push({ version: newVersion, content, length: content.length, fileName });
          this.prompts.set(type, versions);
          console.log(`[PromptManager] 已创建 ${fileName} (${content.length} chars)`);
          return { version: newVersion, fileName };
        }
        throw new Error('提示词版本号超出安全整数范围');
      } finally {
        await temporaryFile.close();
        await fs.promises.unlink(temporaryPath);
      }
    });
  }

  // ══════════════ 热重载 ══════════════

  /**
   * 启动文件监听，prompt 文件变化时自动重载
   */
  startWatch(): void {
    if (this.watcher) return;

    try {
      this.watcher = fs.watch(this.versionsDir, (_eventType, fileName) => {
        if (!fileName || !fileName.endsWith('.md')) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          void this.reloadAll().then(() => {
            console.log('[PromptManager] 热重载完成');
          }).catch(error => this.logWatchFailure(error));
        }, 200);
      });
      this.watcher.on('error', error => this.logWatchFailure(error));
      console.log(`[PromptManager] 文件监听已启动：${this.versionsDir}`);
    } catch (err) {
      this.logWatchFailure(err);
    }
  }

  /**
   * 停止文件监听
   */
  stopWatch(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log(`[PromptManager] 文件监听已停止`);
    }
  }

  private logWatchFailure(error: unknown): void {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    console.warn(`[PromptManager] 文件监听或热重载失败，保留原快照 (${typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : 'UNKNOWN'})`);
  }
}

export const promptManager = new PromptManager();
