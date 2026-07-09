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
  target_type: 'instance' | 'server';
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
    target_type?: 'instance' | 'server';
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
    target_type?: 'instance' | 'server';
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
