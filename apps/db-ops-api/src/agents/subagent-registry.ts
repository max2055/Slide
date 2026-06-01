/**
 * DB-Ops 子 Agent 注册表
 *
 * 复用 OpenClaw 的 subagent-registry.ts 机制
 * 参考：openclaw_source_code/src/agents/subagent-registry.ts
 */

import crypto from 'node:crypto';
import type { SessionStore, SessionStoreEntry } from './session-store.js';

// ============== 子 Agent 注册表类型 ==============

/**
 * 子 Agent 运行记录
 */
export interface SubagentRunRecord {
  /** 运行 ID */
  runId: string;
  /** 会话 Key */
  sessionKey: string;
  /** 任务描述 */
  task: string;
  /** 标签 */
  label?: string;
  /** 创建时间 */
  createdAt: number;
  /** 状态 */
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  /** 结果 */
  result?: unknown;
  /** 错误信息 */
  error?: string;
}

/**
 * 子 Agent 会话记录
 */
export interface SubagentSessionRecord {
  /** 会话 Key */
  sessionKey: string;
  /** 父会话 Key */
  parentSessionKey?: string;
  /** 运行记录 */
  runs: SubagentRunRecord[];
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

// ============== 子 Agent 注册表类 ==============

/**
 * 子 Agent 注册表
 *
 * 跟踪和管理子 Agent 运行状态
 */
export class SubagentRegistry {
  private runs: Map<string, SubagentRunRecord> = new Map();
  private sessions: Map<string, SubagentSessionRecord> = new Map();

  /**
   * 注册子 Agent 运行
   */
  register(params: {
    sessionKey: string;
    task: string;
    label?: string;
    parentSessionKey?: string;
  }): SubagentRunRecord {
    const runId = this.generateRunId();
    const sessionKey = params.sessionKey;

    const run: SubagentRunRecord = {
      runId,
      sessionKey,
      task: params.task,
      label: params.label,
      createdAt: Date.now(),
      status: 'running',
    };

    this.runs.set(runId, run);

    // 更新或创建会话记录
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = {
        sessionKey,
        parentSessionKey: params.parentSessionKey,
        runs: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.sessions.set(sessionKey, session);
    }

    session.runs.push(run);
    session.updatedAt = Date.now();

    return run;
  }

  /**
   * 更新运行状态
   */
  updateRunStatus(
    runId: string,
    status: SubagentRunRecord['status'],
    result?: unknown,
    error?: string,
  ): SubagentRunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    run.status = status;
    if (result !== undefined) {
      run.result = result;
    }
    if (error !== undefined) {
      run.error = error;
    }

    this.runs.set(runId, run);

    // 更新会话记录
    const session = this.sessions.get(run.sessionKey);
    if (session) {
      session.updatedAt = Date.now();
      this.sessions.set(run.sessionKey, session);
    }

    return run;
  }

  /**
   * 获取运行记录
   */
  getRun(runId: string): SubagentRunRecord | undefined {
    return this.runs.get(runId);
  }

  /**
   * 获取会话记录
   */
  getSession(sessionKey: string): SubagentSessionRecord | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * 获取指定会话的活跃运行数
   */
  countActiveRunsForSession(sessionKey: string): number {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return 0;
    }

    return session.runs.filter((run) => run.status === 'running').length;
  }

  /**
   * 列出所有运行
   */
  listRuns(filter?: {
    status?: SubagentRunRecord['status'];
    sessionKey?: string;
  }): SubagentRunRecord[] {
    let runs = Array.from(this.runs.values());

    if (filter?.status) {
      runs = runs.filter((run) => run.status === filter.status);
    }

    if (filter?.sessionKey) {
      runs = runs.filter((run) => run.sessionKey === filter.sessionKey);
    }

    return runs;
  }

  /**
   * 列出所有会话
   */
  listSessions(filter?: {
    parentSessionKey?: string;
  }): SubagentSessionRecord[] {
    let sessions = Array.from(this.sessions.values());

    if (filter?.parentSessionKey) {
      sessions = sessions.filter(
        (session) => session.parentSessionKey === filter.parentSessionKey,
      );
    }

    return sessions;
  }

  /**
   * 清除所有记录（用于测试）
   */
  clear(): void {
    this.runs.clear();
    this.sessions.clear();
  }

  /**
   * 生成运行 ID
   */
  private generateRunId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `run_${timestamp}_${random}`;
  }
}

// ============== 辅助函数（复用 OpenClaw） ==============

/**
 * 注册子 Agent 运行
 */
export function registerSubagentRun(params: {
  sessionKey: string;
  task: string;
  label?: string;
  parentSessionKey?: string;
  registry?: SubagentRegistry;
}): SubagentRunRecord {
  const reg = params.registry ?? subagentRegistry;
  return reg.register(params);
}

/**
 * 统计会话的活跃运行数
 */
export function countActiveRunsForSession(
  sessionKey: string,
  registry?: SubagentRegistry,
): number {
  const reg = registry ?? subagentRegistry;
  return reg.countActiveRunsForSession(sessionKey);
}

// ============== 全局注册表 ==============

export const subagentRegistry = new SubagentRegistry();

// ============== 会话存储集成 ==============

/**
 * 从会话存储中获取子 Agent 深度
 */
export function getSubagentDepthFromSessionStore(
  sessionKey: string | undefined | null,
  opts?: {
    store?: SessionStore;
    maxSpawnDepth?: number;
  },
): number {
  if (!sessionKey || !opts?.store) {
    return 0;
  }

  const entry = opts.store[sessionKey];
  if (!entry) {
    return 0;
  }

  // 尝试从 spawnDepth 读取
  if (typeof entry.spawnDepth === 'number') {
    return entry.spawnDepth;
  }

  // 尝试从 spawnedBy 推导
  if (entry.spawnedBy) {
    const parentEntry = opts.store[entry.spawnedBy];
    if (parentEntry) {
      const parentDepth =
        typeof parentEntry.spawnDepth === 'number' ? parentEntry.spawnDepth : 0;
      return parentDepth + 1;
    }
  }

  return 0;
}

/**
 * 合并会话条目
 */
export function mergeSessionEntry(
  existing: SessionStoreEntry | undefined,
  update: Partial<SessionStoreEntry>,
): SessionStoreEntry {
  return {
    ...existing,
    ...update,
    updatedAt: Date.now(),
  };
}
