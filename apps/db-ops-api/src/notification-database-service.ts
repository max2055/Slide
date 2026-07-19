/**
 * 通知数据库服务
 */
import mysql from 'mysql2/promise';
import { dbConnection, encryptData } from './db-connection';

export interface NotificationChannelConfig {
  webhook_url?: string;
  secret?: string;
  secret_encrypted?: string;
  severity?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_username?: string;
  smtp_auth?: 'password' | 'oauth2';
  password?: string;
  password_encrypted?: string;
  oauth2_tenant?: string;
  oauth2_client_id?: string;
  oauth2_refresh_token?: string;
  oauth2_refresh_token_encrypted?: string;
  from?: string;
  to?: string;
  smtp_secure?: boolean;
}

export interface NotificationChannel {
  id: number;
  name: string;
  type: 'email' | 'dingtalk' | 'wecom' | 'feishu' | 'webhook';
  config: NotificationChannelConfig;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface NotificationRecord {
  id: number;
  alert_id: number;
  channel_id: number;
  status: 'pending' | 'sent' | 'failed' | 'suppressed';
  error: string | null;
  sent_at: Date | null;
  created_at: Date;
}

export interface PendingAlert {
  id: number;
  instance_id: number | null;
  alert_type: string;
  level: string;
  title: string;
  message: string;
  metric_name: string | null;
  metric_value: string | null;
  threshold_value: string | null;
  tags: any;
  created_at: Date;
  instance_name: string | null;
  instance_host: string | null;
}

class NotificationDatabaseService {
  private prepareConfigForStorage(config: unknown): Record<string, unknown> {
    const stored = { ...((config && typeof config === 'object' ? config : {}) as Record<string, unknown>) };
    if (typeof stored.password === 'string') {
      if (stored.password.length > 0) {
        stored.password_encrypted = encryptData(stored.password);
      }
      delete stored.password;
    }
    if (typeof stored.oauth2_refresh_token === 'string') {
      if (stored.oauth2_refresh_token.length > 0) {
        stored.oauth2_refresh_token_encrypted = encryptData(stored.oauth2_refresh_token);
      }
      delete stored.oauth2_refresh_token;
    }
    if (typeof stored.secret === 'string') {
      if (stored.secret.length > 0) {
        stored.secret_encrypted = encryptData(stored.secret);
      }
      delete stored.secret;
    }
    return stored;
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
   * 创建通知渠道
   */
  async createChannel(data: {
    name: string;
    type: string;
    config: any;
    enabled?: boolean;
  }): Promise<{ success: boolean; channelId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute(
        `INSERT INTO notification_channels (name, type, config, enabled)
         VALUES (?, ?, ?, ?)`,
        [
          data.name,
          data.type,
          JSON.stringify(this.prepareConfigForStorage(data.config)),
          data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
        ]
      ) as any;

      return { success: true, channelId: result.insertId };
    } catch (error: any) {
      console.error('创建通知渠道失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取通知渠道列表
   */
  async getChannels(enabled?: boolean): Promise<NotificationChannel[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      let sql = `
        SELECT id, name, type, config, enabled, created_at, updated_at
        FROM notification_channels
      `;
      const params: any[] = [];

      if (enabled !== undefined) {
        sql += ' WHERE enabled = ?';
        params.push(enabled ? 1 : 0);
      }

      sql += ' ORDER BY name';

      const [rows] = await pool.execute(sql, params) as any;
      return rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
        enabled: Boolean(row.enabled),
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));
    } catch (error) {
      console.error('获取通知渠道失败:', error);
      return [];
    }
  }

