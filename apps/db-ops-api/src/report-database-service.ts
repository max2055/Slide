/**
 * 报表数据库服务
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';

export type ReportType = 'health' | 'performance' | 'slow_query' | 'capacity' | 'server_health';
export type ReportFormat = 'pdf' | 'html' | 'json' | 'csv';
export type ReportStatus = 'pending' | 'completed' | 'failed';

export interface Report {
  id: number;
  name: string;
  type: ReportType;
  format: ReportFormat;
  instance_id: number | null;
  server_id?: number | null;
  instance_name?: string;
  server_name?: string;
  content: string | null;
  data: any | null;
  generated_by: number | null;
  status: ReportStatus;
  created_at: string;
}

export interface CreateReportData {
  name: string;
  type: ReportType;
  format?: ReportFormat;
  instance_id?: number;
  server_id?: number;
  content?: string;
  data?: any;
  generated_by?: number;
  status?: ReportStatus;
}

export interface ReportFilters {
  type?: ReportType;
  instance_id?: number;
  server_id?: number;
  target_type?: 'instance' | 'server';
  status?: ReportStatus;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

class ReportDatabaseService {
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
   * 创建报表记录
   */
  async createReport(data: CreateReportData): Promise<Report> {
    const pool = this.getPool();
    if (!pool) {
      throw new Error('数据库未连接');
    }

    try {
      const [result] = await pool.execute(
        `INSERT INTO reports
         (name, type, format, instance_id, server_id, content, data, generated_by, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.name,
          data.type,
          data.format || 'html',
          data.instance_id || null,
          data.server_id || null,
          data.content || null,
          data.data ? JSON.stringify(data.data) : null,
          data.generated_by || null,
          data.status || 'pending',
        ]
      ) as any;

      return this.getReportById((result as any).insertId);
    } catch (error: any) {
      console.error('创建报表记录失败:', error);
      throw error;
    }
  }

  /**
   * 根据 ID 查询报表
   */
  async getReportById(id: number): Promise<Report | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        `SELECT r.id, r.name, r.type, r.format, r.instance_id, r.server_id,
                r.content, r.data, r.generated_by, r.status, r.created_at,
                i.name as instance_name,
                s.host as server_name
         FROM reports r
         LEFT JOIN database_instances i ON r.instance_id = i.id
         LEFT JOIN servers s ON r.server_id = s.id
         WHERE r.id = ?`,
        [id]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        const report = rows[0];
        if (report.data && typeof report.data === 'string') {
          report.data = JSON.parse(report.data);
        }
        return report as Report;
      }
      return null;
    } catch (error) {
      console.error('查询报表失败:', error);
      return null;
    }
  }

  /**
   * 根据条件查询报表列表
   */
  async getReportsByFilters(filters: ReportFilters = {}): Promise<Report[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const conditions: string[] = ['1=1'];
      const params: any[] = [];

      if (filters.type) {
        conditions.push('r.type = ?');
        params.push(filters.type);
      }

      if (filters.instance_id) {
        conditions.push('r.instance_id = ?');
        params.push(filters.instance_id);
      }

      if (filters.server_id) {
        conditions.push('r.server_id = ?');
        params.push(filters.server_id);
      }

      if (filters.target_type === 'server') {
        conditions.push('r.server_id IS NOT NULL');
      } else if (filters.target_type === 'instance') {
        conditions.push('r.server_id IS NULL');
      }

      if (filters.status) {
        conditions.push('r.status = ?');
        params.push(filters.status);
      }

      if (filters.date_from) {
        conditions.push('r.created_at >= ?');
        params.push(filters.date_from);
      }

      if (filters.date_to) {
        conditions.push('r.created_at <= ?');
        params.push(filters.date_to);
      }

      const limit = filters.limit || 50;
      const offset = filters.offset || 0;

      const [rows] = await pool.query(
        `SELECT r.id, r.name, r.type, r.format, r.instance_id, r.server_id,
                r.content, r.data, r.generated_by, r.status, r.created_at,
                i.name as instance_name,
                s.host as server_name
         FROM reports r
         LEFT JOIN database_instances i ON r.instance_id = i.id
         LEFT JOIN servers s ON r.server_id = s.id
         WHERE ${conditions.join(' AND ')}
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      ) as any;

      return rows.map((row: any) => {
        if (row.data && typeof row.data === 'string') {
          row.data = JSON.parse(row.data);
        }
        return row as Report;
      });
    } catch (error) {
      console.error('查询报表列表失败:', error);
      return [];
    }
  }

  /**
   * 更新报表状态和内容
   */
  async updateReportStatus(
    id: number,
    status: ReportStatus,
    content?: string,
    data?: any
  ): Promise<void> {
    const pool = this.getPool();
    if (!pool) {
      throw new Error('数据库未连接');
    }

    try {
      const updates: string[] = ['status = ?'];
      const values: any[] = [status];

      if (content !== undefined) {
        updates.push('content = ?');
        values.push(content);
      }

      if (data !== undefined) {
        updates.push('data = ?');
        values.push(JSON.stringify(data));
      }

      values.push(id);

      await pool.execute(
        `UPDATE reports SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    } catch (error: any) {
      console.error('更新报表状态失败:', error);
      throw error;
    }
  }

  /**
   * 删除报表
   */
  async deleteReport(id: number): Promise<void> {
    const pool = this.getPool();
    if (!pool) {
      throw new Error('数据库未连接');
    }

    try {
      const [result] = await pool.execute('DELETE FROM reports WHERE id = ?', [id]) as any;
      if (result.affectedRows === 0) {
        throw new Error('报表不存在');
      }
    } catch (error: any) {
      console.error('删除报表失败:', error);
      throw error;
    }
  }

  async recordNotificationDelivery(data: {
    jobId: string;
    reportId: number;
    channelId: number;
    attemptNumber: number;
    status: 'started' | 'sent' | 'failed' | 'skipped';
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    const pool = this.getPool();
    if (!pool) throw new Error('REPORT_DELIVERY_AUDIT_UNAVAILABLE');
    await pool.execute(
      `INSERT INTO report_notification_deliveries
       (workflow_job_id, report_id, channel_id, attempt_number, status, error_code, error_message, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, IF(? IN ('sent', 'failed', 'skipped'), NOW(), NULL))
       ON DUPLICATE KEY UPDATE status = VALUES(status), error_code = VALUES(error_code),
       error_message = VALUES(error_message), finished_at = VALUES(finished_at)`,
      [data.jobId, data.reportId, data.channelId, data.attemptNumber, data.status,
        data.errorCode ?? null, data.errorMessage?.slice(0, 1024) ?? null, data.status],
    );
  }

  async getNotificationDeliveries(reportId: number): Promise<Array<Record<string, unknown>>> {
    const pool = this.getPool();
    if (!pool) return [];
    const [rows] = await pool.execute(
      `SELECT workflow_job_id AS workflowJobId, channel_id AS channelId, attempt_number AS attemptNumber,
              status, error_code AS errorCode, error_message AS errorMessage, created_at AS createdAt, finished_at AS finishedAt
       FROM report_notification_deliveries WHERE report_id = ? ORDER BY created_at DESC`,
      [reportId],
    ) as any;
    return rows;
  }

  /**
   * 获取报表统计
   */
  async getReportStats(): Promise<{
    total: number;
    completed: number;
    running: number;
    failed: number;
  }> {
    const pool = this.getPool();
    if (!pool) {
      return { total: 0, completed: 0, running: 0, failed: 0 };
    }

    try {
      const [rows] = await pool.execute(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as running,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM reports
      `) as any;

      return {
        total: rows[0]?.total || 0,
        completed: rows[0]?.completed || 0,
        running: rows[0]?.running || 0,
        failed: rows[0]?.failed || 0,
      };
    } catch (error) {
      console.error('获取报表统计失败:', error);
      return { total: 0, completed: 0, running: 0, failed: 0 };
    }
  }
}

// 单例
export const reportDatabaseService = new ReportDatabaseService();
