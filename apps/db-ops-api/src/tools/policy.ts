/**
 * DB-Ops 工具访问控制策略
 *
 * 复用上游 tool-policy 设计模式
 * - 工具策略配置 (allow/deny)
 * - 角色权限映射
 * - Owner-only 工具控制
 * - 工具组展开
 */

import type { AnyAgentTool, ToolPolicy, RoleToolPolicy } from './types.js';
import { normalizeToolName, normalizeToolList, toolCatalog } from './catalog.js';

// ============== 工具策略解析 ==============

/**
 * 展开工具组引用
 *
 * 支持的工具组引用格式：
 * - `*` - 所有工具
 * - `group:groupName` - 指定分组下的所有工具
 * - `toolName` - 具体工具名称
 */
export function expandToolGroups(entries: string[]): string[] {
  const expanded: string[] = [];

  for (const entry of entries) {
    const normalized = normalizeToolName(entry);

    // 通配符
    if (normalized === '*') {
      expanded.push('*');
      continue;
    }

    // 分组引用
    if (normalized.startsWith('group:')) {
      const groupName = normalized.slice(6);
      const groupTools = toolCatalog.expandGroup(groupName);
      if (groupTools.length > 0) {
        expanded.push(...groupTools);
      } else {
        // 分组不存在，保留原引用
        expanded.push(normalized);
      }
      continue;
    }

    // 普通工具名称
    expanded.push(normalized);
  }

  return Array.from(new Set(expanded));
}

/**
 * 解析工具策略
 */
export function resolveToolPolicy(
  policy: ToolPolicy | undefined,
): {
  allowed: Set<string>;
  denied: Set<string>;
  allowAll: boolean;
} {
  if (!policy) {
    return {
      allowed: new Set(),
      denied: new Set(),
      allowAll: false,
    };
  }

  const allowAll = policy.allow?.includes('*') ?? false;
  const allowed = new Set(expandToolGroups(policy.allow ?? []));
  const denied = new Set(expandToolGroups(policy.deny ?? []));

  // 从允许列表中移除拒绝的工具
  denied.forEach((toolName) => {
    allowed.delete(toolName);
  });

  return { allowed, denied, allowAll };
}

/**
 * 检查工具是否被允许
 */
export function isToolAllowed(
  toolName: string,
  policy: ToolPolicy | undefined,
): boolean {
  const normalized = normalizeToolName(toolName);
  const { allowed, denied, allowAll } = resolveToolPolicy(policy);

  // 明确拒绝的工具
  if (denied.has(normalized)) {
    return false;
  }

  // 允许所有模式
  if (allowAll) {
    return true;
  }

  // 检查是否在允许列表中
  return allowed.has(normalized);
}

// ============== 角色权限管理 ==============

/**
 * 默认角色权限配置
 *
 * 角色说明：
 * - admin: 超级管理员，拥有所有权限
 * - dba: 数据库管理员，拥有运维相关权限
 * - developer: 开发人员，只读和分析权限
 * - analyst: 分析师，只读权限
 * - viewer: 访客，基础查看权限
 * - auditor: 审计员，查看 + 审计日志权限
 */
export const DEFAULT_ROLE_POLICIES: RoleToolPolicy[] = [
  {
    roleName: 'admin',
    policy: {
      allow: ['*'],
      deny: [],
    },
    requiresApprovalFor: [],
  },
  {
    roleName: 'dba',
    policy: {
      allow: [
        'group:db_ops',
        'group:health_check',
        'group:performance',
        'group:diagnosis',
        'group:llm_ops',
      ],
      deny: [
        'slide_restart_service',
        'slide_delete_instance',
        'slide_reset_system',
      ],
    },
    requiresApprovalFor: [
      'slide_update_config',
      'slide_delete_instance',
    ],
  },
  {
    roleName: 'developer',
    policy: {
      allow: [
        'db_query',
        'sql_optimize',
        'view_logs',
        'group:health_check',
        'group:performance',
      ],
      deny: [
        'group:admin_only',
        'slide_update_config',
        'slide_delete_instance',
      ],
    },
    requiresApprovalFor: [],
  },
  {
    roleName: 'analyst',
    policy: {
      allow: ['group:health_check', 'group:performance', 'view_*'],
      deny: ['*'],
    },
    requiresApprovalFor: [],
  },
  {
    roleName: 'viewer',
    policy: {
      allow: ['view_status', 'view_health'],
      deny: ['*'],
    },
    requiresApprovalFor: [],
  },
  {
    roleName: 'auditor',
    policy: {
      allow: ['view_*', 'audit_*', 'group:health_check'],
      deny: ['modify_*', 'delete_*'],
    },
    requiresApprovalFor: [],
  },
];

