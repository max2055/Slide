/**
 * DB-Ops 会话存储
 *
 * 复用 OpenClaw 的 session-store 机制
 * 参考：openclaw_source_code/src/config/sessions.ts
 *      openclaw_source_code/src/agents/session-dirs.ts
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';

// ============== 会话存储类型 ==============

/**
 * 会话存储条目
 */
export interface SessionStoreEntry {
  /** 会话 ID */
  sessionId?: string;
  /** 生成深度 */
  spawnDepth?: number;
  /** 父会话 Key */
  spawnedBy?: string;
  /** 子 Agent 角色 */
  subagentRole?: string;
  /** 子 Agent 控制范围 */
  subagentControlScope?: string;
  /** 使用的模型 */
  model?: string;
  /** 模型提供商 */
  modelProvider?: string;
  /** 创建时间 */
  createdAt?: number;
  /** 更新时间 */
  updatedAt?: number;
}

/**
 * 会话存储
 */
export type SessionStore = Record<string, SessionStoreEntry>;

// ============== 会话目录解析（复用 OpenClaw） ==============

function mapAgentSessionDirs(agentsDir: string, entries: Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(agentsDir, entry.name, 'sessions'))
    .toSorted((a, b) => a.localeCompare(b));
}

/**
 * 从 agents 目录解析会话目录
 */
export async function resolveAgentSessionDirsFromAgentsDir(
  agentsDir: string,
): Promise<string[]> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  return mapAgentSessionDirs(agentsDir, entries);
}

/**
 * 同步从 agents 目录解析会话目录
 */
export function resolveAgentSessionDirsFromAgentsDirSync(agentsDir: string): string[] {
  let entries: Dirent[] = [];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  return mapAgentSessionDirs(agentsDir, entries);
}

/**
 * 从 state 目录解析会话目录
 */
export async function resolveAgentSessionDirs(stateDir: string): Promise<string[]> {
  return await resolveAgentSessionDirsFromAgentsDir(path.join(stateDir, 'agents'));
}

// ============== 会话存储加载（复用 OpenClaw） ==============

/**
 * 解析存储路径
 */
export function resolveStorePath(
  storeConfig: string | undefined,
  context: { agentId: string },
): string {
  if (storeConfig) {
    return storeConfig.replace('{agentId}', context.agentId);
  }
  // 默认路径
  return path.join(process.cwd(), '.slide', 'agents', context.agentId, 'sessions', 'store.json');
}

/**
 * 加载会话存储
 */
export function loadSessionStore(storePath: string): SessionStore {
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SessionStore;
    }
  } catch {
    // 文件不存在或解析失败
  }
  return {};
}

/**
 * 保存会话存储
 */
export async function saveSessionStore(
  storePath: string,
  store: SessionStore,
): Promise<void> {
  const dir = path.dirname(storePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * 更新会话存储
 */
export async function updateSessionStore(
  storePath: string,
  mutator: (store: SessionStore) => void | SessionStore,
): Promise<SessionStore> {
  const store = loadSessionStore(storePath);
  const result = mutator(store);
  const finalStore = result ?? store;
  await saveSessionStore(storePath, finalStore);
  return finalStore;
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

/**
 * 清理存储键（移除旧格式键）
 */
export function pruneLegacyStoreKeys(params: {
  store: SessionStore;
  canonicalKey: string;
  candidates: string[];
}): void {
  const { store, canonicalKey, candidates } = params;

  // 保留规范键，清理其他候选键
  for (const candidate of candidates) {
    if (candidate !== canonicalKey && store[candidate]) {
      delete store[candidate];
    }
  }
}

// ============== 会话管理（复用 OpenClaw） ==============

/**
 * 网关会话存储目标
 */
export function resolveGatewaySessionStoreTarget(params: {
  cfg?: { session?: { store?: string } };
  key: string;
}): {
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
} {
  const agentId = extractAgentIdFromKey(params.key);
  const storePath = resolveStorePath(params.cfg?.session?.store, { agentId });
  const canonicalKey = params.key;

  return {
    storePath,
    canonicalKey,
    storeKeys: [canonicalKey],
  };
}

/**
 * 从会话 Key 提取 Agent ID
 */
function extractAgentIdFromKey(key: string): string {
  // 格式：agent:<agentId>:<sessionId> 或 parent.child
  const parts = key.split(':');
  if (parts.length >= 2) {
    return parts[1];
  }

  const dotParts = key.split('.');
  return dotParts[0] || 'default';
}

// ============== 会话生命周期 ==============

/**
 * 会话生命周期事件类型
 */
export type SessionLifecycleEventType =
  | 'session.created'
  | 'session.resumed'
  | 'session.completed'
  | 'session.deleted'
  | 'session.error';

/**
 * 会话生命周期事件
 */
export interface SessionLifecycleEvent {
  type: SessionLifecycleEventType;
  sessionKey: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * 发射会话生命周期事件
 *
 * 简化实现，完整实现需要 hooks 系统
 */
export async function emitSessionLifecycleEvent(
  event: SessionLifecycleEvent,
): Promise<void> {
  // 简化实现：记录日志
  console.log(`[SessionLifecycle] ${event.type}: ${event.sessionKey}`);
}

// ============== 辅助函数 ==============

/**
 * 创建会话存储条目
 */
export function createSessionEntry(
  overrides?: Partial<SessionStoreEntry>,
): SessionStoreEntry {
  return {
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * 检查会话是否存在
 */
export function hasSession(store: SessionStore, key: string): boolean {
  return key in store;
}

/**
 * 获取会话
 */
export function getSession(
  store: SessionStore,
  key: string,
): SessionStoreEntry | undefined {
  return store[key];
}

/**
 * 删除会话
 */
export function deleteSession(store: SessionStore, key: string): boolean {
  if (key in store) {
    delete store[key];
    return true;
  }
  return false;
}

/**
 * 列出所有会话
 */
export function listSessions(store: SessionStore): SessionStoreEntry[] {
  return Object.values(store);
}
