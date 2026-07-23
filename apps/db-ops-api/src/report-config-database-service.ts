/**
 * 定时报表配置数据库服务
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';

export interface ReportConfig {
  id: number;
  name: string;
  cron: string;
  type: string;
  instance_id: number | null;
  server_id?: number | null;
  notification_channel_ids: number[];
  format: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateReportConfigData {
  name: string;
  cron: string;
  type: string;
  instance_id: number | null;
  server_id?: number;
  notification_channel_ids?: number[];
  format?: string;
  enabled?: boolean;
}

export interface UpdateReportConfigData {
  name?: string;
  cron?: string;
  type?: string;
  instance_id?: number | null;
  server_id?: number;
  notification_channel_ids?: number[];
  format?: string;
  enabled?: boolean;
}

class ReportConfigDatabaseService {
  private channelIds(value: unknown): number[] {
    let raw = value;
    try {
      if (typeof value === 'string') raw = JSON.parse(value);
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter((id): id is number => Number.isSafeInteger(id) && id > 0))];
  }
  private assertSingleTarget(instanceId: number | null | undefined, serverId: number | null | undefined): void {
    if ((instanceId == null) === (serverId == null)) {
      throw new Error('REPORT_CONFIG_TARGET_INVALID');
    }
  }
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
   * 获取所有报表配置
   */
  async getConfigs(): Promise<ReportConfig[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, name, cron, type, instance_id, server_id, format, notification_channel_ids, enabled, created_at, updated_at
         FROM report_configs
         ORDER BY created_at DESC`
      ) as any;

      return rows.map((row: any) => ({ ...row, notification_channel_ids: this.channelIds(row.notification_channel_ids) })) as ReportConfig[];
    } catch (error) {
      console.error('查询报表配置列表失败:', error);
      return [];
    }
  }

  /**
   * 根据 ID 查询报表配置
   */
  async getConfigById(id: number): Promise<ReportConfig | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, name, cron, type, instance_id, server_id, format, notification_channel_ids, enabled, created_at, updated_at
         FROM report_configs
         WHERE id = ?`,
        [id]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return { ...rows[0], notification_channel_ids: this.channelIds(rows[0].notification_channel_ids) } as ReportConfig;
      }
      return null;
    } catch (error) {
      console.error('查询报表配置失败:', error);
      return null;
    }
  }

  /**
   * 创建报表配置
   */
  async createConfig(data: CreateReportConfigData): Promise<ReportConfig> {
    const pool = this.getPool();
    if (!pool) {
      throw new Error('数据库未连接');
    }

    try {
      this.assertSingleTarget(data.instance_id, data.server_id);
      const [result] = await pool.execute(
        `INSERT INTO report_configs (name, cron, type, instance_id, server_id, format, notification_channel_ids, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.name,
          data.cron,
          data.type,
          data.instance_id ?? null,
          data.server_id || null,
          data.format || 'html',
          JSON.stringify(this.channelIds(data.notification_channel_ids)),
          data.enabled !== undefined ? data.enabled : true,
        ]
      ) as any;

      return this.getConfigById((result as any).insertId) as Promise<ReportConfig>;
    } catch (error: any) {
      console.error('创建报表配置失败:', error);
      throw error;
    }
  }

  /**
   * 更新报表配置
   */
  async updateConfig(id: number, data: UpdateReportConfigData): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) {
      throw new Error('数据库未连接');
    }

    try {
      const current = await this.getConfigById(id);
      if (!current) return false;
      this.assertSingleTarget(
        data.instance_id === undefined ? current.instance_id : data.instance_id,
        data.server_id === undefined ? current.server_id : data.server_id,
      );
      const updates: string[] = [];
      const values: any[] = [];

      if (data.name !== undefined) {
        updates.push('name = ?');
        values.push(data.name);
      }

      if (data.cron !== undefined) {
        updates.push('cron = ?');
        values.push(data.cron);
      }

      if (data.type !== undefined) {
        updates.push('type = ?');
        values.push(data.type);
      }

      if (data.instance_id !== undefined) {
        updates.push('instance_id = ?');
        values.push(data.instance_id);
      }

      if (data.server_id !== undefined) {
        updates.push('server_id = ?');
        values.push(data.server_id);
      }

      if (data.format !== undefined) {
        updates.push('format = ?');
        values.push(data.format);
      }

      if (data.notification_channel_ids !== undefined) {
        updates.push('notification_channel_ids = ?');
        values.push(JSON.stringify(this.channelIds(data.notification_channel_ids)));
      }

      if (data.enabled !== undefined) {
        updates.push('enabled = ?');
        values.push(data.enabled);
      }

      if (updates.length === 0) {
        return false;
      }

      values.push(id);

      const [result] = await pool.execute(
        `UPDATE report_configs SET ${updates.join(', ')} WHERE id = ?`,
        values
      ) as any;

      return (result as any).affectedRows > 0;
    } catch (error: any) {
      console.error('更新报表配置失败:', error);
      throw error;
    }
  }

  /**
   * 删除报表配置
   */
  async deleteConfig(id: number): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) {
      throw new Error('数据库未连接');
    }

    try {
      const [result] = await pool.execute(
        'DELETE FROM report_configs WHERE id = ?',
        [id]
      ) as any;

      return (result as any).affectedRows > 0;
    } catch (error: any) {
      console.error('删除报表配置失败:', error);
      throw error;
    }
  }

  /**
   * 获取所有已启用的报表配置（供 CronJob 扫描使用）
   */
  async getEnabledConfigs(): Promise<ReportConfig[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, name, cron, type, instance_id, server_id, format, notification_channel_ids, enabled, created_at, updated_at
         FROM report_configs
         WHERE enabled = 1
         ORDER BY created_at DESC`
      ) as any;

      return rows.map((row: any) => ({ ...row, notification_channel_ids: this.channelIds(row.notification_channel_ids) })) as ReportConfig[];
    } catch (error) {
      console.error('查询已启用报表配置失败:', error);
      return [];
    }
  }
}

// 单例
export const reportConfigService = new ReportConfigDatabaseService();