/**
 * 角色权限映射表
 */
class RolePolicyRegistry {
  private policies: Map<string, RoleToolPolicy> = new Map();

  /**
   * 注册角色策略
   */
  register(policy: RoleToolPolicy): void {
    const normalizedRole = normalizeToolName(policy.roleName);
    this.policies.set(normalizedRole, policy);
  }

  /**
   * 批量注册
   */
  registerAll(policies: RoleToolPolicy[]): void {
    for (const policy of policies) {
      this.register(policy);
    }
  }

  /**
   * 获取角色策略
   */
  get(roleName: string): RoleToolPolicy | undefined {
    const normalized = normalizeToolName(roleName);
    return this.policies.get(normalized);
  }

  /**
   * 获取所有角色策略
   */
  getAll(): RoleToolPolicy[] {
    return Array.from(this.policies.values());
  }

  /**
   * 检查角色是否存在
   */
  has(roleName: string): boolean {
    const normalized = normalizeToolName(roleName);
    return this.policies.has(normalized);
  }

  /**
   * 清除所有策略（用于测试）
   */
  clear(): void {
    this.policies.clear();
  }
}

/**
 * 全局角色策略注册表
 */
export const rolePolicyRegistry = new RolePolicyRegistry();

// 初始化时注册默认策略
rolePolicyRegistry.registerAll(DEFAULT_ROLE_POLICIES);

// ============== 工具过滤 ==============

/**
 * 根据角色过滤可用工具列表
 */
export function filterToolsByRole(
  tools: AnyAgentTool[],
  roleName: string,
): AnyAgentTool[] {
  const policy = rolePolicyRegistry.get(roleName);
  if (!policy) {
    console.warn(`[ToolPolicy] 未知角色：${roleName}，返回空列表`);
    return [];
  }

  return tools.filter(tool =>
    isToolAllowed(tool.name, policy.policy),
  );
}

/**
 * 获取角色可用工具名称列表
 */
export function getAvailableToolsForRole(roleName: string): string[] {
  const policy = rolePolicyRegistry.get(roleName);
  if (!policy) {
    return [];
  }

  const allTools = toolCatalog.getAll();
  const filtered = filterToolsByRole(allTools, roleName);
  return filtered.map(tool => tool.name);
}

// ============== Owner-Only 工具控制（复用上游） ==============

/**
 * Owner-only 工具审批类别
 */
export type OwnerOnlyToolApprovalClass =
  | 'control_plane'
  | 'exec_capable'
  | 'interactive';

/**
 * Owner-only 工具类别映射
 */
const OWNER_ONLY_TOOL_APPROVAL_CLASS_FALLBACKS = new Map<
  string,
  OwnerOnlyToolApprovalClass
>([
  ['slide_restart_service', 'control_plane'],
  ['slide_reset_system', 'control_plane'],
  ['slide_delete_instance', 'exec_capable'],
  ['slide_update_config', 'control_plane'],
  ['slide_rotate_secrets', 'control_plane'],
]);

/**
 * 解析工具的 Owner-only 审批类别
 */
export function resolveOwnerOnlyToolApprovalClass(
  name: string,
): OwnerOnlyToolApprovalClass | undefined {
  const normalized = normalizeToolName(name);
  return (
    OWNER_ONLY_TOOL_APPROVAL_CLASS_FALLBACKS.get(normalized) ||
    (normalized.includes('restart') ||
    normalized.includes('reset') ||
    normalized.includes('delete')
      ? 'control_plane'
      : undefined)
  );
}

