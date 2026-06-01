/**
 * DB-Ops 角色权限映射
 *
 * 复用 OpenClaw 的 tool-policy.ts 设计模式
 * 定义系统角色和对应的工具访问权限
 */

import type { ToolPolicy, RoleToolPolicy } from '../tools/types.js';
import { normalizeToolName } from '../tools/catalog.js';

// ============== 角色定义 ==============

/**
 * 系统角色类型
 */
export type SystemRole = 'admin' | 'dba' | 'developer' | 'analyst' | 'viewer' | 'auditor';

/**
 * 权限级别
 */
export type PermissionLevel = 'read' | 'write' | 'admin' | 'audit';

// ============== 角色权限矩阵 ==============

/**
 * 默认角色权限配置
 *
 * 角色说明：
 * - admin: 超级管理员，拥有所有权限
 * - dba: 数据库管理员，拥有运维相关权限
 * - developer: 开发人员，SQL 分析和优化权限
 * - analyst: 分析师，只读和分析权限
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
    permissionLevel: 'admin',
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
        'group:slide_self_mgmt',
      ],
      deny: [
        'slide_restart_service',
        'slide_delete_instance',
        'slide_reset_system',
        'slide_rotate_secrets',
      ],
    },
    requiresApprovalFor: [
      'slide_update_config',
      'slide_delete_instance',
      'slide_update_llm_config',
    ],
    permissionLevel: 'write',
  },
  {
    roleName: 'developer',
    policy: {
      allow: [
        'db_query',
        'sql_optimize',
        'sql_explain',
        'view_logs',
        'group:health_check',
        'group:performance',
        'group:diagnosis',
      ],
      deny: [
        'group:admin_only',
        'slide_update_config',
        'slide_delete_instance',
        'slide_update_llm_config',
        'slide_restart_service',
      ],
    },
    requiresApprovalFor: [],
    permissionLevel: 'write',
  },
  {
    roleName: 'analyst',
    policy: {
      allow: [
        'group:health_check',
        'group:performance',
        'view_*',
        'db_query_readonly',
      ],
      deny: ['*'],
    },
    requiresApprovalFor: [],
    permissionLevel: 'read',
  },
  {
    roleName: 'viewer',
    policy: {
      allow: [
        'view_status',
        'view_health',
        'view_dashboard',
      ],
      deny: ['*'],
    },
    requiresApprovalFor: [],
    permissionLevel: 'read',
  },
  {
    roleName: 'auditor',
    policy: {
      allow: [
        'view_*',
        'audit_*',
        'group:health_check',
        'audit_log_query',
        'audit_log_export',
      ],
      deny: [
        'modify_*',
        'delete_*',
        'slide_update_config',
      ],
    },
    requiresApprovalFor: [],
    permissionLevel: 'audit',
  },
];

// ============== 危险操作定义 ==============

/**
 * 危险操作等级
 */
export type DangerLevel = 1 | 2 | 3 | 4;

/**
 * 危险操作定义
 *
 * Level 1: 低风险 - 仅需记录
 * Level 2: 中风险 - 需要 DBA 审批
 * Level 3: 高风险 - 需要 admin 审批
 * Level 4: 极高风险 - 需要多重审批
 */
export const DANGER_OPERATIONS: Record<string, DangerLevel> = {
  // 配置修改
  slide_update_config: 2,
  slide_update_llm_config: 2,

  // 实例管理
  slide_delete_instance: 3,
  slide_update_db_credentials: 3,

  // 系统操作
  slide_restart_service: 3,
  slide_reset_system: 4,
  slide_rotate_secrets: 4,

  // 数据操作
  db_delete_data: 3,
  db_truncate_table: 4,

  // 权限管理
  user_create_admin: 3,
  user_delete_admin: 4,
  user_modify_role: 2,
};

/**
 * 获取操作的危险等级
 */
export function getOperationDangerLevel(operationName: string): DangerLevel | undefined {
  const normalized = normalizeToolName(operationName);
  return DANGER_OPERATIONS[normalized];
}

/**
 * 检查操作是否需要审批
 */
export function requiresApproval(operationName: string, roleName: SystemRole): boolean {
  const dangerLevel = getOperationDangerLevel(operationName);

  if (dangerLevel === undefined) {
    return false;
  }

  // 根据角色和危险等级判断
  switch (roleName) {
    case 'admin':
      return dangerLevel >= 4;
    case 'dba':
      return dangerLevel >= 2;
    default:
      return dangerLevel >= 1;
  }
}

// ============== 角色权限注册表 ==============

/**
 * 角色权限注册表
 */
export class RolePermissionRegistry {
  private policies: Map<SystemRole, RoleToolPolicy> = new Map();

  /**
   * 注册角色策略
   */
  register(policy: RoleToolPolicy): void {
    const normalizedRole = normalizeToolName(policy.roleName) as SystemRole;
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
  get(roleName: SystemRole | string): RoleToolPolicy | undefined {
    const normalized = normalizeToolName(roleName) as SystemRole;
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
    const normalized = normalizeToolName(roleName) as SystemRole;
    return this.policies.has(normalized);
  }

  /**
   * 获取角色的权限级别
   */
  getPermissionLevel(roleName: string): PermissionLevel | undefined {
    const policy = this.get(roleName);
    return policy?.permissionLevel;
  }

  /**
   * 清除所有策略（用于测试）
   */
  clear(): void {
    this.policies.clear();
  }
}

/**
 * 全局角色权限注册表
 */
export const rolePermissionRegistry = new RolePermissionRegistry();

// 初始化时注册默认策略
rolePermissionRegistry.registerAll(DEFAULT_ROLE_POLICIES);

// ============== 权限检查辅助函数 ==============

/**
 * 检查角色是否有指定权限级别
 */
export function hasPermissionLevel(roleName: string, requiredLevel: PermissionLevel): boolean {
  const levelHierarchy: Record<PermissionLevel, number> = {
    read: 1,
    write: 2,
    admin: 3,
    audit: 4,
  };

  const policy = rolePermissionRegistry.get(roleName);
  if (!policy?.permissionLevel) {
    return false;
  }

  return levelHierarchy[policy.permissionLevel] >= levelHierarchy[requiredLevel];
}

/**
 * 获取角色需要审批的操作列表
 */
export function getRequiresApprovalForRole(roleName: string): string[] {
  const policy = rolePermissionRegistry.get(roleName);
  return policy?.requiresApprovalFor ?? [];
}

/**
 * 检查操作是否在角色的审批列表中
 */
export function isOperationInApprovalList(operationName: string, roleName: string): boolean {
  const approvalList = getRequiresApprovalForRole(roleName);
  const normalized = normalizeToolName(operationName);
  return approvalList.some(item => normalizeToolName(item) === normalized);
}

// ============== 导出 ==============

export type { ToolPolicy } from '../tools/types.js';
