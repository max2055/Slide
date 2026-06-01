/**
 * 指标定义数据库服务 - metric_definitions 表 CRUD
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';

export interface MetricDefinitionRow {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  db_types: string; // JSON 字符串
  aggregation: string;
  default_interval: number;
  threshold_template: string | null; // JSON 字符串
  is_collected: boolean;
  is_builtin: boolean;
  collection_sqls: Record<string, string> | null; // { "mysql":"...", "postgresql":"..." }
  compute_expr: string | null;
  value_type: 'gauge' | 'counter' | 'histogram';
  category: string | null;
  updated_by: number | null;
  created_at: Date;
  updated_at: Date;
}

class MetricDatabaseService {
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
   * 获取所有指标定义
   */
  async getAllMetrics(): Promise<MetricDefinitionRow[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        'SELECT * FROM metric_definitions ORDER BY id'
      ) as any;
      return rows as MetricDefinitionRow[];
    } catch (error) {
      console.error('获取指标定义列表失败:', error);
      return [];
    }
  }

  /**
   * 根据 ID 获取指标定义
   */
  async getMetricById(id: string): Promise<MetricDefinitionRow | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT * FROM metric_definitions WHERE id = ?',
        [id]
      ) as any;
      return rows.length > 0 ? rows[0] as MetricDefinitionRow : null;
    } catch (error) {
      console.error('获取指标定义失败:', error);
      return null;
    }
  }

  /**
   * 根据数据库类型获取指标
   */
  async getMetricsByDbType(dbType: string): Promise<MetricDefinitionRow[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      const [rows] = await pool.execute(
        'SELECT * FROM metric_definitions WHERE JSON_CONTAINS(db_types, JSON_QUOTE(?)) ORDER BY id',
        [dbType]
      ) as any;
      return rows as MetricDefinitionRow[];
    } catch (error) {
      console.error('按数据库类型获取指标失败:', error);
      return [];
    }
  }

  /**
   * 检查指标是否为预定义指标
   */
  async isBuiltin(id: string): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) {
      return false;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT is_builtin FROM metric_definitions WHERE id = ?',
        [id]
      ) as any;
      return rows.length > 0 ? !!rows[0].is_builtin : false;
    } catch (error) {
      console.error('检查指标是否预定义失败:', error);
      return false;
    }
  }

  /**
   * 创建指标定义
   */
  async createMetric(data: {
    id: string;
    name: string;
    description?: string;
    unit: string;
    db_types: string[];
    aggregation: string;
    default_interval: number;
    is_collected?: boolean;
    collection_sqls?: Record<string, string>;
    compute_expr?: string;
    value_type?: string;
    category?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        `INSERT INTO metric_definitions
         (id, name, description, unit, db_types, aggregation, default_interval, is_collected, is_builtin, collection_sqls, compute_expr, value_type, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?, ?, ?)`,
        [
          data.id,
          data.name,
          data.description || null,
          data.unit,
          JSON.stringify(data.db_types),
          data.aggregation,
          data.default_interval,
          data.is_collected !== undefined ? data.is_collected : true,
          data.collection_sqls ? JSON.stringify(data.collection_sqls) : null,
          data.compute_expr || null,
          data.value_type || 'gauge',
          data.category || null,
        ]
      );

      return { success: true };
    } catch (error: any) {
      console.error('创建指标定义失败:', error);
      if (error.code === 'ER_DUP_ENTRY') {
        return { success: false, error: `指标 ID '${data.id}' 已存在` };
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新指标定义
   */
  async updateMetric(
    id: string,
    data: {
      name?: string;
      description?: string;
      unit?: string;
      db_types?: string[];
      aggregation?: string;
      default_interval?: number;
      is_collected?: boolean;
      collection_sqls?: Record<string, string>;
      compute_expr?: string;
      value_type?: string;
      category?: string;
      updated_by?: number;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const updates: string[] = [];
      const values: any[] = [];

      if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name); }
      if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description); }
      if (data.unit !== undefined) { updates.push('unit = ?'); values.push(data.unit); }
      if (data.db_types !== undefined) { updates.push('db_types = ?'); values.push(JSON.stringify(data.db_types)); }
      if (data.aggregation !== undefined) { updates.push('aggregation = ?'); values.push(data.aggregation); }
      if (data.default_interval !== undefined) { updates.push('default_interval = ?'); values.push(data.default_interval); }
      if (data.is_collected !== undefined) { updates.push('is_collected = ?'); values.push(data.is_collected ? 1 : 0); }
      if (data.collection_sqls !== undefined) { updates.push('collection_sqls = ?'); values.push(JSON.stringify(data.collection_sqls)); }
      if (data.compute_expr !== undefined) { updates.push('compute_expr = ?'); values.push(data.compute_expr); }
      if (data.value_type !== undefined) { updates.push('value_type = ?'); values.push(data.value_type); }
      if (data.category !== undefined) { updates.push('category = ?'); values.push(data.category); }
      if (data.updated_by !== undefined) { updates.push('updated_by = ?'); values.push(data.updated_by); }

      if (updates.length === 0) return { success: true };

      values.push(id);
      const sql = `UPDATE metric_definitions SET ${updates.join(', ')} WHERE id = ?`;
      const [result] = await pool.execute(sql, values) as any;
      if (result?.affectedRows === 0) {
        await pool.execute(
          `INSERT INTO metric_definitions (id, name, unit, db_types, aggregation, default_interval, is_builtin)
           VALUES (?, ?, ?, ?, ?, ?, TRUE)
           ON DUPLICATE KEY UPDATE name = VALUES(name)`,
          [id, id, '', '[]', 'avg', data.default_interval ?? 60]
        );
        await pool.execute(sql, values);
      }

      return { success: true };
    } catch (error: any) {
      console.error('更新指标定义失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 删除指标定义（预定义指标不可删除）
   */
  async deleteMetric(id: string): Promise<{ success: boolean; reason?: string; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute(
        'DELETE FROM metric_definitions WHERE id = ? AND is_builtin = FALSE',
        [id]
      ) as any;

      if (result.affectedRows === 0) {
        // 检查是否存在（如果是 builtin 则返回 403，否则 404）
        const [rows] = await pool.execute(
          'SELECT is_builtin FROM metric_definitions WHERE id = ?',
          [id]
        ) as any;
        if (rows.length > 0 && rows[0].is_builtin) {
          return { success: false, reason: 'builtin' };
        }
        return { success: false, reason: 'not_found' };
      }

      return { success: true };
    } catch (error: any) {
      console.error('删除指标定义失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 删除指标定义前检查告警规则引用 (D-17)
   * @returns {success:boolean, reason?:string, referencedBy?:any[], error?:string}
   *   reason='has_alerts' 时 referencedBy 包含引用的告警规则
   */
  async deleteMetricWithRefCheck(id: string): Promise<{
    success: boolean;
    reason?: string;
    referencedBy?: Array<{ id: number; name: string }>;
    error?: string;
  }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      // 检查是否为内置指标
      const [rows] = await pool.execute(
        'SELECT is_builtin FROM metric_definitions WHERE id = ?', [id]
      ) as any;
      if (rows.length === 0) return { success: false, reason: 'not_found' };
      if (rows[0].is_builtin) return { success: false, reason: 'builtin' };

      // 检查告警规则引用
      const [alertRules] = await pool.execute(
        'SELECT id, name FROM alert_rules WHERE metric_name = ?', [id]
      ) as any;
      if (alertRules && alertRules.length > 0) {
        return {
          success: false,
          reason: 'has_alerts',
          referencedBy: alertRules.map((r: any) => ({ id: r.id, name: r.name })),
        };
      }

      // 无引用，执行删除
      await pool.execute(
        'DELETE FROM metric_definitions WHERE id = ? AND is_builtin = FALSE', [id]
      );
      return { success: true };
    } catch (error: any) {
      console.error('删除指标失败:', error);
      return { success: false, error: error.message };
    }
  }
}

// 单例导出
export const metricDatabaseService = new MetricDatabaseService();
