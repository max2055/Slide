/**
 * Session Manager - 会话管理机制（复用上游设计）
 *
 * 核心特性：
 * 1. JSONL 会话文件格式
 * 2. parentId 链/DAG 结构支持
 * 3. 会话缓存机制
 * 4. 智能截断和压缩
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export interface SessionEntry {
  id: string;
  parentId: string | null;
  type: 'message' | 'system' | 'compaction' | 'custom';
  role?: 'user' | 'assistant' | 'system';
  content: string | unknown;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface SessionHeader {
  sessionId: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  instanceId?: number;
  title?: string;
}

export interface SessionManagerOptions {
  sessionDir: string;
  cacheTtlMs?: number;
  maxEntriesPerSession?: number;
}

export interface CompactionResult {
  entriesRemoved: number;
  newEntryCount: number;
  compactionId: string;
}

class SessionManager extends EventEmitter {
  private sessionDir: string;
  private cacheTtlMs: number;
  private maxEntriesPerSession: number;
  private entryCache: Map<string, SessionEntry[]> = new Map();
  private headerCache: Map<string, SessionHeader> = new Map();
  private accessTime: Map<string, number> = new Map();

  constructor(options: SessionManagerOptions) {
    super();
    this.sessionDir = options.sessionDir;
    this.cacheTtlMs = options.cacheTtlMs ?? 45000; // 45 秒默认 TTL
    this.maxEntriesPerSession = options.maxEntriesPerSession ?? 1000;
  }

  /**
   * 创建新会话
   */
  async createSession(
    sessionId: string,
    title?: string,
    instanceId?: number
  ): Promise<SessionHeader> {
    const sessionFile = this.getSessionFilePath(sessionId);

    const header: SessionHeader = {
      sessionId,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title,
      instanceId,
    };

    // 写入会话头
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, JSON.stringify({ type: 'header', ...header }) + '\n');

    // 初始化空消息列表
    this.entryCache.set(sessionId, []);
    this.headerCache.set(sessionId, header);
    this.accessTime.set(sessionId, Date.now());

    return header;
  }

  /**
   * 获取会话文件路径
   */
  private getSessionFilePath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.jsonl`);
  }

  /**
   * 添加消息到会话（支持 parentId 形成 DAG 结构）
   */
  async appendMessage(
    sessionId: string,
    entry: Omit<SessionEntry, 'timestamp'>
  ): Promise<SessionEntry> {
    const sessionFile = this.getSessionFilePath(sessionId);
    const fullEntry: SessionEntry = {
      ...entry,
      timestamp: Date.now(),
    };

    // 获取或加载现有条目
    let entries = this.entryCache.get(sessionId);
    if (!entries) {
      entries = await this.loadEntries(sessionId);
    }

    // 验证 parentId 存在（形成有效的 DAG）
    if (entry.parentId && entry.type === 'message') {
      const parentExists = entries.some(e => e.id === entry.parentId);
      if (!parentExists) {
        throw new Error(`Parent message ${entry.parentId} not found`);
      }
    }

    // 添加新条目
    entries.push(fullEntry);

    // 检查是否需要截断
    if (entries.length > this.maxEntriesPerSession) {
      await this.truncateEntries(sessionId, entries);
    }

    // 持久化到 JSONL 文件
    await fs.appendFile(sessionFile, JSON.stringify(fullEntry) + '\n');

    // 更新缓存
    this.entryCache.set(sessionId, entries);
    this.accessTime.set(sessionId, Date.now());

    // 更新 header
    const header = this.headerCache.get(sessionId);
    if (header) {
      header.updatedAt = Date.now();
      await this.updateHeader(sessionId, header);
    }

    this.emit('message:added', { sessionId, entry: fullEntry });

    return fullEntry;
  }

  /**
   * 加载会话条目
   */
  async loadEntries(sessionId: string): Promise<SessionEntry[]> {
    // 检查缓存
    const cached = this.entryCache.get(sessionId);
    if (cached && Date.now() - this.accessTime.get(sessionId)! < this.cacheTtlMs) {
      return cached;
    }

    const sessionFile = this.getSessionFilePath(sessionId);
    try {
      const content = await fs.readFile(sessionFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const entries: SessionEntry[] = [];

      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (parsed.type === 'header') continue; // 跳过 header
        entries.push(parsed as SessionEntry);
      }

      this.entryCache.set(sessionId, entries);
      this.accessTime.set(sessionId, Date.now());
      return entries;
    } catch (error) {
      // 文件不存在则返回空数组
      this.entryCache.set(sessionId, []);
      return [];
    }
  }

  /**
   * 获取会话消息列表（支持按 parentId 过滤）
   */
  async getMessages(
    sessionId: string,
    options?: {
      limit?: number;
      parentId?: string | null;
      includeBranches?: boolean;
    }
  ): Promise<SessionEntry[]> {
    let entries = await this.loadEntries(sessionId);
    const { limit = 100, parentId = null, includeBranches = false } = options ?? {};

    // 如果指定 parentId，只获取该分支的消息
    if (parentId !== null) {
      entries = this.getBranchEntries(entries, parentId);
    }

    // 按时间排序
    entries.sort((a, b) => a.timestamp - b.timestamp);

    // 限制数量
    if (limit > 0 && entries.length > limit) {
      entries = entries.slice(-limit);
    }

    return entries;
  }

  /**
   * 获取指定分支的条目（从 parentId 到最新）
   */
  private getBranchEntries(entries: SessionEntry[], parentId: string): SessionEntry[] {
    const result: SessionEntry[] = [];
    const childrenMap = new Map<string, SessionEntry[]>();

    // 构建子节点映射
    for (const entry of entries) {
      const key = entry.parentId ?? 'root';
      if (!childrenMap.has(key)) {
        childrenMap.set(key, []);
      }
      childrenMap.get(key)!.push(entry);
    }

    // 从 parentId 开始遍历分支
    const queue = [parentId];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const currentEntry = entries.find(e => e.id === currentId);
      if (currentEntry) {
        result.push(currentEntry);
      }
      const children = childrenMap.get(currentId) ?? [];
      for (const child of children) {
        queue.push(child.id);
      }
    }

    return result;
  }

  /**
   * 执行会话压缩（compaction）
   */
  async compactSession(
    sessionId: string,
    options?: {
      keepLastN?: number;
      summary?: string;
    }
  ): Promise<CompactionResult> {
    const entries = await this.loadEntries(sessionId);
    const { keepLastN = 20 } = options ?? {};

    // 创建压缩条目
    const compactionEntry: SessionEntry = {
      id: `compaction_${Date.now()}`,
      parentId: entries[0]?.id ?? null,
      type: 'compaction',
      content: options?.summary ?? 'Session compacted',
      timestamp: Date.now(),
      metadata: {
        firstKeptEntryId: entries[entries.length - keepLastN]?.id,
        entriesRemoved: Math.max(0, entries.length - keepLastN),
      },
    };

    // 保留最近的 N 条消息和压缩条目
    const keptEntries = entries.slice(-keepLastN);
    keptEntries.push(compactionEntry);

    // 重写会话文件
    const sessionFile = this.getSessionFilePath(sessionId);
    const header = await this.loadHeader(sessionId);
    let content = JSON.stringify({ type: 'header', ...header }) + '\n';
    for (const entry of keptEntries) {
      content += JSON.stringify(entry) + '\n';
    }
    await fs.writeFile(sessionFile, content);

    // 更新缓存
    this.entryCache.set(sessionId, keptEntries);

    return {
      entriesRemoved: compactionEntry.metadata!.entriesRemoved as number,
      newEntryCount: keptEntries.length,
      compactionId: compactionEntry.id,
    };
  }

  /**
   * 截断条目（当超出最大限制时调用）
   */
  private async truncateEntries(sessionId: string, entries: SessionEntry[]): Promise<void> {
    const removeCount = entries.length - this.maxEntriesPerSession + 100; // 保留一些缓冲
    if (removeCount <= 0) return;

    // 找到要移除的条目 ID
    const entriesToRemove = new Set(entries.slice(0, removeCount).map(e => e.id));

    // 创建压缩记录
    const compactionEntry: SessionEntry = {
      id: `auto_compaction_${Date.now()}`,
      parentId: entries[removeCount - 1]?.id ?? null,
      type: 'compaction',
      content: `Auto-truncated ${removeCount} entries`,
      timestamp: Date.now(),
      metadata: { entriesRemoved: removeCount },
    };

    const keptEntries = entries.slice(removeCount);
    keptEntries.push(compactionEntry);

    // 重写文件
    const sessionFile = this.getSessionFilePath(sessionId);
    const header = await this.loadHeader(sessionId);
    let content = JSON.stringify({ type: 'header', ...header }) + '\n';
    for (const entry of keptEntries) {
      content += JSON.stringify(entry) + '\n';
    }
    await fs.writeFile(sessionFile, content);

    this.entryCache.set(sessionId, keptEntries);
  }

  /**
   * 加载会话头
   */
  private async loadHeader(sessionId: string): Promise<SessionHeader> {
    const cached = this.headerCache.get(sessionId);
    if (cached && Date.now() - this.accessTime.get(sessionId)! < this.cacheTtlMs) {
      return cached;
    }

    const sessionFile = this.getSessionFilePath(sessionId);
    try {
      const content = await fs.readFile(sessionFile, 'utf-8');
      const firstLine = content.split('\n')[0];
      const parsed = JSON.parse(firstLine);
      if (parsed.type !== 'header') {
        throw new Error('Invalid session file: missing header');
      }
      const header: SessionHeader = parsed;
      this.headerCache.set(sessionId, header);
      return header;
    } catch (error) {
      throw new Error(`Failed to load session header: ${error}`);
    }
  }

  /**
   * 更新会话头
   */
  private async updateHeader(sessionId: string, header: SessionHeader): Promise<void> {
    this.headerCache.set(sessionId, header);
    const sessionFile = this.getSessionFilePath(sessionId);
    try {
      const content = await fs.readFile(sessionFile, 'utf-8');
      const lines = content.trim().split('\n');
      lines[0] = JSON.stringify({ type: 'header', ...header });
      await fs.writeFile(sessionFile, lines.join('\n') + '\n');
    } catch (error) {
      console.error(`Failed to update session header: ${error}`);
    }
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const sessionFile = this.getSessionFilePath(sessionId);
    try {
      await fs.unlink(sessionFile);
      this.entryCache.delete(sessionId);
      this.headerCache.delete(sessionId);
      this.accessTime.delete(sessionId);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取会话列表
   */
  async listSessions(): Promise<SessionHeader[]> {
    const headers: SessionHeader[] = [];
    try {
      const files = await fs.readdir(this.sessionDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.replace('.jsonl', '');
        try {
          const header = await this.loadHeader(sessionId);
          headers.push(header);
        } catch (e) {
          // 跳过损坏的文件
        }
      }
    } catch (error) {
      // 目录不存在则返回空列表
    }

    // 按更新时间排序
    headers.sort((a, b) => b.updatedAt - a.updatedAt);
    return headers;
  }

  /**
   * 获取单个会话详情
   */
  async getSession(sessionId: string): Promise<{ header: SessionHeader; messages: SessionEntry[] } | null> {
    try {
      const header = await this.loadHeader(sessionId);
      const messages = await this.getMessages(sessionId);
      return { header, messages };
    } catch (error) {
      return null;
    }
  }

  /**
   * 清理过期缓存
   */
  pruneCache(): void {
    const now = Date.now();
    for (const [sessionId, accessTime] of this.accessTime.entries()) {
      if (now - accessTime > this.cacheTtlMs) {
        this.entryCache.delete(sessionId);
        this.headerCache.delete(sessionId);
        this.accessTime.delete(sessionId);
      }
    }
  }
}

// 创建单例（需要初始化后使用）
let sessionManager: SessionManager | null = null;

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  sessionManager = new SessionManager(options);

  // 定时清理缓存
  setInterval(() => {
    sessionManager?.pruneCache();
  }, Math.min(options.cacheTtlMs ?? 45000, 30000));

  return sessionManager;
}

export function getSessionManager(): SessionManager | null {
  return sessionManager;
}

// 导出类型
export type { SessionManager };
