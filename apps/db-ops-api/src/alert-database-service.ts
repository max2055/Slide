/**
 * 告警数据库服务
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';

export interface Alert {
  id: number;
  instance_id: number | null;
  alert_type: 'performance' | 'availability' | 'security' | 'backup' | 'replication' | 'capacity';
  level: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  message: string;
  description: string | null;
  status: 'unread' | 'read' | 'acknowledged' | 'resolved' | 'closed';
  acknowledged_by: number | null;
  acknowledged_at: Date | null;
  resolved_by: number | null;
  resolved_at: Date | null;
  assigned_to: number | null;
  source: string | null;
  metric_name: string | null;
  metric_value: string | null;
  threshold_value: string | null;
  tags: any;
  created_at: Date;
  updated_at: Date;
}

export interface AlertRule {
  id: number;
  name: string;
  description: string | null;
  metric_name: string;
  operator: '>' | '<' | '>=' | '<=' | '=' | '!=';
  threshold: number;
  threshold_template?: { warning: number; error: number; critical: number } | null;
  duration_seconds: number;
  severity: 'info' | 'warning' | 'error' | 'critical';
  enabled: boolean;
  notification_channels: any;
  threshold_type: 'static' | 'dynamic';
  dynamic_config?: { sigma?: number; lookback_days?: number; } | null;
  silence_minutes: number;
  db_types?: string[] | null;
  instance_ids?: number[] | null;
  template_id?: number | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

class AlertDatabaseService {
  /**
   * 将数据库行转为 Alert 对象
   */
  private _rowToAlert(row: any): Alert {
    return {
      id: row.id,
      instance_id: row.instance_id,
      alert_type: row.alert_type,
      level: row.level,
      title: row.title,
      message: row.message,
      description: row.description,
      status: row.status,
      acknowledged_by: row.acknowledged_by,
      acknowledged_at: row.acknowledged_at,
      resolved_by: row.resolved_by,
      resolved_at: row.resolved_at,
      assigned_to: row.assigned_to,
      source: row.source,
      metric_name: row.metric_name,
      metric_value: row.metric_value,
      threshold_value: row.threshold_value,
      tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
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
   * 创建告警
   */
  async createAlert(data: {
    instance_id?: number;
    alert_type: string;
    level: string;
    title: string;
    message: string;
    description?: string;
    source?: string;
    metric_name?: string;
    metric_value?: string;
    threshold_value?: string;
    tags?: any;
  }): Promise<{ success: boolean; alertId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute(
        `INSERT INTO alerts
         (instance_id, alert_type, level, title, message, description, source, metric_name, metric_value, threshold_value, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.instance_id || null,
          data.alert_type,
          data.level,
          data.title,
          data.message,
          data.description || null,
          data.source || null,
          data.metric_name || null,
          data.metric_value || null,
          data.threshold_value || null,
          data.tags ? JSON.stringify(data.tags) : null,
        ]
      ) as any;

      return { success: true, alertId: result.insertId };
    } catch (error: any) {
      console.error('创建告警失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取告警列表
   */
  async getAlerts(options?: {
    instance_id?: number;
    status?: string;
    level?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      let sql = `
        SELECT a.id, a.instance_id, COALESCE(d.name, '') as instance_name,
               a.alert_type, a.level, a.title, a.message, a.description,
               a.status, a.acknowledged_by, a.acknowledged_at, a.resolved_by, a.resolved_at,
               a.assigned_to, a.source, a.metric_name, a.metric_value, a.threshold_value,
               a.tags, a.created_at, a.updated_at
        FROM alerts a
        LEFT JOIN database_instances d ON a.instance_id = d.id
        WHERE 1=1
      `;
      const params: any[] = [];

      if (options?.instance_id !== undefined) {
        sql += ' AND instance_id = ?';
        params.push(options.instance_id);
      }
      if (options?.status) {
        const statuses = options.status.split(',').map(s => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          sql += ' AND a.status = ?';
          params.push(statuses[0]);
        } else if (statuses.length > 1) {
          sql += ` AND a.status IN (${statuses.map(() => '?').join(',')})`;
          params.push(...statuses);
        }
      }
      if (options?.level) {
        sql += ' AND level = ?';
        params.push(options.level);
      }

      sql += ' ORDER BY created_at DESC';

      if (options?.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(options.limit);
      }
      if (options?.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }

      const [rows] = await pool.query(sql, params) as any;

      // Get total and breakdown counts for pagination
      let total = rows.length;
      let unread = 0, critical = 0, warning = 0, resolved = 0;
      if (options?.limit !== undefined) {
        const whereParts: string[] = [];
        const countParams: any[] = [];
        if (options?.instance_id !== undefined) { whereParts.push('instance_id = ?'); countParams.push(options.instance_id); }
        if (options?.status) {
          const statuses = options.status.split(',').map(s => s.trim()).filter(Boolean);
          if (statuses.length === 1) {
            whereParts.push('status = ?'); countParams.push(statuses[0]);
          } else if (statuses.length > 1) {
            whereParts.push(`status IN (${statuses.map(() => '?').join(',')})`); countParams.push(...statuses);
          }
        }
        if (options?.level) { whereParts.push('level = ?'); countParams.push(options.level); }
        const whereClause = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';
        const [[{ total: t }]] = await pool.query(`SELECT COUNT(*) AS total FROM alerts ${whereClause}`, countParams) as any;
        total = t ?? rows.length;
        const extraWhere = whereParts.length ? ' AND' : 'WHERE';
        const [[{ total: ur }]] = await pool.query(`SELECT COUNT(*) AS total FROM alerts ${whereClause}${extraWhere} status NOT IN ('acknowledged','resolved','closed','read')`, countParams) as any;
        unread = ur ?? 0;
        const [[{ total: cr }]] = await pool.query(`SELECT COUNT(*) AS total FROM alerts ${whereClause}${extraWhere} level = 'critical'`, countParams) as any;
        critical = cr ?? 0;
        const [[{ total: wr }]] = await pool.query(`SELECT COUNT(*) AS total FROM alerts ${whereClause}${extraWhere} level = 'warning'`, countParams) as any;
        warning = wr ?? 0;
        // Resolved count: always cross-tab (ignores status filter)
        const resolvedCountParams: any[] = [];
        if (options?.instance_id !== undefined) { resolvedCountParams.push(options.instance_id); }
        const resolvedWhere = options?.instance_id !== undefined ? 'WHERE instance_id = ?' : '';
        const [[{ total: rv }]] = await pool.query(
          `SELECT COUNT(*) AS total FROM alerts ${resolvedWhere}${resolvedWhere ? ' AND' : 'WHERE'} status IN ('resolved','closed')`,
          resolvedCountParams
        ) as any;
        resolved = rv ?? 0;
      }

      return {
        items: rows.map((row: any) => ({
        id: row.id,
        instance_id: row.instance_id,
        instance_name: row.instance_name || `实例 #${row.instance_id}`,
        alert_type: row.alert_type,
        severity: row.level,
        title: row.title,
        message: row.message,
        description: row.description,
        status: row.status,
        acknowledged: row.status === 'acknowledged' || row.status === 'resolved' || row.status === 'closed',
        acknowledged_by: row.acknowledged_by ? String(row.acknowledged_by) : undefined,
        acknowledged_at: row.acknowledged_at ? new Date(row.acknowledged_at).toISOString() : undefined,
        resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : undefined,
        resolved_by: row.resolved_by ? String(row.resolved_by) : (row.status === 'resolved' ? 'auto' : undefined),
        metric_name: row.metric_name || null,
        metric_value: row.metric_value || null,
        threshold_value: row.threshold_value || null,
        created_at: new Date(row.created_at).toISOString(),
      })),
      total,
      unread,
      critical,
      warning,
      resolved,
      };
    } catch (error) {
      console.error('获取告警列表失败:', error);
      return { items: [], total: 0, unread: 0, critical: 0, warning: 0, resolved: 0 };
    }
  }

  /**
   * 获取告警数量
   */
  async getAlertCount(options?: {
    instance_id?: number;
    status?: string;
    level?: string;
  }): Promise<number> {
    const pool = this.getPool();
    if (!pool) {
      return 0;
    }

    try {
      let sql = 'SELECT COUNT(*) as count FROM alerts WHERE 1=1';
      const params: any[] = [];

      if (options?.instance_id !== undefined) {
        sql += ' AND instance_id = ?';
        params.push(options.instance_id);
      }
      if (options?.status) {
        const statuses = options.status.split(',').map(s => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          sql += ' AND status = ?';
          params.push(statuses[0]);
        } else if (statuses.length > 1) {
          sql += ` AND status IN (${statuses.map(() => '?').join(',')})`;
          params.push(...statuses);
        }
      }
      if (options?.level) {
        sql += ' AND level = ?';
        params.push(options.level);
      }

      const [rows] = await pool.query(sql, params) as any;
      return rows[0]?.count || 0;
    } catch (error) {
      console.error('获取告警数量失败:', error);
      return 0;
    }
  }

  /**
   * 获取未读告警数量
   */
  async getUnreadAlertCount(): Promise<number> {
    return this.getAlertCount({ status: 'unread' });
  }

  /**
   * 标记告警已读
   */
  async markAlertAsRead(alertId: number, userId?: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        'UPDATE alerts SET status = "read", acknowledged_by = ?, acknowledged_at = NOW() WHERE id = ?',
        [userId || null, alertId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('标记告警已读失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 确认告警（人工确认：设置 status = 'acknowledged'）
   */
  async acknowledgeAlert(alertId: number, userId?: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        'UPDATE alerts SET status = "acknowledged", acknowledged_by = ?, acknowledged_at = NOW() WHERE id = ?',
        [userId || null, alertId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('确认告警失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 标记所有告警已读
   */
  async markAllAlertsAsRead(userId?: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        'UPDATE alerts SET status = "read", acknowledged_by = ?, acknowledged_at = NOW() WHERE status = "unread"',
        [userId || null]
      );
      return { success: true };
    } catch (error: any) {
      console.error('标记所有告警已读失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 清除告警（默认保留最近 30 天）
   */
  async clearAllAlerts(retentionDays: number = 30): Promise<{ success: boolean; error?: string; deletedCount?: number }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      if (retentionDays <= 0) {
        // 显式传 0 才允许清除所有（需确认操作）
        const [rows] = await pool.execute('SELECT COUNT(*) as count FROM alerts') as any;
        const total = rows[0]?.count || 0;
        await pool.execute('DELETE FROM alerts');
        console.log(`⚠️ 已清除全部 ${total} 条告警记录（retentionDays=${retentionDays}）`);
        return { success: true, deletedCount: total };
      }

      // 默认行为：只清除超过 retentionDays 的旧告警
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const [result] = await pool.execute('DELETE FROM alerts WHERE created_at < ?', [cutoff]) as any;
      const deletedCount = result.affectedRows ?? 0;
      if (deletedCount > 0) {
        console.log(`已清除 ${deletedCount} 条超过 ${retentionDays} 天的旧告警`);
      }
      return { success: true, deletedCount };
    } catch (error: any) {
      console.error('清除告警失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 解决告警
   */
  async resolveAlert(alertId: number, userId?: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        'UPDATE alerts SET status = "resolved", resolved_by = ?, resolved_at = NOW() WHERE id = ?',
        [userId || null, alertId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('解决告警失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 查找未解决的告警（去重用）
   */
  async findActiveAlert(instanceId: number, metricName: string, ruleId: number): Promise<Alert | null> {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      // 先按 rule_id 精确匹配
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT * FROM alerts
         WHERE instance_id = ? AND metric_name = ?
         AND JSON_EXTRACT(tags, '$.rule_id') = ?
         AND status IN ('unread', 'read', 'acknowledged')
         ORDER BY created_at DESC LIMIT 1`,
        [instanceId, metricName, ruleId]
      );
      if (rows.length > 0) return this._rowToAlert(rows[0]);

      // 回退：rule_id 可能因旧数据为 null 而没匹配到，按 instance+metric 匹配
      const [fallbackRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT * FROM alerts
         WHERE instance_id = ? AND metric_name = ?
         AND status IN ('unread', 'read', 'acknowledged')
         ORDER BY created_at DESC LIMIT 1`,
        [instanceId, metricName]
      );
      return fallbackRows.length > 0 ? this._rowToAlert(fallbackRows[0]) : null;
    } catch (error) {
      console.error('查找活跃告警失败:', error);
      return null;
    }
  }

  /**
   * 更新已有告警的指标值和更新时间（去重 touch）
   */
  async touchAlert(alertId: number, metricValue: number): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;

    try {
      await pool.execute(
        `UPDATE alerts SET metric_value = ?, updated_at = NOW() WHERE id = ?`,
        [metricValue, alertId]
      );
    } catch (error) {
      console.error('更新告警指标值失败:', error);
    }
  }

  /**
   * 获取所有未解决的告警
   */
  async getActiveAlerts(): Promise<Alert[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT * FROM alerts WHERE status IN ('unread', 'read', 'acknowledged')`
      );
      return rows.map(r => this._rowToAlert(r));
    } catch (error) {
      console.error('获取活跃告警失败:', error);
      return [];
    }
  }

  /**
   * 删除告警
   */
  async deleteAlert(alertId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute('DELETE FROM alerts WHERE id = ?', [alertId]);
      return { success: true };
    } catch (error: any) {
      console.error('删除告警失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 根据 ID 获取告警规则
   */
  async getRuleById(ruleId: number): Promise<AlertRule | null> {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, name, description, metric_name, operator, threshold,
                threshold_template, threshold_type, dynamic_config, silence_minutes,
                db_types, instance_ids, template_id,
                duration_seconds, severity, enabled, notification_channels,
                created_by, created_at, updated_at
         FROM alert_rules WHERE id = ?`,
        [ruleId]
      );
      return rows.length > 0 ? rows[0] as AlertRule : null;
    } catch (error) {
      console.error('获取告警规则失败:', error);
      return null;
    }
  }

  /**
   * 获取告警规则列表
   */
  async getAlertRules(enabled?: boolean): Promise<AlertRule[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      let sql = `
        SELECT id, name, description, metric_name, operator, threshold,
               threshold_template, threshold_type, dynamic_config, silence_minutes,
               db_types, instance_ids, template_id, duration_seconds, severity,
               enabled, notification_channels,
               created_by, created_at, updated_at
        FROM alert_rules
      `;
      const params: any[] = [];

      if (enabled !== undefined) {
        sql += ' WHERE enabled = ?';
        params.push(enabled ? 1 : 0);
      }

      sql += ' ORDER BY name';

      const [rows] = await pool.query(sql, params) as any;
      return rows as AlertRule[];
    } catch (error) {
      console.error('获取告警规则失败:', error);
      return [];
    }
  }

  /**
   * 创建告警规则
   */
  async createAlertRule(data: {
    name: string;
    description?: string;
    metric_name: string;
    operator: string;
    threshold: number;
    threshold_template?: { warning: number; error: number; critical: number } | null;
    threshold_type?: string;
    dynamic_config?: any;
    silence_minutes?: number;
    duration_seconds?: number;
    severity: string;
    notification_channels?: any;
    db_types?: string[] | null;
    instance_ids?: number[] | null;
    template_id?: number | null;
    created_by?: number;
  }): Promise<{ success: boolean; ruleId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute(
        `INSERT INTO alert_rules
         (name, description, metric_name, operator, threshold, threshold_template,
          threshold_type, dynamic_config, silence_minutes, duration_seconds,
          severity, notification_channels, db_types, instance_ids, template_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.name,
          data.description || null,
          data.metric_name,
          data.operator,
          data.threshold,
          data.threshold_template ? JSON.stringify(data.threshold_template) : null,
          data.threshold_type || 'static',
          data.dynamic_config ? JSON.stringify(data.dynamic_config) : null,
          data.silence_minutes ?? 5,
          data.duration_seconds || 60,
          data.severity,
          data.notification_channels ? JSON.stringify(data.notification_channels) : null,
          data.db_types ? JSON.stringify(data.db_types) : null,
          data.instance_ids ? JSON.stringify(data.instance_ids) : null,
          data.template_id || null,
          data.created_by || null,
        ]
      ) as any;

      return { success: true, ruleId: result.insertId };
    } catch (error: any) {
      console.error('创建告警规则失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新告警规则
   */
  async updateAlertRule(
    ruleId: number,
    data: {
      name?: string;
      description?: string;
      metric_name?: string;
      operator?: string;
      threshold?: number;
      threshold_type?: string;
      threshold_template?: any;
      dynamic_config?: any;
      silence_minutes?: number;
      duration_seconds?: number;
      severity?: string;
      enabled?: boolean;
      notification_channels?: any;
      db_types?: string[] | null;
      instance_ids?: number[] | null;
      template_id?: number | null;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

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
      if (data.metric_name !== undefined) {
        updates.push('metric_name = ?');
        values.push(data.metric_name);
      }
      if (data.operator !== undefined) {
        updates.push('operator = ?');
        values.push(data.operator);
      }
      if (data.threshold !== undefined) {
        updates.push('threshold = ?');
        values.push(data.threshold);
      }
      if (data.duration_seconds !== undefined) {
        updates.push('duration_seconds = ?');
        values.push(data.duration_seconds);
      }
      if (data.severity !== undefined) {
        updates.push('severity = ?');
        values.push(data.severity);
      }
      if (data.enabled !== undefined) {
        updates.push('enabled = ?');
        values.push(data.enabled ? 1 : 0);
      }
      if (data.notification_channels !== undefined) {
        updates.push('notification_channels = ?');
        values.push(JSON.stringify(data.notification_channels));
      }
      if (data.threshold_type !== undefined) {
        updates.push('threshold_type = ?');
        values.push(data.threshold_type);
      }
      if (data.threshold_template !== undefined) {
        updates.push('threshold_template = ?');
        values.push(JSON.stringify(data.threshold_template));
      }
      if (data.dynamic_config !== undefined) {
        updates.push('dynamic_config = ?');
        values.push(data.dynamic_config ? JSON.stringify(data.dynamic_config) : null);
      }
      if (data.silence_minutes !== undefined) {
        updates.push('silence_minutes = ?');
        values.push(data.silence_minutes);
      }
      if (data.db_types !== undefined) {
        updates.push('db_types = ?');
        values.push(data.db_types ? JSON.stringify(data.db_types) : null);
      }
      if (data.instance_ids !== undefined) {
        updates.push('instance_ids = ?');
        values.push(data.instance_ids ? JSON.stringify(data.instance_ids) : null);
      }
      if (data.template_id !== undefined) {
        updates.push('template_id = ?');
        values.push(data.template_id);
      }

      if (updates.length === 0) {
        return { success: true };
      }

      values.push(ruleId);

      await pool.execute(
        `UPDATE alert_rules SET ${updates.join(', ')} WHERE id = ?`,
        values
      );

      return { success: true };
    } catch (error: any) {
      console.error('更新告警规则失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 删除告警规则
   */
  async deleteAlertRule(ruleId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute('DELETE FROM alert_rules WHERE id = ?', [ruleId]);
      return { success: true };
    } catch (error: any) {
      console.error('删除告警规则失败:', error);
      return { success: false, error: error.message };
    }
  }
}

// 单例
export const alertDatabaseService = new AlertDatabaseService();
