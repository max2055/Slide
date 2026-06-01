/**
 * 用户认证数据库服务
 */
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { dbConnection, encryptData, decryptData } from './db-connection';

export interface User {
  id: number;
  username: string;
  email: string | null;
  // role field removed in Phase 84 — roles are now in user_roles table
  status: 'active' | 'inactive' | 'locked';
  last_login_at: Date | null;
  created_at: Date;
}

export interface LoginLog {
  id: number;
  user_id: number;
  username: string;
  login_status: 'success' | 'failed';
  ip_address: string | null;
  user_agent: string | null;
  failure_reason: string | null;
  created_at: Date;
}

export interface ActionLog {
  id: number;
  user_id: number;
  username: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: any;
  ip_address: string | null;
  created_at: Date;
}

class AuthDatabaseService {
  /**
   * 获取数据库连接池
   */
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * 检查数据库是否已连接
   */
  private isConnected(): boolean {
    return dbConnection.isConnected();
  }

  /**
   * 根据用户名获取用户
   */
  async getUserByUsername(username: string): Promise<User | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT id, username, email, status, last_login_at, created_at FROM users WHERE username = ? AND status = "active"',
        [username]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0] as User;
      }
      return null;
    } catch (error) {
      console.error('获取用户失败:', error);
      return null;
    }
  }

  /**
   * 根据 ID 获取用户
   */
  async getUserById(id: number): Promise<User | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT id, username, email, status, last_login_at, created_at FROM users WHERE id = ? AND status = "active"',
        [id]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0] as User;
      }
      return null;
    } catch (error) {
      console.error('获取用户失败:', error);
      return null;
    }
  }

  /**
   * 验证用户密码（支持 bcrypt 和 SHA-256 向后兼容）
   */
  async verifyPassword(username: string, password: string): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) {
      return false;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT id, password_hash FROM users WHERE username = ? AND status = "active"',
        [username]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        const passwordHash = rows[0].password_hash;
        const userId = rows[0].id;

        // 检测哈希格式：bcrypt 以 $2 开头，SHA-256 是 64 位十六进制
        if (passwordHash.startsWith('$2')) {
          // bcrypt 格式
          const isValid = await bcrypt.compare(password, passwordHash);
          return isValid;
        } else {
          // SHA-256 格式（向后兼容），验证后迁移到 bcrypt
          const sha256Hash = this.hashPasswordSha256(password);
          if (passwordHash === sha256Hash) {
            // 密码正确，异步迁移到 bcrypt（不阻塞登录）
            this.migratePasswordToBcrypt(userId, password).catch(console.error);
            return true;
          }
          return false;
        }
      }
      return false;
    } catch (error) {
      console.error('验证密码失败:', error);
      return false;
    }
  }

  /**
   * SHA-256 哈希（仅用于向后兼容）
   */
  private hashPasswordSha256(password: string): string {
    return createHash('sha256').update(password).digest('hex');
  }

  /**
   * 迁移密码到 bcrypt（用户登录时无缝升级）
   */
  private async migratePasswordToBcrypt(userId: number, password: string): Promise<void> {
    try {
      const bcryptHash = await this.hashPassword(password);
      const pool = this.getPool();
      if (pool) {
        await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [bcryptHash, userId]);
        console.log(`[密码迁移] 用户 ${userId} 已迁移到 bcrypt`);
      }
    } catch (error) {
      console.error('密码迁移失败:', error);
    }
  }

  /**
   * 密码哈希（使用 bcrypt）
   */
  private async hashPassword(password: string): Promise<string> {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
  }

  /**
   * 创建用户
   */
  async createUser(username: string, password: string, email?: string): Promise<{ success: boolean; userId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // 检查用户名是否已存在
      const [existing] = await pool.execute(
        'SELECT id FROM users WHERE username = ?',
        [username]
      ) as any;

      if (existing && existing.length > 0) {
        return { success: false, error: '用户名已存在' };
      }

      const passwordHash = await this.hashPassword(password);
      const [result] = await pool.execute(
        'INSERT INTO users (username, password_hash, email, status) VALUES (?, ?, ?, "active")',
        [username, passwordHash, email || null]
      ) as any;

      return { success: true, userId: result.insertId };
    } catch (error: any) {
      console.error('创建用户失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 删除用户
   */
  async deleteUser(username: string): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // 不能删除 admin 用户
      if (username === 'admin') {
        return { success: false, error: '不能删除管理员账户' };
      }

      await pool.execute('DELETE FROM users WHERE username = ?', [username]);
      return { success: true };
    } catch (error: any) {
      console.error('删除用户失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取所有用户
   */
  async getAllUsers(): Promise<User[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        'SELECT id, username, email, status, last_login_at, created_at FROM users ORDER BY created_at DESC'
      ) as any;

      return rows as User[];
    } catch (error) {
      console.error('获取用户列表失败:', error);
      return [];
    }
  }

  /**
   * 记录登录日志
   */
  async logLoginAttempt(
    username: string,
    userId: number | null,
    success: boolean,
    ipAddress?: string,
    userAgent?: string,
    failureReason?: string
  ): Promise<void> {
    const pool = this.getPool();
    if (!pool) {
      return;
    }

    try {
      await pool.execute(
        'INSERT INTO user_login_logs (user_id, username, login_status, ip_address, user_agent, failure_reason) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, username, success ? 'success' : 'failed', ipAddress || null, userAgent || null, failureReason || null]
      );
    } catch (error) {
      console.error('记录登录日志失败:', error);
    }
  }

  /**
   * 记录用户操作
   */
  async logAction(
    userId: number,
    username: string,
    action: string,
    resourceType?: string,
    resourceId?: string,
    details?: any,
    ipAddress?: string
  ): Promise<void> {
    const pool = this.getPool();
    if (!pool) {
      return;
    }

    try {
      await pool.execute(
        'INSERT INTO user_action_logs (user_id, username, action, resource_type, resource_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, username, action, resourceType || null, resourceId || null, details ? JSON.stringify(details) : null, ipAddress || null]
      );
    } catch (error) {
      console.error('记录操作日志失败:', error);
    }
  }

  /**
   * 更新用户最后登录时间
   */
  async updateLastLogin(userId: number, ipAddress?: string): Promise<void> {
    const pool = this.getPool();
    if (!pool) {
      return;
    }

    try {
      await pool.execute(
        'UPDATE users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?',
        [ipAddress || null, userId]
      );
    } catch (error) {
      console.error('更新最后登录时间失败:', error);
    }
  }

  /**
   * 修改密码
   */
  async changePassword(userId: number, newPassword: string): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const passwordHash = await this.hashPassword(newPassword);
      await pool.execute(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        [passwordHash, userId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('修改密码失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新用户信息
   */
  async updateUser(
    username: string,
    updates: { status?: string; newPassword?: string }
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const fields: string[] = [];
      const values: any[] = [];

      if (updates.status) {
        fields.push('status = ?');
        values.push(updates.status);
      }

      if (updates.newPassword) {
        fields.push('password_hash = ?');
        values.push(await this.hashPassword(updates.newPassword));
      }

      if (fields.length === 0) {
        return { success: false, error: '没有要更新的字段' };
      }

      values.push(username);

      await pool.execute(
        `UPDATE users SET ${fields.join(', ')} WHERE username = ?`,
        values
      );

      return { success: true };
    } catch (error: any) {
      console.error('更新用户失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 根据 ID 更新用户
   */
  async updateUserById(id: number, updates: { status?: string }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const fields: string[] = [];
      const values: any[] = [];

      if (updates.status) {
        fields.push('status = ?');
        values.push(updates.status);
      }

      if (fields.length === 0) {
        return { success: false, error: '没有要更新的字段' };
      }

      values.push(id);

      await pool.execute(
        `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
        values
      );

      return { success: true };
    } catch (error: any) {
      console.error('更新用户失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 根据 ID 删除用户
   */
  async deleteUserById(id: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // 不能删除 admin 用户
      const user = await this.getUserById(id);
      if (!user) {
        return { success: false, error: '用户不存在' };
      }
      if (user.username === 'admin') {
        return { success: false, error: '不能删除管理员账户' };
      }

      await pool.execute('DELETE FROM users WHERE id = ?', [id]);
      return { success: true };
    } catch (error: any) {
      console.error('删除用户失败:', error);
      return { success: false, error: error.message };
    }
  }
}

// 单例
export const authDatabaseService = new AuthDatabaseService();
