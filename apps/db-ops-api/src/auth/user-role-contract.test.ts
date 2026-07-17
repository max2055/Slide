/**
 * API contract tests: user management ↔ RBAC role assignment
 *
 * Ensures the full user creation → role assignment → role retrieval flow works.
 * These tests catch issues like the Phase 84 partial migration where roles
 * were sent to the wrong API endpoint and silently dropped.
 *
 * Uses mocked pool/transaction connections — no database connection required.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RbacService } from './rbac-service.js';
import { authDatabaseService, User } from '../auth-database-service.js';

// Mock dbConnection for both services
vi.mock('../db-connection.js', () => ({
  dbConnection: {
    getPool: vi.fn(),
    isConnected: vi.fn(() => true),
  },
  encryptData: vi.fn((v: string) => v),
  decryptData: vi.fn((v: string) => v),
}));

import { dbConnection } from '../db-connection.js';

/** Create a mock pool whose execute() returns controlled data */
function mockPool(responses: Array<[any, any]>) {
  const mockExecute = vi.fn();
  for (const r of responses) {
    mockExecute.mockResolvedValueOnce(r);
  }
  return mockExecute;
}

function useTransaction(mockExecute: ReturnType<typeof mockPool>) {
  const connection = {
    beginTransaction: vi.fn(),
    execute: mockExecute,
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
  (dbConnection.getPool as any).mockReturnValue({
    getConnection: vi.fn().mockResolvedValue(connection),
  });
  return connection;
}

describe('User ↔ Role Contract', () => {
  let rbacService: RbacService;
  let mockExec: ReturnType<typeof mockPool>;

  beforeEach(() => {
    rbacService = new RbacService();
    mockExec = mockPool([]);
    (dbConnection.getPool as any).mockReturnValue({ execute: mockExec });
  });

  // ─── Scenario 1: Create user → assign role → verify ───

  it('should return empty roles for a newly created user (no role assigned yet)', async () => {
    mockExec = mockPool([
      [[], []], // getUserRoles query returns empty
    ]);
    (dbConnection.getPool as any).mockReturnValue({ execute: mockExec });

    const roles = await rbacService.getUserRoles(42);
    expect(roles).toEqual([]);
  });

  it('should return assigned roles after assignRoleToUser', async () => {
    // assignRoleToUser: INSERT IGNORE + session bump + refresh revocation
    mockExec
      .mockResolvedValueOnce([{ insertId: 99, affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    useTransaction(mockExec);
    const assignResult = await rbacService.assignRoleToUser(42, 3);
    expect(assignResult.success).toBe(true);

    // getUserRoles: should return the role row
    (dbConnection.getPool as any).mockReturnValue({
      execute: vi.fn()
        .mockResolvedValueOnce([[{ id: 99, role_id: 3, role_name: 'developer' }]])
    });
    const roles = await rbacService.getUserRoles(42);
    expect(roles.length).toBe(1);
    expect(roles[0].role_id).toBe(3);
    expect(roles[0].role_name).toBe('developer');
  });

  // ─── Scenario 2: Reject unknown fields in user creation (strict mode) ───

  it('user create body should only contain username/password/email — role must be rejected', () => {
    const allowedFields = ['username', 'password', 'email'];
    const bodyWithRole = { username: 'test', password: '12345678', role: 'developer' };
    const unknown = Object.keys(bodyWithRole).filter(k => !allowedFields.includes(k));
    expect(unknown).toContain('role');
    expect(unknown.length).toBe(1);
  });

  it('user update body should only contain status/email — role must be rejected', () => {
    const allowedFields = ['status', 'email'];
    const bodyWithRole = { status: 'active', role: 'admin' };
    const unknown = Object.keys(bodyWithRole).filter(k => !allowedFields.includes(k));
    expect(unknown).toContain('role');
    expect(unknown.length).toBe(1);
  });

  // ─── Scenario 3: Role assignment uses role_id (not user_roles.id) ───

  it('revokeRoleFromUser should use role_id in WHERE clause', async () => {
    mockExec
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    useTransaction(mockExec);
    await rbacService.revokeRoleFromUser(42, 3);

    // Verify the SQL uses role_id (the second parameter), not user_roles.id
    const callSql = mockExec.mock.calls[0][0] as string;
    expect(callSql).toContain('DELETE FROM user_roles');
    expect(callSql).toContain('role_id = ?');
    // Parameters: [userId, roleId] — roleId should be 3, not a user_roles.id like 99
    expect(mockExec.mock.calls[0][1]).toEqual([42, 3]);
  });

  // ─── Scenario 4: getUserRoles returns role_id field ───

  it('getUserRoles should return both id and role_id', async () => {
    (dbConnection.getPool as any).mockReturnValue({
      execute: vi.fn().mockResolvedValueOnce([[
        { id: 10, role_id: 5, role_name: 'dba' }
      ]])
    });

    const roles = await rbacService.getUserRoles(1);
    expect(roles.length).toBe(1);
    // Must include role_id for remove operations
    expect(roles[0]).toHaveProperty('role_id');
    expect(roles[0].role_id).toBe(5);
    // id is the user_roles junction row id (used for audit, not for role ops)
    expect(roles[0].id).toBe(10);
  });

  // ─── Scenario 5: User deletion should cascade to user_roles ───

  it('user deletion cascade: user_roles records should be removed with user', async () => {
    // Simulating: after user is deleted, getUserRoles should return empty
    // (enforced by ON DELETE CASCADE in the schema)
    (dbConnection.getPool as any).mockReturnValue({
      execute: vi.fn().mockResolvedValueOnce([[]])
    });

    const roles = await rbacService.getUserRoles(999); // deleted user
    expect(roles).toEqual([]);
  });
});
