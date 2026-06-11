/**
 * 告警静默服务
 * 管理实例级静默期，同一实例同一指标触发后在静默期内不再重复通知。
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';

class AlertSilenceService {
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * 检查指定实例和指标是否在静默期内
   */
  async isSilenced(instanceId: number, metricName: string): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) return false;

    try {
      const [rows] = await pool.execute(
        `SELECT id FROM silence_periods
         WHERE instance_id = ?
           AND metric_name = ?
           AND silenced_until > NOW()
         LIMIT 1`,
        [instanceId, metricName]
      ) as any;

      return Array.isArray(rows) && rows.length > 0;
    } catch (error) {
      console.error('检查静默状态失败:', error);
      return false;
    }
  }

  /**
   * 创建静默期
   */
  async silence(
    instanceId: number,
    metricName: string,
    durationMinutes: number,
    created_by_alert_id?: number
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      await pool.execute(
        `INSERT INTO silence_periods (instance_id, metric_name, silenced_until, created_by_alert_id)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?)`,
        [instanceId, metricName, durationMinutes, created_by_alert_id || null]
      );
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取当前生效的静默记录
   */
  async getActiveSilences(instanceId?: number): Promise<any[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      let sql = `SELECT id, instance_id, metric_name, silenced_until, created_by_alert_id, created_at
                 FROM silence_periods WHERE silenced_until > NOW() ORDER BY silenced_until ASC`;
      const params: any[] = [];

      if (instanceId !== undefined) {
        sql = `SELECT id, instance_id, metric_name, silenced_until, created_by_alert_id, created_at
               FROM silence_periods WHERE instance_id = ? AND silenced_until > NOW() ORDER BY silenced_until ASC`;
        params.push(instanceId);
      }

      const [rows] = await pool.execute(sql, params) as any;
      return rows;
    } catch (error) {
      console.error('获取静默记录失败:', error);
      return [];
    }
  }

  /**
   * 清除指定静默记录
   */
  async clearSilence(silenceId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const [result] = await pool.execute('DELETE FROM silence_periods WHERE id = ?', [silenceId]) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '静默记录不存在' };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 清理过期的静默记录
   */
  async cleanupExpiredSilences(): Promise<number> {
    const pool = this.getPool();
    if (!pool) return 0;

    try {
      const [result] = await pool.execute(
        'DELETE FROM silence_periods WHERE silenced_until < NOW()'
      ) as any;
      return result.affectedRows || 0;
    } catch (error) {
      console.error('清理过期静默记录失败:', error);
      return 0;
    }
  }
}

export const alertSilenceService = new AlertSilenceService();
