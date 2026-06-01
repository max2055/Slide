/**
 * 角色权限映射单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_ROLE_POLICIES,
  DANGER_OPERATIONS,
  getOperationDangerLevel,
  requiresApproval,
  RolePermissionRegistry,
  rolePermissionRegistry,
  hasPermissionLevel,
  getRequiresApprovalForRole,
  isOperationInApprovalList,
} from './role-permissions.js';

describe('DEFAULT_ROLE_POLICIES', () => {
  it('应该定义 admin 角色的完整权限', () => {
    const adminPolicy = DEFAULT_ROLE_POLICIES.find(p => p.roleName === 'admin');
    expect(adminPolicy).toBeDefined();
    expect(adminPolicy?.policy.allow).toEqual(['*']);
    expect(adminPolicy?.policy.deny).toEqual([]);
    expect(adminPolicy?.permissionLevel).toBe('admin');
  });

  it('应该定义 dba 角色的运维权限', () => {
    const dbaPolicy = DEFAULT_ROLE_POLICIES.find(p => p.roleName === 'dba');
    expect(dbaPolicy).toBeDefined();
    expect(dbaPolicy?.policy.allow).toContain('group:db_ops');
    expect(dbaPolicy?.policy.deny).toContain('slide_restart_service');
    expect(dbaPolicy?.permissionLevel).toBe('write');
  });

  it('应该定义 developer 角色的开发权限', () => {
    const developerPolicy = DEFAULT_ROLE_POLICIES.find(p => p.roleName === 'developer');
    expect(developerPolicy).toBeDefined();
    expect(developerPolicy?.policy.allow).toContain('db_query');
    expect(developerPolicy?.policy.allow).toContain('sql_optimize');
    expect(developerPolicy?.permissionLevel).toBe('write');
  });

  it('应该定义 analyst 角色的只读权限', () => {
    const analystPolicy = DEFAULT_ROLE_POLICIES.find(p => p.roleName === 'analyst');
    expect(analystPolicy).toBeDefined();
    expect(analystPolicy?.policy.allow).toContain('group:health_check');
    expect(analystPolicy?.policy.deny).toEqual(['*']);
    expect(analystPolicy?.permissionLevel).toBe('read');
  });

  it('应该定义 viewer 角色的基础查看权限', () => {
    const viewerPolicy = DEFAULT_ROLE_POLICIES.find(p => p.roleName === 'viewer');
    expect(viewerPolicy).toBeDefined();
    expect(viewerPolicy?.policy.allow).toEqual([
      'view_status',
      'view_health',
      'view_dashboard',
    ]);
    expect(viewerPolicy?.permissionLevel).toBe('read');
  });

  it('应该定义 auditor 角色的审计权限', () => {
    const auditorPolicy = DEFAULT_ROLE_POLICIES.find(p => p.roleName === 'auditor');
    expect(auditorPolicy).toBeDefined();
    expect(auditorPolicy?.policy.allow).toContain('audit_*');
    expect(auditorPolicy?.policy.deny).toContain('modify_*');
    expect(auditorPolicy?.permissionLevel).toBe('audit');
  });
});

describe('DANGER_OPERATIONS', () => {
  it('应该定义配置修改为 Level 2', () => {
    expect(DANGER_OPERATIONS['slide_update_config']).toBe(2);
    expect(DANGER_OPERATIONS['slide_update_llm_config']).toBe(2);
  });

  it('应该定义实例管理为 Level 3', () => {
    expect(DANGER_OPERATIONS['slide_delete_instance']).toBe(3);
    expect(DANGER_OPERATIONS['slide_update_db_credentials']).toBe(3);
  });

  it('应该定义系统操作为 Level 3-4', () => {
    expect(DANGER_OPERATIONS['slide_restart_service']).toBe(3);
    expect(DANGER_OPERATIONS['slide_reset_system']).toBe(4);
    expect(DANGER_OPERATIONS['slide_rotate_secrets']).toBe(4);
  });

  it('应该定义数据操作为 Level 3-4', () => {
    expect(DANGER_OPERATIONS['db_delete_data']).toBe(3);
    expect(DANGER_OPERATIONS['db_truncate_table']).toBe(4);
  });

  it('应该定义权限管理为 Level 2-4', () => {
    expect(DANGER_OPERATIONS['user_create_admin']).toBe(3);
    expect(DANGER_OPERATIONS['user_delete_admin']).toBe(4);
    expect(DANGER_OPERATIONS['user_modify_role']).toBe(2);
  });
});

describe('getOperationDangerLevel', () => {
  it('应该返回操作的危险等级', () => {
    expect(getOperationDangerLevel('slide_update_config')).toBe(2);
    expect(getOperationDangerLevel('slide_delete_instance')).toBe(3);
    expect(getOperationDangerLevel('slide_reset_system')).toBe(4);
  });

  it('应该返回 undefined 对于未定义的操作', () => {
    expect(getOperationDangerLevel('unknown_operation')).toBeUndefined();
  });

  it('应该规范化操作名称', () => {
    expect(getOperationDangerLevel('SLIDE_UPDATE_CONFIG')).toBe(2);
  });
});

describe('requiresApproval', () => {
  it('应该要求 admin 审批 Level 4 操作', () => {
    expect(requiresApproval('slide_reset_system', 'admin')).toBe(true);
    expect(requiresApproval('slide_rotate_secrets', 'admin')).toBe(true);
  });

  it('不应该要求 admin 审批 Level 1-3 操作', () => {
    expect(requiresApproval('slide_update_config', 'admin')).toBe(false);
    expect(requiresApproval('slide_delete_instance', 'admin')).toBe(false);
    expect(requiresApproval('slide_restart_service', 'admin')).toBe(false);
  });

  it('应该要求 dba 审批 Level 2+ 操作', () => {
    expect(requiresApproval('slide_update_config', 'dba')).toBe(true);
    expect(requiresApproval('slide_delete_instance', 'dba')).toBe(true);
    expect(requiresApproval('slide_restart_service', 'dba')).toBe(true);
  });

  it('不应该要求 dba 审批 Level 1 操作', () => {
    // 目前没有 Level 1 的操作定义
    // expect(requiresApproval('some_level1_op', 'dba')).toBe(false);
  });

  it('应该要求 developer 审批 Level 1+ 操作', () => {
    expect(requiresApproval('slide_update_config', 'developer')).toBe(true);
    expect(requiresApproval('slide_delete_instance', 'developer')).toBe(true);
  });

  it('应该返回 false 对于未定义危险等级的操作', () => {
    expect(requiresApproval('unknown_operation', 'admin')).toBe(false);
    expect(requiresApproval('unknown_operation', 'dba')).toBe(false);
  });
});

describe('RolePermissionRegistry', () => {
  let registry: RolePermissionRegistry;

  beforeEach(() => {
    registry = new RolePermissionRegistry();
  });

  describe('register', () => {
    it('应该注册角色策略', () => {
      const policy = {
        roleName: 'test_role',
        policy: { allow: ['test_tool'], deny: [] },
        requiresApprovalFor: [],
        permissionLevel: 'read' as const,
      };

      registry.register(policy);
      const retrieved = registry.get('test_role');

      expect(retrieved).toBeDefined();
      expect(retrieved?.roleName).toBe('test_role');
    });

    it('应该规范化角色名称', () => {
      const policy = {
        roleName: 'TEST_ROLE',
        policy: { allow: ['test_tool'], deny: [] },
        requiresApprovalFor: [],
        permissionLevel: 'read' as const,
      };

      registry.register(policy);
      const retrieved = registry.get('test_role');

      expect(retrieved).toBeDefined();
    });
  });

  describe('registerAll', () => {
    it('应该批量注册策略', () => {
      const policies = [
        {
          roleName: 'role1',
          policy: { allow: ['tool1'], deny: [] },
          requiresApprovalFor: [],
          permissionLevel: 'read' as const,
        },
        {
          roleName: 'role2',
          policy: { allow: ['tool2'], deny: [] },
          requiresApprovalFor: [],
          permissionLevel: 'write' as const,
        },
      ];

      registry.registerAll(policies);
      expect(registry.get('role1')).toBeDefined();
      expect(registry.get('role2')).toBeDefined();
    });
  });

  describe('get', () => {
    it('应该获取角色策略', () => {
      const policy = {
        roleName: 'test_role',
        policy: { allow: ['test_tool'], deny: [] },
        requiresApprovalFor: [],
        permissionLevel: 'read' as const,
      };

      registry.register(policy);
      const retrieved = registry.get('test_role');

      expect(retrieved).toEqual(policy);
    });

    it('应该返回 undefined 对于不存在的角色', () => {
      const retrieved = registry.get('non_existent_role');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('应该获取所有策略', () => {
      const policies = [
        {
          roleName: 'role1',
          policy: { allow: ['tool1'], deny: [] },
          requiresApprovalFor: [],
          permissionLevel: 'read' as const,
        },
        {
          roleName: 'role2',
          policy: { allow: ['tool2'], deny: [] },
          requiresApprovalFor: [],
          permissionLevel: 'write' as const,
        },
      ];

      registry.registerAll(policies);
      const all = registry.getAll();

      expect(all).toHaveLength(2);
    });
  });

  describe('has', () => {
    it('应该检查角色是否存在', () => {
      const policy = {
        roleName: 'test_role',
        policy: { allow: ['test_tool'], deny: [] },
        requiresApprovalFor: [],
        permissionLevel: 'read' as const,
      };

      registry.register(policy);
      expect(registry.has('test_role')).toBe(true);
      expect(registry.has('non_existent_role')).toBe(false);
    });
  });

  describe('getPermissionLevel', () => {
    it('应该获取角色的权限级别', () => {
      const policy = {
        roleName: 'test_role',
        policy: { allow: ['test_tool'], deny: [] },
        requiresApprovalFor: [],
        permissionLevel: 'write' as const,
      };

      registry.register(policy);
      const level = registry.getPermissionLevel('test_role');

      expect(level).toBe('write');
    });

    it('应该返回 undefined 对于不存在的角色', () => {
      const level = registry.getPermissionLevel('non_existent_role');
      expect(level).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('应该清除所有策略', () => {
      const policy = {
        roleName: 'test_role',
        policy: { allow: ['test_tool'], deny: [] },
        requiresApprovalFor: [],
        permissionLevel: 'read' as const,
      };

      registry.register(policy);
      registry.clear();

      expect(registry.getAll()).toHaveLength(0);
    });
  });
});

describe('rolePermissionRegistry singleton', () => {
  it('应该导出单例', () => {
    expect(rolePermissionRegistry).toBeInstanceOf(RolePermissionRegistry);
  });

  it('应该预注册默认策略', () => {
    const all = rolePermissionRegistry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(5); // admin, dba, developer, analyst, viewer, auditor
  });
});

describe('hasPermissionLevel', () => {
  it('应该检查角色是否有指定权限级别', () => {
    expect(hasPermissionLevel('admin', 'admin')).toBe(true);
    expect(hasPermissionLevel('admin', 'write')).toBe(true);
    expect(hasPermissionLevel('dba', 'write')).toBe(true);
    expect(hasPermissionLevel('dba', 'read')).toBe(true);
    expect(hasPermissionLevel('analyst', 'read')).toBe(true);
  });

  it('应该返回 false 对于不存在的角色', () => {
    expect(hasPermissionLevel('non_existent_role', 'read')).toBe(false);
  });
});

describe('getRequiresApprovalForRole', () => {
  it('应该获取角色需要审批的操作列表', () => {
    const approvalList = getRequiresApprovalForRole('dba');
    expect(approvalList).toContain('slide_update_config');
    expect(approvalList).toContain('slide_delete_instance');
  });

  it('应该返回空数组对于没有审批列表的角色', () => {
    const approvalList = getRequiresApprovalForRole('admin');
    expect(approvalList).toEqual([]);
  });
});

describe('isOperationInApprovalList', () => {
  it('应该检查操作是否在角色的审批列表中', () => {
    expect(isOperationInApprovalList('slide_update_config', 'dba')).toBe(true);
    expect(isOperationInApprovalList('slide_delete_instance', 'dba')).toBe(true);
  });

  it('应该返回 false 对于不在审批列表中的操作', () => {
    expect(isOperationInApprovalList('db_query', 'dba')).toBe(false);
  });

  it('应该规范化操作名称', () => {
    expect(isOperationInApprovalList('SLIDE_UPDATE_CONFIG', 'dba')).toBe(true);
  });
});
