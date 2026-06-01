/**
 * RBAC Service - Role/Permission/User/Instance CRUD + Permission Lookup
 *
 * Follows the existing auth-database-service.ts pattern:
 * - private getPool() wrapping dbConnection.getPool()
 * - mysql2/promise pool.execute() with ? parameterized queries
 * - try/catch error handling returning { success: boolean, error?: string }
 * - Named export class RbacService (not default export)
 */
import mysql from 'mysql2/promise';
import { dbConnection } from '../db-connection.js';
import { randomBytes, createHash } from 'crypto';

export class RbacService {
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  private isConnected(): boolean {
    return dbConnection.isConnected();
  }

  // =========================================================================
  // Roles
  // =========================================================================

  async createRole(name: string, description?: string, isSystem?: boolean): Promise<{ success: boolean; roleId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute(
        'INSERT INTO roles (name, description, is_system) VALUES (?, ?, ?)',
        [name, description || null, isSystem || false]
      ) as any;
      return { success: true, roleId: result.insertId };
    } catch (error: any) {
      console.error('创建角色失败:', error);
      return { success: false, error: error.message };
    }
  }

  async getRole(roleId: number): Promise<{ id: number; name: string; description: string | null; is_system: boolean; created_at: string } | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT id, name, description, is_system, created_at FROM roles WHERE id = ?',
        [roleId]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0];
      }
      return null;
    } catch (error) {
      console.error('获取角色失败:', error);
      return null;
    }
  }

  async getRoleByName(name: string): Promise<{ id: number; name: string; description: string | null; is_system: boolean; created_at: string } | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT id, name, description, is_system, created_at FROM roles WHERE name = ?',
        [name]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0];
      }
      return null;
    } catch (error) {
      console.error('获取角色失败:', error);
      return null;
    }
  }

  async listRoles(): Promise<Array<{ id: number; name: string; description: string | null; is_system: boolean; created_at: string }>> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT r.id, r.name, r.description, r.is_system, r.created_at, (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count FROM roles r ORDER BY r.created_at ASC`
      ) as any;
      return rows as any[];
    } catch (error) {
      console.error('获取角色列表失败:', error);
      return [];
    }
  }

  async updateRole(roleId: number, updates: { name?: string; description?: string }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const fields: string[] = [];
      const values: any[] = [];

      if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
      }

      if (updates.description !== undefined) {
        fields.push('description = ?');
        values.push(updates.description);
      }

      if (fields.length === 0) {
        return { success: false, error: '没有要更新的字段' };
      }

      values.push(roleId);

      await pool.execute(
        `UPDATE roles SET ${fields.join(', ')} WHERE id = ?`,
        values
      );

      return { success: true };
    } catch (error: any) {
      console.error('更新角色失败:', error);
      return { success: false, error: error.message };
    }
  }

  async deleteRole(roleId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // Reject if is_system=true
      const [rows] = await pool.execute(
        'SELECT is_system FROM roles WHERE id = ?',
        [roleId]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        if (rows[0].is_system) {
          return { success: false, error: '系统角色不可删除' };
        }
      } else {
        return { success: false, error: '角色不存在' };
      }

      await pool.execute('DELETE FROM roles WHERE id = ?', [roleId]);
      return { success: true };
    } catch (error: any) {
      console.error('删除角色失败:', error);
      return { success: false, error: error.message };
    }
  }

  // =========================================================================
  // Permissions
  // =========================================================================

  async createPermission(code: string, name: string, resource: string, action: string, description?: string): Promise<{ success: boolean; permissionId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute(
        'INSERT INTO permissions (code, name, description, resource, action) VALUES (?, ?, ?, ?, ?)',
        [code, name, description || null, resource, action]
      ) as any;
      return { success: true, permissionId: result.insertId };
    } catch (error: any) {
      console.error('创建权限失败:', error);
      return { success: false, error: error.message };
    }
  }

  async getPermission(permissionId: number): Promise<{ id: number; code: string; name: string; description: string | null; resource: string; action: string; created_at: string } | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT id, code, name, description, resource, action, created_at FROM permissions WHERE id = ?',
        [permissionId]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0];
      }
      return null;
    } catch (error) {
      console.error('获取权限失败:', error);
      return null;
    }
  }

  async getPermissionByCode(code: string): Promise<{ id: number; code: string; name: string; description: string | null; resource: string; action: string; created_at: string } | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT id, code, name, description, resource, action, created_at FROM permissions WHERE code = ?',
        [code]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0];
      }
      return null;
    } catch (error) {
      console.error('获取权限失败:', error);
      return null;
    }
  }

  async listPermissions(resource?: string): Promise<Array<{ id: number; code: string; name: string; description: string | null; resource: string; action: string; created_at: string }>> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      let rows: any[];
      if (resource) {
        const [result] = await pool.execute(
          'SELECT id, code, name, description, resource, action, created_at FROM permissions WHERE resource = ? ORDER BY resource, action',
          [resource]
        ) as any;
        rows = result;
      } else {
        const [result] = await pool.execute(
          'SELECT id, code, name, description, resource, action, created_at FROM permissions ORDER BY resource, action'
        ) as any;
        rows = result;
      }

      return rows as any[];
    } catch (error) {
      console.error('获取权限列表失败:', error);
      return [];
    }
  }

  async deletePermission(permissionId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // Check if any role references this permission
      const [refs] = await pool.execute(
        'SELECT COUNT(*) as cnt FROM role_permissions WHERE permission_id = ?',
        [permissionId]
      ) as any;

      if (refs[0].cnt > 0) {
        return { success: false, error: `权限被 ${refs[0].cnt} 个角色引用，无法删除` };
      }

      await pool.execute('DELETE FROM permissions WHERE id = ?', [permissionId]);
      return { success: true };
    } catch (error: any) {
      console.error('删除权限失败:', error);
      return { success: false, error: error.message };
    }
  }

  // =========================================================================
  // Role-Permission assignment
  // =========================================================================

  async assignPermissionToRole(roleId: number, permissionId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [roleId, permissionId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('分配权限到角色失败:', error);
      return { success: false, error: error.message };
    }
  }

  async revokePermissionFromRole(roleId: number, permissionId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        'DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?',
        [roleId, permissionId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('撤销权限失败:', error);
      return { success: false, error: error.message };
    }
  }

  async getRolePermissions(roleId: number): Promise<Array<{ id: number; code: string; name: string; resource: string; action: string }>> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT p.id, p.code, p.name, p.resource, p.action
         FROM role_permissions rp
         JOIN permissions p ON rp.permission_id = p.id
         WHERE rp.role_id = ?
         ORDER BY p.resource, p.action`,
        [roleId]
      ) as any;
      return rows as any[];
    } catch (error) {
      console.error('获取角色权限失败:', error);
      return [];
    }
  }

  async getRolePermissionCodes(roleId: number): Promise<string[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT p.code
         FROM role_permissions rp
         JOIN permissions p ON rp.permission_id = p.id
         WHERE rp.role_id = ?`,
        [roleId]
      ) as any;
      return (rows as any[]).map((r: any) => r.code);
    } catch (error) {
      console.error('获取角色权限代码失败:', error);
      return [];
    }
  }

  // =========================================================================
  // User-Role assignment
  // =========================================================================

  async assignRoleToUser(userId: number, roleId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        'INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)',
        [userId, roleId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('分配角色到用户失败:', error);
      return { success: false, error: error.message };
    }
  }

  async revokeRoleFromUser(userId: number, roleId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        'DELETE FROM user_roles WHERE user_id = ? AND role_id = ?',
        [userId, roleId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('撤销用户角色失败:', error);
      return { success: false, error: error.message };
    }
  }

  async getUserRoles(userId: number): Promise<Array<{ id: number; role_id: number; role_name: string }>> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT ur.id, ur.role_id, r.name as role_name
         FROM user_roles ur
         JOIN roles r ON ur.role_id = r.id
         WHERE ur.user_id = ?`,
        [userId]
      ) as any;
      return rows as any[];
    } catch (error) {
      console.error('获取用户角色失败:', error);
      return [];
    }
  }

  async getUserRoleIds(userId: number): Promise<number[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        'SELECT role_id FROM user_roles WHERE user_id = ?',
        [userId]
      ) as any;
      return (rows as any[]).map((r: any) => r.role_id);
    } catch (error) {
      console.error('获取用户角色 ID 失败:', error);
      return [];
    }
  }

  // =========================================================================
  // Instance-Permission assignment
  // =========================================================================

  async grantInstanceAccess(userId: number, instanceId: number, accessLevel?: string): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // Check if record exists, then INSERT or UPDATE
      const [existing] = await pool.execute(
        'SELECT id FROM instance_permissions WHERE user_id = ? AND instance_id = ?',
        [userId, instanceId]
      ) as any;
      if (Array.isArray(existing) && existing.length > 0) {
        await pool.execute(
          'UPDATE instance_permissions SET access_level = COALESCE(?, access_level) WHERE user_id = ? AND instance_id = ?',
          [accessLevel || 'read-only', userId, instanceId]
        );
      } else {
        await pool.execute(
          'INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, ?, ?)',
          [userId, instanceId, accessLevel || 'read-only']
        );
      }
      return { success: true };
    } catch (error: any) {
      console.error('授予实例访问失败:', error);
      return { success: false, error: error.message };
    }
  }

  async revokeInstanceAccess(userId: number, instanceId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        'DELETE FROM instance_permissions WHERE user_id = ? AND instance_id = ?',
        [userId, instanceId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('撤销实例访问失败:', error);
      return { success: false, error: error.message };
    }
  }

  async getUserInstanceAccess(userId: number): Promise<Array<{instance_id: number, access_level: string}>> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        'SELECT instance_id, access_level FROM instance_permissions WHERE user_id = ? AND (grant_expiry IS NULL OR grant_expiry > NOW())',
        [userId]
      ) as any;
      return rows as {instance_id: number, access_level: string}[];
    } catch (error) {
      console.error('获取用户实例访问失败:', error);
      return [];
    }
  }

  async getUsersWithInstanceAccess(instanceId: number): Promise<Array<{user_id: number, access_level: string}>> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        'SELECT user_id, access_level FROM instance_permissions WHERE instance_id = ? AND (grant_expiry IS NULL OR grant_expiry > NOW())',
        [instanceId]
      ) as any;
      return rows as {user_id: number, access_level: string}[];
    } catch (error) {
      console.error('获取实例访问用户失败:', error);
      return [];
    }
  }

  // =========================================================================
  // Permission lookup (used by middleware)
  // =========================================================================

  async getUserPermissions(userId: number): Promise<Set<string>> {
    const pool = this.getPool();
    if (!pool) {
      return new Set();
    }

    try {
      const [rows] = await pool.execute(
        `SELECT DISTINCT p.code
         FROM user_roles ur
         JOIN role_permissions rp ON ur.role_id = rp.role_id
         JOIN permissions p ON rp.permission_id = p.id
         WHERE ur.user_id = ?
           AND (ur.grant_expiry IS NULL OR ur.grant_expiry > NOW())`,
        [userId]
      ) as any;

      return new Set((rows as any[]).map((r: any) => r.code));
    } catch (error) {
      console.error('获取用户权限失败:', error);
      return new Set();
    }
  }

  async checkInstanceAccess(userId: number, instanceId: number): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) {
      return false;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT COUNT(*) as cnt FROM instance_permissions WHERE user_id = ? AND instance_id = ? AND (grant_expiry IS NULL OR grant_expiry > NOW())',
        [userId, instanceId]
      ) as any;

      return rows[0].cnt > 0;
    } catch (error) {
      console.error('检查实例访问失败:', error);
      return false;
    }
  }

  async checkInstanceAccessLevel(userId: number, instanceId: number): Promise<string | null> {
    const pool = this.getPool();
    if (!pool) return null;
    try {
      const [rows] = await pool.execute(
        'SELECT access_level FROM instance_permissions WHERE user_id = ? AND instance_id = ? AND (grant_expiry IS NULL OR grant_expiry > NOW())',
        [userId, instanceId]
      ) as any;
      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0].access_level;
      }
      return null;
    } catch (error) {
      console.error('检查实例访问级别失败:', error);
      return null;
    }
  }

  // =========================================================================
  // Refresh Token methods
  // =========================================================================

  async createRefreshToken(userId: number, expiresAt: Date): Promise<{ token: string; hash: string }> {
    const pool = this.getPool();
    const token = randomBytes(48).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');

    if (pool) {
      try {
        await pool.execute(
          'INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
          [hash, userId, expiresAt]
        );
      } catch (error) {
        console.error('创建 refresh token 失败:', error);
      }
    }

    return { token, hash };
  }

  async validateRefreshToken(tokenHash: string): Promise<{ id: number; user_id: number; revoked: boolean; expires_at: Date } | null> {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      const [rows] = await pool.execute(
        'SELECT id, user_id, revoked, expires_at FROM refresh_tokens WHERE token_hash = ?',
        [tokenHash]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0];
      }
      return null;
    } catch (error) {
      console.error('验证 refresh token 失败:', error);
      return null;
    }
  }

  async revokeRefreshToken(id: number): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;

    try {
      await pool.execute(
        'UPDATE refresh_tokens SET revoked = TRUE WHERE id = ?',
        [id]
      );
    } catch (error) {
      console.error('撤销 refresh token 失败:', error);
    }
  }

  async revokeAllUserTokens(userId: number): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;

    try {
      await pool.execute(
        'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?',
        [userId]
      );
    } catch (error) {
      console.error('撤销用户所有 refresh token 失败:', error);
    }
  }

  async cleanupExpiredRefreshTokens(): Promise<number> {
    const pool = this.getPool();
    if (!pool) return 0;

    try {
      const [result] = await pool.execute(
        'DELETE FROM refresh_tokens WHERE expires_at < NOW() - INTERVAL 30 DAY'
      ) as any;
      return result.affectedRows || 0;
    } catch (error) {
      console.error('清理过期 refresh token 失败:', error);
      return 0;
    }
  }
}
