/**
 * 告警模板数据库服务 — alert_rule_templates CRUD
 *
 * 提供告警规则模板的增删改查，支持 target_type 过滤。
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';

export interface AlertRuleTemplate {
  id: number;
  name: string;
  description: string | null;
  target_type: 'instance' | 'server' | 'network_device';
  metric_name: string;
  operator: string;
  threshold_template: Record<string, number> | null;
  duration_seconds: number;
  severity: 'info' | 'warning' | 'error' | 'critical';
  silence_minutes: number;
  enabled: boolean;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

/** Built-in read-only presets for fixed-profile server evidence. */
export const SERVER_ALERT_TEMPLATES = Object.freeze([
  {
    name: '服务器不可达', description: '服务器连接连续失败或无法访问', target_type: 'server' as const,
    metric_name: 'reachability', operator: '=', threshold_template: { warning: 1, error: 2, critical: 3 },
    duration_seconds: 600, severity: 'error' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '网络接收错误过高', description: '服务器网络接口接收错误累计值超过阈值', target_type: 'server' as const,
    metric_name: 'network_rx_errors', operator: '>=', threshold_template: { warning: 1, error: 10, critical: 100 },
    duration_seconds: 120, severity: 'warning' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '网络发送错误过高', description: '服务器网络接口发送错误累计值超过阈值', target_type: 'server' as const,
    metric_name: 'network_tx_errors', operator: '>=', threshold_template: { warning: 1, error: 10, critical: 100 },
    duration_seconds: 120, severity: 'warning' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '网络接收丢包过高', description: '服务器网络接口接收丢弃累计值超过阈值', target_type: 'server' as const,
    metric_name: 'network_rx_drops', operator: '>=', threshold_template: { warning: 1, error: 10, critical: 100 },
    duration_seconds: 120, severity: 'warning' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '网络发送丢包过高', description: '服务器网络接口发送丢弃累计值超过阈值', target_type: 'server' as const,
    metric_name: 'network_tx_drops', operator: '>=', threshold_template: { warning: 1, error: 10, critical: 100 },
    duration_seconds: 120, severity: 'warning' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '磁盘 I/O 时间过高', description: '服务器块设备累计 I/O 时间超过阈值', target_type: 'server' as const,
    metric_name: 'disk_io_time_ms', operator: '>=', threshold_template: { warning: 100, error: 500, critical: 1000 },
    duration_seconds: 180, severity: 'warning' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '进程数过高', description: '服务器当前进程数量超过阈值', target_type: 'server' as const,
    metric_name: 'process_count', operator: '>=', threshold_template: { warning: 500, error: 1000, critical: 2000 },
    duration_seconds: 120, severity: 'warning' as const, silence_minutes: 5, enabled: true,
  },
] as const);

/** Built-in read-only presets for Huawei VRP network-device evidence. */
export const NETWORK_DEVICE_ALERT_TEMPLATES = Object.freeze([
  {
    name: '网络设备不可达', description: '网络设备连续采集失败或不可达', target_type: 'network_device' as const,
    metric_name: 'device_reachability', operator: '=', threshold_template: { warning: 0, error: 0, critical: 0 },
    duration_seconds: 600, severity: 'error' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '网络设备 CPU 过高', description: '华为 VRP 设备 CPU 使用率超过阈值', target_type: 'network_device' as const,
    metric_name: 'device_cpu_percent', operator: '>=', threshold_template: { warning: 80, error: 90, critical: 95 },
    duration_seconds: 120, severity: 'warning' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '网络设备内存过高', description: '华为 VRP 设备内存使用率超过阈值', target_type: 'network_device' as const,
    metric_name: 'device_memory_percent', operator: '>=', threshold_template: { warning: 80, error: 90, critical: 95 },
    duration_seconds: 120, severity: 'warning' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '网络设备温度过高', description: '华为 VRP 设备温度超过阈值', target_type: 'network_device' as const,
    metric_name: 'device_temperature_celsius', operator: '>=', threshold_template: { warning: 70, error: 80, critical: 90 },
    duration_seconds: 120, severity: 'warning' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '网络接口 down', description: '网络设备接口 operStatus 为 down', target_type: 'network_device' as const,
    metric_name: 'interface_oper_status', operator: '=', threshold_template: { warning: 0, error: 0, critical: 0 },
    duration_seconds: 60, severity: 'critical' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '网络接口错误率过高', description: '网络设备接口错误包速率超过阈值', target_type: 'network_device' as const,
    metric_name: 'interface_error_rate', operator: '>=', threshold_template: { warning: 1, error: 10, critical: 100 },
    duration_seconds: 120, severity: 'warning' as const, silence_minutes: 5, enabled: true,
  },
  {
    name: '网络接口丢弃率过高', description: '网络设备接口丢弃包速率超过阈值', target_type: 'network_device' as const,
    metric_name: 'interface_drop_rate', operator: '>=', threshold_template: { warning: 1, error: 10, critical: 100 },
    duration_seconds: 120, severity: 'warning' as const, silence_minutes: 5, enabled: true,
  },
] as const);