/**
 * 检查工具是否是 Owner-only
 */
export function isOwnerOnlyTool(tool: AnyAgentTool): boolean {
  return (
    tool.ownerOnly === true ||
    isOwnerOnlyToolName(tool.name)
  );
}

/**
 * 检查工具名称是否是 Owner-only
 */
export function isOwnerOnlyToolName(name: string): boolean {
  return resolveOwnerOnlyToolApprovalClass(name) !== undefined;
}

/**
 * 应用 Owner-only 工具策略
 *
 * @param tools 工具列表
 * @param senderIsOwner 发送者是否是 owner
 */
export function applyOwnerOnlyToolPolicy(
  tools: AnyAgentTool[],
  senderIsOwner: boolean,
): AnyAgentTool[] {
  if (senderIsOwner) {
    // Owner 可以看到所有工具
    return tools;
  }

  // 非 Owner 用户，过滤掉 owner-only 工具
  return tools.filter(tool => !isOwnerOnlyTool(tool));
}

/**
 * 包装 Owner-only 工具执行器
 *
 * 如果非 owner 用户尝试调用 owner-only 工具，抛出错误
 */
export function wrapOwnerOnlyToolExecution(
  tool: AnyAgentTool,
  senderIsOwner: boolean,
): AnyAgentTool {
  if (tool.ownerOnly !== true || senderIsOwner) {
    return tool;
  }

  return {
    ...tool,
    handler: async () => ({
      success: false,
      error: '此工具仅限管理员调用',
      errorCode: 'OWNER_ONLY_TOOL',
    }),
  };
}

// ============== 工具策略应用 ==============

/**
 * 应用完整的工具策略（包括 allow/deny 和 owner-only）
 */
export function applyToolPolicy(
  tools: AnyAgentTool[],
  roleName: string,
  senderIsOwner: boolean,
): AnyAgentTool[] {
  // 1. 先应用角色策略过滤
  const roleFiltered = filterToolsByRole(tools, roleName);

  // 2. 再应用 owner-only 策略
  return applyOwnerOnlyToolPolicy(roleFiltered, senderIsOwner);
}

/**
 * 检查用户是否有调用工具的权限
 */
export function checkToolPermission(
  toolName: string,
  roleName: string,
  senderIsOwner: boolean,
): {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
} {
  const normalized = normalizeToolName(toolName);
  const policy = rolePolicyRegistry.get(roleName);

  if (!policy) {
    return {
      allowed: false,
      reason: `未知角色：${roleName}`,
    };
  }

  // 检查是否是 owner-only 工具
  if (isOwnerOnlyToolName(normalized) && !senderIsOwner) {
    return {
      allowed: false,
      reason: '此工具仅限管理员调用',
    };
  }

  // 检查工具是否被允许
  if (!isToolAllowed(normalized, policy.policy)) {
    return {
      allowed: false,
      reason: '角色权限不足',
    };
  }

  // 检查是否需要审批
  const requiresApproval = policy.requiresApprovalFor?.includes(normalized) ?? false;

  return {
    allowed: true,
    requiresApproval,
  };
}

// ============== 工具组合并（复用上游） ==============

/**
 * 合并多个工具策略
 */
export function mergeToolPolicies(
  ...policies: Array<ToolPolicy | undefined>
): ToolPolicy {
  const allowSet = new Set<string>();
  const denySet = new Set<string>();

  for (const policy of policies) {
    if (!policy) continue;

    if (policy.allow) {
      for (const entry of policy.allow) {
        allowSet.add(normalizeToolName(entry));
      }
    }
    if (policy.deny) {
      for (const entry of policy.deny) {
        denySet.add(normalizeToolName(entry));
      }
    }
  }

  return {
    allow: Array.from(allowSet),
    deny: Array.from(denySet),
  };
}

/**
 * 添加额外的允许工具到策略
 */
export function mergeAlsoAllowPolicy(
  policy: ToolPolicy | undefined,
  alsoAllow?: string[],
): ToolPolicy | undefined {
  if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) {
    return policy;
  }

  return {
    ...policy,
    allow: Array.from(new Set([...policy.allow, ...alsoAllow])),
  };
}
