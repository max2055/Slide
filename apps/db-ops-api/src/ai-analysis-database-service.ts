/**
 * AI 分析数据库服务
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection.js';

export interface AiAnalysisRecord {
  id: number;
  analysis_type: 'topsql_analysis' | 'alert_rca' | 'fault_diagnosis' | 'capacity_prediction' | 'sql_audit';
  instance_id: number;
  related_id: number | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  trigger_type: 'manual' | 'auto';
  cache_key: string | null;
  result: any;
  error_message: string | null;
  usage: any;
  duration_ms: number | null;
  ttl_minutes: number;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

class AiAnalysisDatabaseService {
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
   * 创建 AI 分析记录
   */
  async createAnalysis(data: {
    analysis_type: string;
    instance_id: number;
    related_id?: number;
    trigger_type?: string;
    cache_key?: string;
    ttl_minutes?: number;
    session_key?: string;
    cache_ttl_minutes?: number;
  }): Promise<{ success: boolean; analysisId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute(
        `INSERT INTO ai_analysis
         (analysis_type, instance_id, related_id, status, trigger_type, cache_key, ttl_minutes, session_key, cache_ttl_minutes)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [
          data.analysis_type,
          data.instance_id,
          data.related_id || null,
          data.trigger_type || 'manual',
          data.cache_key || null,
          data.ttl_minutes || 1440,
          data.session_key || null,
          data.cache_ttl_minutes || null,
        ]
      ) as any;

      return { success: true, analysisId: result.insertId };
    } catch (error: any) {
      console.error('创建 AI 分析记录失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新分析状态
   */
  async updateStatus(
    analysisId: number,
    status: 'pending' | 'running' | 'completed' | 'failed'
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        `UPDATE ai_analysis SET
         status = ?,
         started_at = CASE WHEN ? = 'running' THEN NOW() ELSE started_at END
         WHERE id = ?`,
        [status, status, analysisId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('更新分析状态失败:', error);
      return { success: false, error: error.message };
    }
  }

  async setSessionKey(analysisId: number, sessionKey: string): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;
    try {
      await pool.execute(`UPDATE ai_analysis SET session_key = ? WHERE id = ?`, [sessionKey, analysisId]);
    } catch (error) {
      console.error('更新 session_key 失败:', error);
    }
  }

  /**
   * 查找最近的已完成分析（用于缓存去重）
   */
  async findRecentCompleted(cacheKey: string, ttlMs: number): Promise<{ analysisId?: number; result?: any } | null> {
    const pool = this.getPool();
    if (!pool) return null;
    try {
      const [rows] = await pool.query(
        `SELECT id as analysisId, result FROM ai_analysis
         WHERE cache_key = ? AND status = 'completed'
           AND completed_at > DATE_SUB(NOW(), INTERVAL ? MICROSECOND)
         ORDER BY completed_at DESC LIMIT 1`,
        [cacheKey, ttlMs * 1000]
      ) as any;
      if (!rows.length) return null;
      const r = rows[0];
      return {
        analysisId: r.analysisId,
        result: typeof r.result === 'string' ? JSON.parse(r.result) : r.result,
      };
    } catch {
      return null;
    }
  }

  /**
   * 完成分析，存储结果
   */
  async completeAnalysis(
    analysisId: number,
    data: { result: any; usage?: any; duration_ms?: number; executionTrace?: any }
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // Store strings as JSON (column type is JSON), JSON-encode objects
      const resultValue = JSON.stringify(data.result);
      try {
        await pool.execute(
          `UPDATE ai_analysis SET
           status = 'completed',
           result = ?,
           execution_trace = ?,
           \`usage\` = ?,
           duration_ms = ?,
           completed_at = NOW()
           WHERE id = ?`,
          [
            resultValue,
            data.executionTrace ? JSON.stringify(data.executionTrace) : null,
            data.usage ? JSON.stringify(data.usage) : null,
            data.duration_ms || null,
            analysisId,
          ]
        );
      } catch (err: any) {
        // If execution_trace column doesn't exist yet (migration pending), retry without it
        if (err?.message?.includes?.(`Unknown column 'execution_trace'`)) {
          await pool.execute(
            `UPDATE ai_analysis SET
             status = 'completed',
             result = ?,
             \`usage\` = ?,
             duration_ms = ?,
             completed_at = NOW()
             WHERE id = ?`,
            [resultValue, data.usage ? JSON.stringify(data.usage) : null, data.duration_ms || null, analysisId]
          );
        } else {
          throw err;
        }
      }
      return { success: true };
    } catch (error: any) {
      console.error('完成分析失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 标记分析失败
   */
  async failAnalysis(
    analysisId: number,
    errorMessage: string
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      await pool.execute(
        `UPDATE ai_analysis SET
         status = 'failed',
         error_message = ?,
         completed_at = NOW()
         WHERE id = ?`,
        [errorMessage, analysisId]
      );
      return { success: true };
    } catch (error: any) {
      console.error('标记分析失败失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 自动检测并标记超时的分析记录
   * 检查超过 10 分钟仍处于 running 状态的分析，将其标记为 failed
   */
  async checkAndFailStuckAnalyses(): Promise<{ failed_count: number }> {
    const pool = this.getPool();
    if (!pool) {
      return { failed_count: 0 };
    }

    try {
      const [rows] = await pool.query(
        `SELECT id FROM ai_analysis WHERE status = 'running' AND started_at IS NOT NULL AND started_at < NOW() - INTERVAL 10 MINUTE`
      ) as any;

      if (!Array.isArray(rows) || rows.length === 0) {
        return { failed_count: 0 };
      }

      let failedCount = 0;
      for (const row of rows) {
        await this.failAnalysis(row.id, '诊断超时：Agent 在 10 分钟内未完成');
        failedCount++;
      }

      return { failed_count: failedCount };
    } catch (error: any) {
      console.error('检测超时分析记录失败:', error);
      return { failed_count: 0 };
    }
  }

  /**
   * 根据 ID 获取分析记录
   */
  async getAnalysisById(analysisId: number): Promise<AiAnalysisRecord | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT * FROM ai_analysis WHERE id = ?',
        [analysisId]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        return this._parseRow(row);
      }
      return null;
    } catch (error) {
      console.error('获取分析记录失败:', error);
      return null;
    }
  }

  /**
   * 获取分析列表（支持过滤和分页）
   */
  async getAnalysisList(options?: {
    analysis_type?: string;
    instance_id?: number;
    status?: string;
    related_id?: number;
    cache_key?: string;
    limit?: number;
    offset?: number;
  }): Promise<AiAnalysisRecord[]> {
    const pool = this.getPool();
    if (!pool) {
      return [];
    }

    try {
      let sql = `
        SELECT * FROM ai_analysis WHERE 1=1
      `;
      const params: any[] = [];

      if (options?.analysis_type) {
        sql += ' AND analysis_type = ?';
        params.push(options.analysis_type);
      }
      if (options?.instance_id !== undefined) {
        sql += ' AND instance_id = ?';
        params.push(options.instance_id);
      }
      if (options?.status) {
        sql += ' AND status = ?';
        params.push(options.status);
      }
      if (options?.related_id !== undefined) {
        sql += ' AND related_id = ?';
        params.push(options.related_id);
      }
      if (options?.cache_key) {
        sql += ' AND cache_key = ?';
        params.push(options.cache_key);
      }

      sql += ' ORDER BY created_at DESC';

      if (options?.limit !== undefined) {
        sql += ` LIMIT ${Math.floor(options.limit)}`;
      }
      if (options?.offset !== undefined) {
        sql += ` OFFSET ${Math.floor(options.offset)}`;
      }

      const [rows] = await pool.execute(sql, params) as any;
      return rows.map((row: any) => this._parseRow(row));
    } catch (error) {
      console.error('获取分析列表失败:', error);
      return [];
    }
  }

  /**
   * 根据缓存键查找已完成的分析记录（TTL 内）
   */
  async findByCacheKey(cacheKey: string): Promise<AiAnalysisRecord | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = await pool.execute(
        `SELECT * FROM ai_analysis
         WHERE cache_key = ?
         AND status = 'completed'
         AND created_at > DATE_SUB(NOW(), INTERVAL ttl_minutes MINUTE)
         ORDER BY created_at DESC
         LIMIT 1`,
        [cacheKey]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return this._parseRow(rows[0]);
      }
      return null;
    } catch (error) {
      console.error('查找缓存分析记录失败:', error);
      return null;
    }
  }

  /**
   * 删除分析记录
   */
  async deleteAnalysis(analysisId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute('DELETE FROM ai_analysis WHERE id = ?', [analysisId]) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '分析记录不存在' };
      }
      return { success: true };
    } catch (error: any) {
      console.error('删除分析记录失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取分析状态统计
   */
  async getAnalysisStats(analysisType?: string): Promise<any> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      let sql = `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM ai_analysis
      `;
      const params: any[] = [];

      if (analysisType) {
        sql += ' WHERE analysis_type = ?';
        params.push(analysisType);
      }

      const [rows] = await pool.execute(sql, params) as any;
      return rows[0];
    } catch (error) {
      console.error('获取 AI 分析统计失败:', error);
      return null;
    }
  }

  /**
   * 轮询分析状态直到完成或失败，超时自动标记失败。
   * 用于捕获 Agent 未调用 slide_complete_analysis 的情况。
   */
  async waitForCompletion(
    analysisId: number,
    timeoutMs: number = 120_000
  ): Promise<AiAnalysisRecord | null> {
    const pollInterval = 2000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const record = await this.getAnalysisById(analysisId);
      if (!record) return null;
      if (record.status === 'completed') return record;
      if (record.status === 'failed') return record;
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout: auto-fail
    await this.failAnalysis(analysisId, '分析超时：Agent 未在规定时间内完成');
    return this.getAnalysisById(analysisId);
  }

  /**
   * 解析行数据，处理 JSON 字段
   */
  private _parseRow(row: any): AiAnalysisRecord {
    // result: stored as JSON string (old format) or raw string (new format)
    if (typeof row.result === 'string') {
      try {
        row.result = JSON.parse(row.result);
      } catch {
        // Not JSON — store as-is (raw Markdown string)
      }
    }

    try {
      if (typeof row.usage === 'string') {
        row.usage = JSON.parse(row.usage);
      }
    } catch {
      row.usage = null;
    }

    return row as AiAnalysisRecord;
  }
}

// 单例
export const aiAnalysisDatabaseService = new AiAnalysisDatabaseService();