  /**
   * 按 ID 查询通知渠道
   */
  async getChannelById(id: number): Promise<NotificationChannel | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        `SELECT id, name, type, config, enabled, created_at, updated_at
         FROM notification_channels WHERE id = ?`,
        [id]
      ) as any;

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
        enabled: Boolean(row.enabled),
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    } catch (error) {
      console.error('获取通知渠道失败:', error);
      return null;
    }
  }

  /**
   * 更新通知渠道
   */
  async updateChannel(
    id: number,
    data: {
      name?: string;
      type?: string;
      config?: any;
      enabled?: boolean;
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
      if (data.type !== undefined) {
        updates.push('type = ?');
        values.push(data.type);
      }
      if (data.config !== undefined) {
        const config = this.prepareConfigForStorage(data.config);
        const suppliedConfig = data.config && typeof data.config === 'object'
          ? data.config as Record<string, unknown>
          : {};
        const passwordWasSupplied = Object.prototype.hasOwnProperty.call(suppliedConfig, 'password')
          || Object.prototype.hasOwnProperty.call(suppliedConfig, 'password_encrypted');
        const secretWasSupplied = Object.prototype.hasOwnProperty.call(suppliedConfig, 'secret')
          || Object.prototype.hasOwnProperty.call(suppliedConfig, 'secret_encrypted');
        if (!passwordWasSupplied || !secretWasSupplied) {
          const [rows] = await pool.execute(
            'SELECT config FROM notification_channels WHERE id = ?',
            [id],
          ) as any;
          const existingConfig = rows[0]?.config;
          try {
            const parsed = typeof existingConfig === 'string' ? JSON.parse(existingConfig) : existingConfig;
            if (typeof parsed?.password_encrypted === 'string') {
              if (!passwordWasSupplied) config.password_encrypted = parsed.password_encrypted;
            }
            if (typeof parsed?.secret_encrypted === 'string' && !secretWasSupplied) {
              config.secret_encrypted = parsed.secret_encrypted;
            }
          } catch {
            // An invalid legacy config will be rejected by the normal UPDATE path rather than exposing its contents.
          }
        }
        updates.push('config = ?');
        values.push(JSON.stringify(config));
      }
      if (data.enabled !== undefined) {
        updates.push('enabled = ?');
        values.push(data.enabled ? 1 : 0);
      }

      if (updates.length === 0) {
        return { success: true };
      }

      values.push(id);

      const [result] = await pool.execute(
        `UPDATE notification_channels SET ${updates.join(', ')} WHERE id = ?`,
        values
      ) as any;

      if (result.affectedRows === 0) {
        return { success: false, error: '通知渠道不存在' };
      }

      return { success: true };
    } catch (error: any) {
      console.error('更新通知渠道失败:', error);
      return { success: false, error: error.message };
    }
  }

  /** Persists a Microsoft-issued rotated refresh token without reading or logging any channel secret. */
  async updateOAuth2RefreshToken(id: number, refreshToken: string): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const [result] = await pool.execute(
        "UPDATE notification_channels SET config = JSON_SET(config, '$.oauth2_refresh_token_encrypted', ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND type = 'email'",
        [encryptData(refreshToken), id],
      ) as any;
      if (result.affectedRows === 0) return { success: false, error: '通知渠道不存在' };
      return { success: true };
    } catch (error: any) {
      console.error('更新 OAuth 刷新令牌失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 删除通知渠道
   */
  async deleteChannel(id: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute('DELETE FROM notification_channels WHERE id = ?', [id]) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '通知渠道不存在' };
      }
      return { success: true };
    } catch (error: any) {
      console.error('删除通知渠道失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取待推送告警：status='unread' 且不存在于 notification_records 的告警
   * JOIN database_instances 获取实例名和主机
   */
  async getPendingAlerts(): Promise<PendingAlert[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        `SELECT a.id, a.instance_id, a.alert_type, a.level, a.title, a.message,
                a.metric_name, a.metric_value, a.threshold_value, a.tags, a.created_at,
                di.name AS instance_name, di.host AS instance_host
         FROM alerts a
         LEFT JOIN database_instances di ON a.instance_id = di.id
         WHERE a.status = 'unread'
         ORDER BY a.created_at ASC`
      ) as any;

      return rows.map((row: any) => ({
        id: row.id,
        instance_id: row.instance_id,
        alert_type: row.alert_type,
        level: row.level,
        title: row.title,
        message: row.message,
        metric_name: row.metric_name,
        metric_value: row.metric_value,
        threshold_value: row.threshold_value,
        tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
        created_at: row.created_at,
        instance_name: row.instance_name,
        instance_host: row.instance_host,
      }));
    } catch (error) {
      console.error('获取待推送告警失败:', error);
      return [];
    }
  }

  /**
   * 获取已启用的通知渠道
   */
  async getEnabledChannels(): Promise<NotificationChannel[]> {
    return this.getChannels(true);
  }

  /**
   * 按 ID 获取告警（含实例名和主机信息），用于升级通知等场景
   */
  async getAlertById(alertId: number): Promise<PendingAlert | null> {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      const [rows] = await pool.execute(
        `SELECT a.id, a.instance_id, a.alert_type, a.level, a.title, a.message,
                a.metric_name, a.metric_value, a.threshold_value, a.tags, a.created_at,
                d.name AS instance_name, d.host AS instance_host
         FROM alerts a
         LEFT JOIN database_instances d ON a.instance_id = d.id
         WHERE a.id = ?`,
        [alertId]
      ) as any;

      if (!Array.isArray(rows) || rows.length === 0) {
        return null;
      }

      const row = rows[0];
      return {
        id: row.id,
        instance_id: row.instance_id,
        alert_type: row.alert_type,
        level: row.level,
        title: row.title,
        message: row.message,
        metric_name: row.metric_name,
        metric_value: row.metric_value,
        threshold_value: row.threshold_value,
        tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
        created_at: row.created_at,
        instance_name: row.instance_name,
        instance_host: row.instance_host,
      };
    } catch (error) {
      console.error('获取告警失败:', error);
      return null;
    }
  }

  /**
   * 记录通知发送结果
   */
  async recordNotification(data: {
    alert_id: number;
    channel_id: number;
    status: 'pending' | 'sent' | 'failed' | 'suppressed';
    error?: string;
    sent_at?: Date;
  }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        `INSERT INTO notification_records (alert_id, channel_id, status, error, sent_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          data.alert_id,
          data.channel_id,
          data.status,
          data.error || null,
          data.sent_at || null,
        ]
      );
      return { success: true };
    } catch (error: any) {
      console.error('记录通知失败:', error);
      return { success: false, error: error.message };
    }
  }

  async hasSuccessfulDelivery(alertId: number, channelId: number): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) return false;
    const [rows] = await pool.execute(
      `SELECT 1 FROM notification_records
       WHERE alert_id = ? AND channel_id = ? AND status = 'sent' LIMIT 1`,
      [alertId, channelId],
    ) as any;
    return Array.isArray(rows) && rows.length > 0;
  }

  async recordDeliveryAttempt(data: {
    job_id: string; alert_id: number; channel_id: number; attempt_number: number;
    status: 'started' | 'sent' | 'failed'; error_code?: string; error_message?: string;
  }): Promise<void> {
    const pool = this.getPool();
    if (!pool) throw new Error('NOTIFICATION_AUDIT_UNAVAILABLE');
    await pool.execute(
      `INSERT INTO notification_delivery_attempts
       (workflow_job_id, alert_id, channel_id, attempt_number, status, error_code, error_message, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, IF(? IN ('sent', 'failed'), NOW(), NULL))
       ON DUPLICATE KEY UPDATE status = VALUES(status), error_code = VALUES(error_code),
       error_message = VALUES(error_message), finished_at = VALUES(finished_at)`,
      [data.job_id, data.alert_id, data.channel_id, data.attempt_number, data.status,
       data.error_code ?? null, data.error_message?.slice(0, 1024) ?? null, data.status],
    );
  }

  async recordReplay(jobId: string, actorId: number, reason: string): Promise<void> {
    const pool = this.getPool();
    if (!pool) throw new Error('NOTIFICATION_AUDIT_UNAVAILABLE');
    await pool.execute(
      'INSERT INTO notification_delivery_replays (workflow_job_id, actor_id, reason) VALUES (?, ?, ?)',
      [jobId, actorId, reason.slice(0, 512)],
    );
  }

  /**
   * 标记告警为已处理（用于维护窗口抑制等场景）
   */
  async markAlertAsNotified(alertId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      await pool.execute(
        `INSERT INTO notification_records (alert_id, channel_id, status, sent_at)
         VALUES (?, 0, 'suppressed', NOW())`,
        [alertId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('标记告警为已通知失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 查询通知记录（支持过滤）
   */
  async getRecords(filters?: {
    alert_id?: number;
    channel_id?: number;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<NotificationRecord[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      let sql = `
        SELECT id, alert_id, channel_id, status, error, sent_at, created_at
        FROM notification_records
        WHERE 1=1
      `;
      const params: any[] = [];

      if (filters?.alert_id !== undefined) {
        sql += ' AND alert_id = ?';
        params.push(filters.alert_id);
      }
      if (filters?.channel_id !== undefined) {
        sql += ' AND channel_id = ?';
        params.push(filters.channel_id);
      }
      if (filters?.status) {
        const VALID_STATUSES = ['pending', 'sent', 'failed', 'suppressed'];
        if (!VALID_STATUSES.includes(filters.status)) {
          // 使用 throw 让上层 catch 捕获（与 pool.execute 失败的处理一致）
          throw new Error(`Invalid status filter: ${filters.status}. Valid values: ${VALID_STATUSES.join(', ')}`);
        }
        sql += ' AND status = ?';
        params.push(filters.status);
      }

      sql += ' ORDER BY created_at DESC';

      if (filters?.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(filters.limit);
      }
      if (filters?.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(filters.offset);
      }

      const [rows] = await pool.execute(sql, params) as any;
      return rows;
    } catch (error) {
      console.error('获取通知记录失败:', error);
      return [];
    }
  }

  /**
   * 检查告警风暴：同一实例+同一等级+同一指标在 5 分钟窗口内是否已推送
   */
  async hasRecentNotification(
    instanceId: number | null,
    level: string,
    metricName: string | null,
    windowMinutes: number = 5
  ): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) {
      return false;
    }

    try {
      const [rows] = await pool.execute(
        `SELECT 1 FROM notification_records nr
         JOIN alerts a ON nr.alert_id = a.id
         WHERE a.instance_id <=> ?
           AND a.level = ?
           AND a.metric_name <=> ?
           AND nr.sent_at IS NOT NULL
           AND nr.sent_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
         LIMIT 1`,
        [instanceId, level, metricName, windowMinutes]
      ) as any;

      return rows.length > 0;
    } catch (error) {
      console.error('检查告警风暴失败:', error);
      return false;
    }
  }
}

// 单例
export const notificationDatabaseService = new NotificationDatabaseService();
