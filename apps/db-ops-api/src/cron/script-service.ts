/**
 * Script Service
 * 提供 cron_scripts 表的 CRUD 操作
 */
import mysql from 'mysql2/promise';
import { dbConnection } from '../db-connection';
import { CronScript, CreateScriptInput, UpdateScriptInput } from './types';

export class ScriptService {
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
   * 获取所有脚本（按名称排序）
   */
  async getAllScripts(): Promise<CronScript[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const [rows] = await pool.execute(
        'SELECT id, name, description, script_type, content, target_db_type, created_at, updated_at FROM cron_scripts ORDER BY name'
      ) as any;
      return rows as CronScript[];
    } catch (error) {
      console.error('查询脚本列表失败:', error);
      return [];
    }
  }

  /**
   * 根据 ID 获取脚本
   */
  async getScriptById(id: number): Promise<CronScript | null> {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      const [rows] = await pool.execute(
        'SELECT id, name, description, script_type, content, target_db_type, created_at, updated_at FROM cron_scripts WHERE id = ?',
        [id]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0] as CronScript;
      }
      return null;
    } catch (error) {
      console.error('查询脚本失败:', error);
      return null;
    }
  }

  /**
   * 创建脚本
   */
  async createScript(data: CreateScriptInput): Promise<number> {
    const pool = this.getPool();
    if (!pool) throw new Error('数据库未连接');

    try {
      const [result] = await pool.execute(
        'INSERT INTO cron_scripts (name, description, script_type, content, target_db_type) VALUES (?, ?, ?, ?, ?)',
        [
          data.name,
          data.description || null,
          data.script_type || 'sql',
          data.content,
          data.target_db_type,
        ]
      ) as any;
      return (result as any).insertId;
    } catch (error: any) {
      console.error('创建脚本失败:', error);
      throw error;
    }
  }

  /**
   * 更新脚本（直接覆盖 content，无版本历史）
   */
  async updateScript(id: number, data: UpdateScriptInput): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) throw new Error('数据库未连接');

    try {
      const updates: string[] = [];
      const values: any[] = [];

      if (data.name !== undefined) {
        updates.push('name = ?');
        values.push(data.name);
      }

      if (data.description !== undefined) {
        updates.push('description = ?');
        values.push(data.description);
      }

      if (data.content !== undefined) {
        updates.push('content = ?');
        values.push(data.content);
      }

      if (data.target_db_type !== undefined) {
        updates.push('target_db_type = ?');
        values.push(data.target_db_type);
      }

      if (data.script_type !== undefined) {
        updates.push('script_type = ?');
        values.push(data.script_type);
      }

      if (updates.length === 0) return false;

      values.push(id);

      const [result] = await pool.execute(
        `UPDATE cron_scripts SET ${updates.join(', ')} WHERE id = ?`,
        values
      ) as any;

      return (result as any).affectedRows > 0;
    } catch (error: any) {
      console.error('更新脚本失败:', error);
      throw error;
    }
  }

  /**
   * 删除脚本
   */
  async deleteScript(id: number): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) return false;

    try {
      const [result] = await pool.execute(
        'DELETE FROM cron_scripts WHERE id = ?',
        [id]
      ) as any;
      return (result as any).affectedRows > 0;
    } catch (error) {
      console.error('删除脚本失败:', error);
      return false;
    }
  }
}

// 单例
export const scriptService = new ScriptService();
