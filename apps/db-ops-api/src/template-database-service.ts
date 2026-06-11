/**
 * 指标模板数据库服务 — metric_templates + instance_templates CRUD
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';

export interface MetricTemplate {
  id: number;
  name: string;
  description: string | null;
  db_type: string | null;
  macro_defaults: Record<string, number> | null;
  metrics: string[] | null;
  enabled: boolean;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface InstanceTemplateLink {
  instance_id: number;
  template_id: number;
  macro_overrides: Record<string, number> | null;
  disabled_metrics: string[] | null;
  created_at: Date;
  updated_at: Date;
}

class TemplateDatabaseService {
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  // ─── Metric Templates CRUD ──────────────────────────────

  async listTemplates(options?: { db_type?: string; enabled?: boolean }): Promise<MetricTemplate[]> {
    const pool = this.getPool();
    if (!pool) return [];

    let sql = `SELECT id, name, description, db_type, macro_defaults, metrics, enabled, created_by, created_at, updated_at
               FROM metric_templates WHERE 1=1`;
    const params: any[] = [];

    if (options?.db_type) {
      sql += ' AND (db_type = ? OR db_type IS NULL)';
      params.push(options.db_type);
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
      macro_defaults: r.macro_defaults ? (typeof r.macro_defaults === 'string' ? JSON.parse(r.macro_defaults) : r.macro_defaults) : null,
      metrics: r.metrics ? (typeof r.metrics === 'string' ? JSON.parse(r.metrics) : r.metrics) : null,
    }));
  }

  async getTemplate(id: number): Promise<MetricTemplate | null> {
    const pool = this.getPool();
    if (!pool) return null;

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, name, description, db_type, macro_defaults, metrics, enabled, created_by, created_at, updated_at
       FROM metric_templates WHERE id = ?`, [id]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      ...r,
      enabled: Boolean(r.enabled),
      macro_defaults: r.macro_defaults ? (typeof r.macro_defaults === 'string' ? JSON.parse(r.macro_defaults) : r.macro_defaults) : null,
      metrics: r.metrics ? (typeof r.metrics === 'string' ? JSON.parse(r.metrics) : r.metrics) : null,
    } as MetricTemplate;
  }

  async createTemplate(data: {
    name: string;
    description?: string;
    db_type?: string;
    macro_defaults?: Record<string, number>;
    metrics?: string[];
    created_by?: number;
  }): Promise<{ success: boolean; id?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const [result] = await pool.execute(
        `INSERT INTO metric_templates (name, description, db_type, macro_defaults, metrics, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          data.name,
          data.description || null,
          data.db_type || null,
          data.macro_defaults ? JSON.stringify(data.macro_defaults) : null,
          data.metrics ? JSON.stringify(data.metrics) : null,
          data.created_by || null,
        ]
      ) as any;
      return { success: true, id: result.insertId };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        return { success: false, error: `模板名 "${data.name}" 已存在` };
      }
      console.error('创建模板失败:', error);
      return { success: false, error: error.message };
    }
  }

  async updateTemplate(id: number, data: {
    name?: string;
    description?: string;
    db_type?: string;
    macro_defaults?: Record<string, number>;
    metrics?: string[];
    enabled?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const updates: string[] = [];
      const values: any[] = [];

      if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name); }
      if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description); }
      if (data.db_type !== undefined) { updates.push('db_type = ?'); values.push(data.db_type); }
      if (data.macro_defaults !== undefined) { updates.push('macro_defaults = ?'); values.push(JSON.stringify(data.macro_defaults)); }
      if (data.metrics !== undefined) { updates.push('metrics = ?'); values.push(JSON.stringify(data.metrics)); }
      if (data.enabled !== undefined) { updates.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }

      if (updates.length === 0) return { success: true };
      values.push(id);

      const [result] = await pool.execute(
        `UPDATE metric_templates SET ${updates.join(', ')} WHERE id = ?`, values
      ) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '模板不存在' };
      }
      return { success: true };
    } catch (error: any) {
      console.error('更新模板失败:', error);
      return { success: false, error: error.message };
    }
  }

  async deleteTemplate(id: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      // 检查模板是否存在
      const [check] = await pool.execute('SELECT id FROM metric_templates WHERE id = ?', [id]) as any;
      if (!Array.isArray(check) || check.length === 0) {
        return { success: false, error: '模板不存在' };
      }
      // 删除关联的 instance_templates
      await pool.execute('DELETE FROM instance_templates WHERE template_id = ?', [id]);
      // 将关联的 metric_definitions 和 alert_rules 解除模板关联
      await pool.execute('UPDATE metric_definitions SET template_id = NULL WHERE template_id = ?', [id]);
      await pool.execute('UPDATE alert_rules SET template_id = NULL WHERE template_id = ?', [id]);
      // 删除模板本身
      await pool.execute('DELETE FROM metric_templates WHERE id = ?', [id]);
      return { success: true };
    } catch (error: any) {
      console.error('删除模板失败:', error);
      return { success: false, error: error.message };
    }
  }

  // ─── Instance-Template Link CRUD ────────────────────────

  async getInstanceTemplates(instanceId: number): Promise<(InstanceTemplateLink & { template?: Partial<MetricTemplate> })[]> {
    const pool = this.getPool();
    if (!pool) return [];

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT it.instance_id, it.template_id, it.macro_overrides, it.disabled_metrics, it.created_at, it.updated_at,
              t.name AS template_name, t.description AS template_description, t.db_type AS template_db_type,
              t.macro_defaults AS template_macro_defaults, t.metrics AS template_metrics, t.enabled AS template_enabled
       FROM instance_templates it
       JOIN metric_templates t ON t.id = it.template_id
       WHERE it.instance_id = ?
       ORDER BY t.name`, [instanceId]
    );

    return rows.map((r: any) => ({
      instance_id: r.instance_id,
      template_id: r.template_id,
      macro_overrides: r.macro_overrides ? (typeof r.macro_overrides === 'string' ? JSON.parse(r.macro_overrides) : r.macro_overrides) : null,
      disabled_metrics: r.disabled_metrics ? (typeof r.disabled_metrics === 'string' ? JSON.parse(r.disabled_metrics) : r.disabled_metrics) : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      template: {
        id: r.template_id,
        name: r.template_name,
        description: r.template_description,
        db_type: r.template_db_type,
        macro_defaults: r.template_macro_defaults ? (typeof r.template_macro_defaults === 'string' ? JSON.parse(r.template_macro_defaults) : r.template_macro_defaults) : null,
        metrics: r.template_metrics ? (typeof r.template_metrics === 'string' ? JSON.parse(r.template_metrics) : r.template_metrics) : null,
        enabled: r.template_enabled,
      },
    }));
  }

  async linkTemplate(instanceId: number, templateId: number, macro_overrides?: Record<string, number>): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      await pool.execute(
        `INSERT INTO instance_templates (instance_id, template_id, macro_overrides) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE macro_overrides = VALUES(macro_overrides), updated_at = NOW()`,
        [instanceId, templateId, macro_overrides ? JSON.stringify(macro_overrides) : null]
      );
      return { success: true };
    } catch (error: any) {
      console.error('关联模板失败:', error);
      return { success: false, error: error.message };
    }
  }

  async unlinkTemplate(instanceId: number, templateId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const [result] = await pool.execute(
        'DELETE FROM instance_templates WHERE instance_id = ? AND template_id = ?',
        [instanceId, templateId]
      ) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '关联不存在' };
      }
      return { success: true };
    } catch (error: any) {
      console.error('解除模板关联失败:', error);
      return { success: false, error: error.message };
    }
  }

  async updateInstanceOverrides(instanceId: number, templateId: number, macro_overrides: Record<string, number>): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      await pool.execute(
        'UPDATE instance_templates SET macro_overrides = ?, updated_at = NOW() WHERE instance_id = ? AND template_id = ?',
        [JSON.stringify(macro_overrides), instanceId, templateId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('更新实例宏覆盖失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取实例的完整 macros 上下文（合并所有关联模板 + 实例覆盖）
   * 优先级：instance overrides > template macro_defaults >（按模板列表顺序，后合并的覆盖先合并的）
   */
  async getResolvedMacros(instanceId: number): Promise<Record<string, number>> {
    const links = await this.getInstanceTemplates(instanceId);
    const macros: Record<string, number> = {};

    for (const link of links) {
      // 模板默认值
      if (link.template?.macro_defaults) {
        Object.assign(macros, link.template.macro_defaults);
      }
      // 实例覆盖（优先级更高）
      if (link.macro_overrides) {
        Object.assign(macros, link.macro_overrides);
      }
    }

    return macros;
  }
}

export const templateDatabaseService = new TemplateDatabaseService();
