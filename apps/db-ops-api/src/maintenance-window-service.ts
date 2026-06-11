/**
 * 维护窗口服务
 * 在维护窗口期间抑制告警通知，支持按实例/全局配置、按星期几过滤、时间段匹配。
 */
import mysql from 'mysql2/promise';
import { CronJob } from 'cron';
import { dbConnection } from './db-connection';

interface MaintenanceWindow {
  id: number;
  name: string;
  description: string | null;
  instance_id: number | null;
  day_of_week: string;
  start_time: string;
  end_time: string;
  timezone: string;
  suppress_evaluation: boolean;
  enabled: boolean;
}

class MaintenanceWindowService {
  private cache: MaintenanceWindow[] = [];
  private lastCacheRefresh: Date | null = null;
  private refreshJob: CronJob | null = null;

  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * 检查指定实例是否在当前时间处于维护窗口
   */
  async isActiveMaintenanceWindow(
    instanceId: number
  ): Promise<{ active: boolean; window?: MaintenanceWindow }> {
    const pool = this.getPool();
    if (!pool) return { active: false };

    try {
      // MySQL DAYOFWEEK: 1=Sunday, 7=Saturday
      // day_of_week 存储为 '1,2,3,4,5,6,7' 或 '*'
      // 实例级窗口优先于全局窗口
      const [rows] = await pool.execute(
        `SELECT id, name, description, instance_id, day_of_week, start_time, end_time, timezone, suppress_evaluation, enabled
         FROM maintenance_windows
         WHERE enabled = 1
           AND (instance_id IS NULL OR instance_id = ?)
           AND FIND_IN_SET(DAYOFWEEK(NOW()), day_of_week) > 0
           AND TIME(NOW()) BETWEEN start_time AND end_time
         ORDER BY instance_id DESC
         LIMIT 1`,
        [instanceId]
      ) as any;

      if (!Array.isArray(rows) || rows.length === 0) {
        return { active: false };
      }

      const row = rows[0];
      return {
        active: true,
        window: {
          id: row.id,
          name: row.name,
          description: row.description,
          instance_id: row.instance_id,
          day_of_week: row.day_of_week,
          start_time: row.start_time,
          end_time: row.end_time,
          timezone: row.timezone,
          suppress_evaluation: Boolean(row.suppress_evaluation),
          enabled: Boolean(row.enabled),
        },
      };
    } catch (error) {
      console.error('检查维护窗口失败:', error);
      return { active: false };
    }
  }

  async getMaintenanceWindows(enabled?: boolean): Promise<MaintenanceWindow[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      let sql = 'SELECT * FROM maintenance_windows';
      const params: any[] = [];
      if (enabled !== undefined) {
        sql += ' WHERE enabled = ?';
        params.push(enabled ? 1 : 0);
      }
      sql += ' ORDER BY id';

      const [rows] = await pool.execute(sql, params) as any;
      return (rows as any[]).map((r: any) => ({ ...r, enabled: Boolean(r.enabled) }));
    } catch (error) {
      console.error('获取维护窗口失败:', error);
      return [];
    }
  }

  async createMaintenanceWindow(data: {
    name: string;
    description?: string;
    instance_id?: number;
    day_of_week: string;
    start_time: string;
    end_time: string;
    timezone?: string;
    suppress_evaluation?: boolean;
    enabled?: boolean;
  }): Promise<{ success: boolean; id?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    // 验证 day_of_week 值范围
    if (!data.day_of_week) {
      return { success: false, error: '缺少必要参数：day_of_week（如 "*" 或 "1,2,3,4,5"）' };
    }
    const validDays = new Set(['*', '1', '2', '3', '4', '5', '6', '7']);
    const days = data.day_of_week.split(',').map((d: string) => d.trim());
    for (const day of days) {
      if (!validDays.has(day)) {
        return { success: false, error: `无效的星期值: ${day}（应为 1-7 或 *）` };
      }
    }

    try {
      const [result] = await pool.execute(
        `INSERT INTO maintenance_windows
         (name, description, instance_id, day_of_week, start_time, end_time, timezone, suppress_evaluation, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.name,
          data.description || null,
          data.instance_id || null,
          data.day_of_week,
          data.start_time,
          data.end_time,
          data.timezone || 'Asia/Shanghai',
          data.suppress_evaluation !== undefined ? (data.suppress_evaluation ? 1 : 0) : 0,
          data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
        ]
      ) as any;
      return { success: true, id: result.insertId };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async updateMaintenanceWindow(
    id: number,
    data: {
      name?: string;
      description?: string;
      instance_id?: number;
      day_of_week?: string;
      start_time?: string;
      end_time?: string;
      timezone?: string;
      suppress_evaluation?: boolean;
      enabled?: boolean;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const updates: string[] = [];
      const values: any[] = [];
      if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name); }
      if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description); }
      if (data.instance_id !== undefined) { updates.push('instance_id = ?'); values.push(data.instance_id); }
      if (data.day_of_week !== undefined) { updates.push('day_of_week = ?'); values.push(data.day_of_week); }
      if (data.start_time !== undefined) { updates.push('start_time = ?'); values.push(data.start_time); }
      if (data.end_time !== undefined) { updates.push('end_time = ?'); values.push(data.end_time); }
      if (data.timezone !== undefined) { updates.push('timezone = ?'); values.push(data.timezone); }
      if (data.suppress_evaluation !== undefined) { updates.push('suppress_evaluation = ?'); values.push(data.suppress_evaluation ? 1 : 0); }
      if (data.enabled !== undefined) { updates.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }

      if (updates.length === 0) return { success: true };
      values.push(id);

      const [result] = await pool.execute(`UPDATE maintenance_windows SET ${updates.join(', ')} WHERE id = ?`, values) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '维护窗口不存在' };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async deleteMaintenanceWindow(id: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const [result] = await pool.execute('DELETE FROM maintenance_windows WHERE id = ?', [id]) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '维护窗口不存在' };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 定期刷新维护窗口缓存
   */
  startCacheRefresh(intervalMinutes: number = 5): void {
    if (this.refreshJob) return;

    this.refreshJob = new CronJob(
      `0 */${intervalMinutes} * * * *`,
      async () => {
        try {
          const windows = await this.getMaintenanceWindows(true);
          this.cache = windows;
          this.lastCacheRefresh = new Date();
        } catch (error) {
          console.error('刷新维护窗口缓存失败:', error);
        }
      },
      null,
      true,
      'Asia/Shanghai'
    );

    console.log(`✅ 维护窗口缓存刷新已启动（每 ${intervalMinutes} 分钟）`);
  }

  stopCacheRefresh(): void {
    if (this.refreshJob) {
      this.refreshJob.stop();
      this.refreshJob = null;
    }
  }

  getCachedWindows(): MaintenanceWindow[] {
    return this.cache;
  }
}

export const maintenanceWindowService = new MaintenanceWindowService();