class AlertRuleTemplateDatabaseService {
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * 获取告警模板列表，支持 target_type 和 enabled 过滤
   */
  async listTemplates(options?: { target_type?: string; enabled?: boolean }): Promise<AlertRuleTemplate[]> {
    const pool = this.getPool();
    if (!pool) return [];

    let sql = `SELECT id, name, description, target_type, metric_name, operator,
                      threshold_template, duration_seconds, severity, silence_minutes,
                      enabled, created_by, created_at, updated_at
               FROM alert_rule_templates WHERE 1=1`;
    const params: any[] = [];

    if (options?.target_type) {
      sql += ' AND target_type = ?';
      params.push(options.target_type);
    }
    if (options?.enabled !== undefined) {
      sql += ' AND enabled = ?';
      params.push(options.enabled ? 1 : 0);
    }
    sql += ' ORDER BY name';

    const [rows] = await pool.query(sql, params) as any;
    return rows.map((r: any) => ({
      ...r,
      enabled: Boolean(r.enabled),
      threshold_template: r.threshold_template
        ? (typeof r.threshold_template === 'string' ? JSON.parse(r.threshold_template) : r.threshold_template)
        : null,
    }));
  }

  /**
   * 根据 ID 获取单个告警模板
   */
  async getTemplate(id: number): Promise<AlertRuleTemplate | null> {
    const pool = this.getPool();
    if (!pool) return null;

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, name, description, target_type, metric_name, operator,
              threshold_template, duration_seconds, severity, silence_minutes,
              enabled, created_by, created_at, updated_at
       FROM alert_rule_templates WHERE id = ?`, [id]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      ...r,
      enabled: Boolean(r.enabled),
      threshold_template: r.threshold_template
        ? (typeof r.threshold_template === 'string' ? JSON.parse(r.threshold_template) : r.threshold_template)
        : null,
    } as AlertRuleTemplate;
  }

  /**
   * 创建告警模板
   */
  async createTemplate(data: {
    name: string;
    description?: string;
    target_type?: 'instance' | 'server' | 'network_device';
    metric_name: string;
    operator: string;
    threshold_template?: Record<string, number>;
    duration_seconds?: number;
    severity?: string;
    silence_minutes?: number;
    enabled?: boolean;
    created_by?: number;
  }): Promise<{ success: boolean; id?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const [result] = await pool.execute(
        `INSERT INTO alert_rule_templates
         (name, description, target_type, metric_name, operator, threshold_template,
          duration_seconds, severity, silence_minutes, enabled, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.name,
          data.description || null,
          data.target_type || 'instance',
          data.metric_name,
          data.operator,
          data.threshold_template ? JSON.stringify(data.threshold_template) : null,
          data.duration_seconds || 60,
          data.severity || 'warning',
          data.silence_minutes ?? 5,
          data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
          data.created_by || null,
        ]
      ) as any;
      return { success: true, id: result.insertId };
    } catch (error: any) {
      console.error('创建告警模板失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新告警模板
   */
  async updateTemplate(id: number, data: {
    name?: string;
    description?: string;
    target_type?: 'instance' | 'server' | 'network_device';
    metric_name?: string;
    operator?: string;
    threshold_template?: Record<string, number> | null;
    duration_seconds?: number;
    severity?: string;
    silence_minutes?: number;
    enabled?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const updates: string[] = [];
      const values: any[] = [];

      if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name); }
      if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description); }
      if (data.target_type !== undefined) { updates.push('target_type = ?'); values.push(data.target_type); }
      if (data.metric_name !== undefined) { updates.push('metric_name = ?'); values.push(data.metric_name); }
      if (data.operator !== undefined) { updates.push('operator = ?'); values.push(data.operator); }
      if (data.threshold_template !== undefined) {
        updates.push('threshold_template = ?');
        values.push(data.threshold_template ? JSON.stringify(data.threshold_template) : null);
      }
      if (data.duration_seconds !== undefined) { updates.push('duration_seconds = ?'); values.push(data.duration_seconds); }
      if (data.severity !== undefined) { updates.push('severity = ?'); values.push(data.severity); }
      if (data.silence_minutes !== undefined) { updates.push('silence_minutes = ?'); values.push(data.silence_minutes); }
      if (data.enabled !== undefined) { updates.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }

      if (updates.length === 0) return { success: true };
      values.push(id);

      const [result] = await pool.execute(
        `UPDATE alert_rule_templates SET ${updates.join(', ')} WHERE id = ?`, values
      ) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '模板不存在' };
      }
      return { success: true };
    } catch (error: any) {
      console.error('更新告警模板失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 删除告警模板
   */
  async deleteTemplate(id: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const [result] = await pool.execute(
        'DELETE FROM alert_rule_templates WHERE id = ?', [id]
      ) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '模板不存在' };
      }
      return { success: true };
    } catch (error: any) {
      console.error('删除告警模板失败:', error);
      return { success: false, error: error.message };
    }
  }
}

// 单例导出
export const alertRuleTemplateService = new AlertRuleTemplateDatabaseService();
