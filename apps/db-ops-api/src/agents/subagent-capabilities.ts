/**
 * DB-Ops 子 Agent 能力管理
 *
 * 复用上游 subagent-capabilities 设计模式
 */

import { normalizeOptionalLowercaseString } from '../shared/string-coerce.js';

// ============== 常量定义 ==============

export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 3;

export const SUBAGENT_SESSION_ROLES = ['main', 'orchestrator', 'leaf'] as const;
export type SubagentSessionRole = (typeof SUBAGENT_SESSION_ROLES)[number];

export const SUBAGENT_CONTROL_SCOPES = ['children', 'none'] as const;
export type SubagentControlScope = (typeof SUBAGENT_CONTROL_SCOPES)[number];

// ============== 类型定义 ==============

interface SessionCapabilityEntry {
  sessionId?: unknown;
  spawnDepth?: unknown;
  subagentRole?: unknown;
  subagentControlScope?: unknown;
}

// ============== 辅助函数 ==============

/**
 * 规范化子 Agent 角色
 */
function normalizeSubagentRole(value: unknown): SubagentSessionRole | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_SESSION_ROLES.find((entry) => entry === trimmed);
}

/**
 * 规范化子 Agent 控制范围
 */
function normalizeSubagentControlScope(value: unknown): SubagentControlScope | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_CONTROL_SCOPES.find((entry) => entry === trimmed);
}

// ============== 核心能力解析 ==============

/**
 * 根据深度解析子 Agent 角色
 *
 * 角色分配逻辑：
 * - depth <= 0: main
 * - 0 < depth < maxSpawnDepth: orchestrator
 * - depth >= maxSpawnDepth: leaf
 */
export function resolveSubagentRoleForDepth(params: {
  depth: number;
  maxSpawnDepth?: number;
}): SubagentSessionRole {
  const depth = Number.isInteger(params.depth) ? Math.max(0, params.depth) : 0;
  const maxSpawnDepth =
    typeof params.maxSpawnDepth === 'number' && Number.isFinite(params.maxSpawnDepth)
      ? Math.max(1, Math.floor(params.maxSpawnDepth))
      : DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;

  if (depth <= 0) {
    return 'main';
  }

  return depth < maxSpawnDepth ? 'orchestrator' : 'leaf';
}

/**
 * 根据角色解析控制范围
 *
 * 控制范围逻辑：
 * - leaf: none (不能创建子 Agent)
 * - main/orchestrator: children (可以创建子 Agent)
 */
export function resolveSubagentControlScopeForRole(
  role: SubagentSessionRole,
): SubagentControlScope {
  return role === 'leaf' ? 'none' : 'children';
}

/**
 * 解析子 Agent 完整能力
 *
 * 能力解析逻辑
 */
export function resolveSubagentCapabilities(params: {
  depth: number;
  maxSpawnDepth?: number;
}): {
  depth: number;
  role: SubagentSessionRole;
  controlScope: SubagentControlScope;
  canSpawn: boolean;
  canControlChildren: boolean;
} {
  const role = resolveSubagentRoleForDepth(params);
  const controlScope = resolveSubagentControlScopeForRole(role);

  return {
    depth: Math.max(0, Math.floor(params.depth)),
    role,
    controlScope,
    canSpawn: role === 'main' || role === 'orchestrator',
    canControlChildren: controlScope === 'children',
  };
}

// ============== 会话存储能力解析 ==============

/**
 * 从会话存储中解析子 Agent 能力
 *
 * 会话存储查询逻辑
 */
export function resolveStoredSubagentCapabilities(
  sessionKey: string | undefined | null,
  opts?: {
    store?: Record<string, SessionCapabilityEntry>;
    maxSpawnDepth?: number;
  },
): {
  depth: number;
  role: SubagentSessionRole;
  controlScope: SubagentControlScope;
  canSpawn: boolean;
  canControlChildren: boolean;
} {
  // 简化的深度计算（完整实现需要 session-key 解析）
  const depth = sessionKey ? calculateDepthFromSessionKey(sessionKey) : 0;
  const maxSpawnDepth = opts?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;

  // 如果没有存储信息，使用默认深度解析
  if (!opts?.store || !sessionKey) {
    return resolveSubagentCapabilities({ depth, maxSpawnDepth });
  }

  // 尝试从存储中读取
  const entry = findEntryBySessionKey(opts.store, sessionKey);

  if (!entry) {
    return resolveSubagentCapabilities({ depth, maxSpawnDepth });
  }

  // 解析存储的角色和控制范围
  const storedRole = normalizeSubagentRole(entry.subagentRole);
  const storedControlScope = normalizeSubagentControlScope(entry.subagentControlScope);

  // 使用存储值或回退到默认值
  const role = storedRole ?? resolveSubagentRoleForDepth({ depth, maxSpawnDepth });
  const controlScope = storedControlScope ?? resolveSubagentControlScopeForRole(role);

  return {
    depth,
    role,
    controlScope,
    canSpawn: role === 'main' || role === 'orchestrator',
    canControlChildren: controlScope === 'children',
  };
}

/**
 * 从会话 Key 计算深度
 *
 * 简化的实现，完整实现需要 parseAgentSessionKey
 */
function calculateDepthFromSessionKey(sessionKey: string): number {
  // 子 Agent 会话 Key 格式：agent:<agentId>:<sessionId>:depth
  // 或 parentSessionKey.childSessionId
  const parts = sessionKey.split('.');
  return parts.length;
}

/**
 * 在存储中按 sessionId 查找条目
 */
function findEntryBySessionKey(
  store: Record<string, SessionCapabilityEntry>,
  sessionId: string,
): SessionCapabilityEntry | undefined {
  const normalizedSessionId = normalizeSubagentSessionKey(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }

  for (const entry of Object.values(store)) {
    const candidateSessionId = normalizeSubagentSessionKey(entry.sessionId);
    if (candidateSessionId === normalizedSessionId) {
      return entry;
    }
  }

  return undefined;
}

/**
 * 规范化子 Agent 会话 Key
 */
export function normalizeSubagentSessionKey(sessionKey: unknown): string | undefined {
  if (typeof sessionKey === 'string') {
    const trimmed = sessionKey.trim();
    return trimmed || undefined;
  }
  return undefined;
}

// ============== 工具函数 ==============

/**
 * 生成子 Agent 会话 Key
 */
export function generateSubagentSessionKey(parentKey?: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  const agentId = `slide_${timestamp}${random}`;

  if (parentKey) {
    return `${parentKey}.${agentId}`;
  }

  return `agent:slide:default:${agentId}`;
}

/**
 * 解析 Agent 层级
 */
export function parseAgentHierarchy(agentKey: string): {
  rootId: string;
  parentId?: string;
  depth: number;
} {
  const parts = agentKey.split('.');
  return {
    rootId: parts[0],
    parentId: parts.length > 1 ? parts.slice(0, -1).join('.') : undefined,
    depth: parts.length,
  };
}

/**
 * 检查是否是子 Agent 会话 Key
 */
export function isSubagentSessionKey(key: string): boolean {
  return key.includes('agent:') || key.includes('.');
}
