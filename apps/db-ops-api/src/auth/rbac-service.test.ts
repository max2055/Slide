/**
 * RbacService unit tests
 *
 * Follows the existing role-permissions.test.ts pattern:
 * - vitest describe/it/expect
 * - vi.mock for dbConnection
 * - Mock pool.execute() to return controlled test data
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RbacService } from './rbac-service.js';

// Mock dbConnection
vi.mock('../db-connection.js', () => ({
  dbConnection: {
    getPool: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

import { dbConnection } from '../db-connection.js';

describe('RbacService - Roles', () => {
  let service: RbacService;
  let mockExecute: any;

  beforeEach(() => {
    service = new RbacService();
    mockExecute = vi.fn();
    (dbConnection.getPool as any).mockReturnValue({ execute: mockExecute });
  });

  it('should create a role and return its ID', async () => {
    mockExecute.mockResolvedValueOnce([{ insertId: 1 }]);
    const result = await service.createRole('test_role', 'Test role description');
    expect(result.success).toBe(true);
    expect(result.roleId).toBe(1);
    expect(mockExecute).toHaveBeenCalledWith(
      'INSERT INTO roles (name, description, is_system) VALUES (?, ?, ?)',
      ['test_role', 'Test role description', false]
    );
  });

  it('should list all roles', async () => {
    const fakeRoles = [
      { id: 1, name: 'admin', description: 'Admin', is_system: true, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 2, name: 'viewer', description: 'Viewer', is_system: true, created_at: '2026-01-01T00:00:00.000Z' },
    ];
    mockExecute.mockResolvedValueOnce([fakeRoles]);
    const roles = await service.listRoles();
    expect(roles).toHaveLength(2);
    expect(roles[0].name).toBe('admin');
  });

  it('should get a role by ID', async () => {
    const fakeRole = { id: 1, name: 'admin', description: 'Admin', is_system: true, created_at: '2026-01-01T00:00:00.000Z' };
    mockExecute.mockResolvedValueOnce([[fakeRole]]);
    const role = await service.getRole(1);
    expect(role).not.toBeNull();
    expect(role!.name).toBe('admin');
  });

  it('should get a role by name', async () => {
    const fakeRole = { id: 1, name: 'admin', description: 'Admin', is_system: true, created_at: '2026-01-01T00:00:00.000Z' };
    mockExecute.mockResolvedValueOnce([[fakeRole]]);
    const role = await service.getRoleByName('admin');
    expect(role).not.toBeNull();
    expect(role!.name).toBe('admin');
  });

  it('should update a role', async () => {
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const result = await service.updateRole(1, { description: 'Updated description' });
    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledWith(
      'UPDATE roles SET description = ? WHERE id = ?',
      ['Updated description', 1]
    );
  });

  it('should reject delete for system role', async () => {
    mockExecute.mockResolvedValueOnce([[{ is_system: true }]]);
    const result = await service.deleteRole(1);
    expect(result.success).toBe(false);
    expect(result.error).toBe('系统角色不可删除');
  });

  it('should delete a non-system role', async () => {
    mockExecute.mockResolvedValueOnce([[{ is_system: false }]]);
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const result = await service.deleteRole(2);
    expect(result.success).toBe(true);
  });
});

describe('RbacService - Permissions', () => {
  let service: RbacService;
  let mockExecute: any;

  beforeEach(() => {
    service = new RbacService();
    mockExecute = vi.fn();
    (dbConnection.getPool as any).mockReturnValue({ execute: mockExecute });
  });

  it('should create a permission', async () => {
    mockExecute.mockResolvedValueOnce([{ insertId: 10 }]);
    const result = await service.createPermission('test:view', 'Test View', 'test', 'view', 'Test permission');
    expect(result.success).toBe(true);
    expect(result.permissionId).toBe(10);
  });

  it('should get a permission by ID', async () => {
    const fakePerm = { id: 1, code: 'instance:view', name: '查看实例', description: null, resource: 'instance', action: 'view', created_at: '2026-01-01T00:00:00.000Z' };
    mockExecute.mockResolvedValueOnce([[fakePerm]]);
    const perm = await service.getPermission(1);
    expect(perm).not.toBeNull();
    expect(perm!.code).toBe('instance:view');
  });

  it('should get a permission by code', async () => {
    const fakePerm = { id: 1, code: 'instance:view', name: '查看实例', description: null, resource: 'instance', action: 'view', created_at: '2026-01-01T00:00:00.000Z' };
    mockExecute.mockResolvedValueOnce([[fakePerm]]);
    const perm = await service.getPermissionByCode('instance:view');
    expect(perm).not.toBeNull();
    expect(perm!.resource).toBe('instance');
  });

  it('should list all permissions', async () => {
    const fakePerms = [
      { id: 1, code: 'instance:view', name: '查看实例', description: null, resource: 'instance', action: 'view', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 2, code: 'instance:create', name: '创建实例', description: null, resource: 'instance', action: 'create', created_at: '2026-01-01T00:00:00.000Z' },
    ];
    mockExecute.mockResolvedValueOnce([fakePerms]);
    const perms = await service.listPermissions();
    expect(perms).toHaveLength(2);
  });

  it('should filter permissions by resource', async () => {
    mockExecute.mockResolvedValueOnce([[]]);
    const perms = await service.listPermissions('alert');
    expect(mockExecute).toHaveBeenCalledWith(
      'SELECT id, code, name, description, resource, action, created_at FROM permissions WHERE resource = ? ORDER BY resource, action',
      ['alert']
    );
    expect(perms).toHaveLength(0);
  });

  it('should delete a permission', async () => {
    mockExecute.mockResolvedValueOnce([[{ cnt: 0 }]]);
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const result = await service.deletePermission(5);
    expect(result.success).toBe(true);
  });

  it('should reject delete for referenced permission', async () => {
    mockExecute.mockResolvedValueOnce([[{ cnt: 2 }]]);
    const result = await service.deletePermission(5);
    expect(result.success).toBe(false);
    expect(result.error).toContain('2 个角色引用');
  });
});

describe('RbacService - Role-Permission assignments', () => {
  let service: RbacService;
  let mockExecute: any;

  beforeEach(() => {
    service = new RbacService();
    mockExecute = vi.fn();
    (dbConnection.getPool as any).mockReturnValue({ execute: mockExecute });
  });

  it('should assign a permission to a role', async () => {
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const result = await service.assignPermissionToRole(1, 2);
    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledWith(
      'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
      [1, 2]
    );
  });

  it('should revoke a permission from a role', async () => {
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const result = await service.revokePermissionFromRole(1, 2);
    expect(result.success).toBe(true);
  });

  it('should get permissions for a role', async () => {
    const fakePerms = [
      { id: 1, code: 'instance:view', name: '查看实例', resource: 'instance', action: 'view' },
      { id: 3, code: 'alert:view', name: '查看告警', resource: 'alert', action: 'view' },
    ];
    mockExecute.mockResolvedValueOnce([fakePerms]);
    const perms = await service.getRolePermissions(1);
    expect(perms).toHaveLength(2);
  });

  it('should get permission codes for a role', async () => {
    mockExecute.mockResolvedValueOnce([[{ code: 'instance:view' }, { code: 'alert:view' }]]);
    const codes = await service.getRolePermissionCodes(1);
    expect(codes).toEqual(['instance:view', 'alert:view']);
  });
});

describe('RbacService - User-Role assignments', () => {
  let service: RbacService;
  let mockExecute: any;

  beforeEach(() => {
    service = new RbacService();
    mockExecute = vi.fn();
    (dbConnection.getPool as any).mockReturnValue({ execute: mockExecute });
  });

  it('should assign a role to a user', async () => {
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const result = await service.assignRoleToUser(1, 2);
    expect(result.success).toBe(true);
  });

  it('should revoke a role from a user', async () => {
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const result = await service.revokeRoleFromUser(1, 2);
    expect(result.success).toBe(true);
  });

  it('should get roles for a user', async () => {
    const fakeRoles = [
      { id: 1, role_id: 1, role_name: 'admin' },
      { id: 2, role_id: 3, role_name: 'developer' },
    ];
    mockExecute.mockResolvedValueOnce([fakeRoles]);
    const roles = await service.getUserRoles(1);
    expect(roles).toHaveLength(2);
    expect(roles[0].role_name).toBe('admin');
  });

  it('should get role IDs for a user', async () => {
    mockExecute.mockResolvedValueOnce([[{ role_id: 1 }, { role_id: 3 }]]);
    const ids = await service.getUserRoleIds(1);
    expect(ids).toEqual([1, 3]);
  });
});

describe('RbacService - Instance permissions', () => {
  let service: RbacService;
  let mockExecute: any;

  beforeEach(() => {
    service = new RbacService();
    mockExecute = vi.fn();
    (dbConnection.getPool as any).mockReturnValue({ execute: mockExecute });
  });

  it('should grant instance access to a user (new insert)', async () => {
    // First call: SELECT to check existing -> no existing row
    mockExecute.mockResolvedValueOnce([[]]);
    // Second call: INSERT
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const result = await service.grantInstanceAccess(1, 5, 'read-write');
    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenNthCalledWith(1,
      'SELECT id FROM instance_permissions WHERE user_id = ? AND instance_id = ?',
      [1, 5]
    );
    expect(mockExecute).toHaveBeenNthCalledWith(2,
      'INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, ?, ?)',
      [1, 5, 'read-write']
    );
  });

  it('should grant instance access defaults to read-only', async () => {
    mockExecute.mockResolvedValueOnce([[]]);
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const result = await service.grantInstanceAccess(1, 5);
    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenNthCalledWith(2,
      'INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, ?, ?)',
      [1, 5, 'read-only']
    );
  });

  it('should update access_level when grant already exists', async () => {
    // First call: existing row found
    mockExecute.mockResolvedValueOnce([[{ id: 10 }]]);
    // Second call: UPDATE
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const result = await service.grantInstanceAccess(1, 5, 'admin');
    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenNthCalledWith(2,
      'UPDATE instance_permissions SET access_level = COALESCE(?, access_level) WHERE user_id = ? AND instance_id = ?',
      ['admin', 1, 5]
    );
  });

  it('should revoke instance access from a user', async () => {
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const result = await service.revokeInstanceAccess(1, 5);
    expect(result.success).toBe(true);
  });

  it('should get instance IDs with access_level accessible by a user', async () => {
    mockExecute.mockResolvedValueOnce([[{ instance_id: 1, access_level: 'read-only' }, { instance_id: 3, access_level: 'read-write' }]]);
    const rows = await service.getUserInstanceAccess(1);
    expect(rows).toEqual([
      { instance_id: 1, access_level: 'read-only' },
      { instance_id: 3, access_level: 'read-write' },
    ]);
  });

  it('should get users with access_level for an instance', async () => {
    mockExecute.mockResolvedValueOnce([[{ user_id: 1, access_level: 'admin' }, { user_id: 2, access_level: 'read-only' }]]);
    const rows = await service.getUsersWithInstanceAccess(5);
    expect(rows).toEqual([
      { user_id: 1, access_level: 'admin' },
      { user_id: 2, access_level: 'read-only' },
    ]);
  });

  it('should check instance access returns true when granted', async () => {
    mockExecute.mockResolvedValueOnce([[{ cnt: 1 }]]);
    const hasAccess = await service.checkInstanceAccess(1, 5);
    expect(hasAccess).toBe(true);
  });

  it('should check instance access returns false when not granted', async () => {
    mockExecute.mockResolvedValueOnce([[{ cnt: 0 }]]);
    const hasAccess = await service.checkInstanceAccess(1, 99);
    expect(hasAccess).toBe(false);
  });

  it('should checkInstanceAccessLevel returns level when granted', async () => {
    mockExecute.mockResolvedValueOnce([[{ access_level: 'read-write' }]]);
    const level = await service.checkInstanceAccessLevel(1, 5);
    expect(level).toBe('read-write');
  });

  it('should checkInstanceAccessLevel returns null when not granted', async () => {
    mockExecute.mockResolvedValueOnce([[]]);
    const level = await service.checkInstanceAccessLevel(1, 99);
    expect(level).toBeNull();
  });
});

describe('RbacService - Permission lookup', () => {
  let service: RbacService;
  let mockExecute: any;

  beforeEach(() => {
    service = new RbacService();
    mockExecute = vi.fn();
    (dbConnection.getPool as any).mockReturnValue({ execute: mockExecute });
  });

  it('should return set of permission codes for a user', async () => {
    mockExecute.mockResolvedValueOnce([[{ code: 'instance:view' }, { code: 'alert:view' }]]);
    const perms = await service.getUserPermissions(1);
    expect(perms).toBeInstanceOf(Set);
    expect(perms.has('instance:view')).toBe(true);
    expect(perms.has('alert:view')).toBe(true);
    expect(perms.size).toBe(2);
  });

  it('should return empty set for user with no roles', async () => {
    mockExecute.mockResolvedValueOnce([[]]);
    const perms = await service.getUserPermissions(99);
    expect(perms).toBeInstanceOf(Set);
    expect(perms.size).toBe(0);
  });

  it('should return Set([\'*\']) when user has admin role assigned', async () => {
    mockExecute.mockResolvedValueOnce([[{ code: '*' }]]);
    const perms = await service.getUserPermissions(1);
    expect(perms.has('*')).toBe(true);
    expect(perms.size).toBe(1);
  });

  it('should return codes from multiple roles merged', async () => {
    mockExecute.mockResolvedValueOnce([[{ code: 'instance:view' }, { code: 'alert:view' }, { code: 'config:view' }]]);
    const perms = await service.getUserPermissions(1);
    expect(perms.size).toBe(3);
    expect(perms.has('instance:view')).toBe(true);
    expect(perms.has('alert:view')).toBe(true);
    expect(perms.has('config:view')).toBe(true);
  });
});
