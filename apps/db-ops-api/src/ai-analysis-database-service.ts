/**
 * AI 分析数据库服务
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection.js';
import type { ActorContext } from './auth/actor-context.js';
import type { EvidenceSnapshot } from './analysis/analysis-evidence.js';
import { analysisAuthorizationVersion } from './analysis/analysis-identity.js';
import { canReadResource } from './resources/resource-service.js';
import { hasPermission } from './auth/require-permission.js';

export interface AiAnalysisRecord {
  id: number;
  analysis_type: 'topsql_analysis' | 'alert_rca' | 'fault_diagnosis' | 'capacity_prediction' | 'sql_audit';
  instance_id: number | null;
  target_type: 'instance' | 'server' | 'network_device';
  server_id: number | null;
  network_device_id: number | null;
  related_id: number | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown';
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
  instance_lifecycle_state?: 'available' | 'deleting' | 'deleted' | null;
  recovery_reason?: string | null;
  legacy_status?: string | null;
  request_state?: string | null;
  job_id?: string | null;
  attempt_number?: number;
  current_run_id?: string | null;
  request_actor_id?: number | null;
  authorization_version?: string | null;
}

export interface ActiveAiAnalysis {
  id: number;
  status: 'pending' | 'running';
  sessionKey: string | null;
}

export interface ActiveFaultDiagnosisLookup {
  instanceId: number;
  triggerType: 'manual' | 'auto';
  userId: number;
  sessionVersion: number;
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
    instance_id?: number;
    server_id?: number;
    network_device_id?: number;
    related_id?: number;
    trigger_type?: string;
    cache_key?: string;
    ttl_minutes?: number;
    session_key?: string;
    cache_ttl_minutes?: number;
  }): Promise<{ success: boolean; analysisId?: number; error?: string }> {
    const hasInstance = Number.isSafeInteger(data.instance_id) && Number(data.instance_id) > 0;
    const hasServer = Number.isSafeInteger(data.server_id) && Number(data.server_id) > 0;
    const hasNetworkDevice = Number.isSafeInteger(data.network_device_id) && Number(data.network_device_id) > 0;
    if ([hasInstance, hasServer, hasNetworkDevice].filter(Boolean).length !== 1) return { success: false, error: 'ANALYSIS_SUBJECT_INVALID' };
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      const [result] = await pool.execute(
        `INSERT INTO ai_analysis
         (analysis_type, target_type, instance_id, server_id, network_device_id, related_id, status, trigger_type, cache_key, ttl_minutes, session_key, cache_ttl_minutes)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [
          data.analysis_type,
          hasServer ? 'server' : hasNetworkDevice ? 'network_device' : 'instance',
          hasInstance ? data.instance_id : null,
          hasServer ? data.server_id : null,
          hasNetworkDevice ? data.network_device_id : null,
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
      const [result] = await pool.execute(
        `UPDATE ai_analysis SET
         status = ?,
         started_at = CASE WHEN ? = 'running' THEN NOW() ELSE started_at END
         WHERE id = ? AND status IN ('pending', 'running')
         AND NOT EXISTS (SELECT 1 FROM analysis_dispatches d WHERE d.analysis_id = ai_analysis.id)`,
        [status, status, analysisId]
      );
      return (result as any).affectedRows > 0
        ? { success: true }
        : { success: false, error: '分析不存在或已结束' };
    } catch (error: any) {
      console.error('更新分析状态失败:', error);
      return { success: false, error: error.message };
    }
  }

  async setSessionKey(analysisId: number, sessionKey: string): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;
    try {
      await pool.execute(`UPDATE ai_analysis SET session_key = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM analysis_dispatches d WHERE d.analysis_id = ai_analysis.id)`, [sessionKey, analysisId]);
    } catch (error) {
      console.error('更新 session_key 失败:', error);
    }
  }

  async findActiveFaultDiagnosis(lookup: ActiveFaultDiagnosisLookup): Promise<ActiveAiAnalysis | null> {
    const pool = this.getPool();
    if (!pool) throw new Error('ANALYSIS_ACTIVE_LOOKUP_UNAVAILABLE');
    const cacheKeyPattern = `fault:${lookup.instanceId}:%:${lookup.triggerType}`
      + `:user:${lookup.userId}:session:${lookup.sessionVersion}`;
    try {
      const [rows] = await pool.execute(
        `SELECT ai_analysis.id, ai_analysis.status, session_key AS sessionKey
         FROM ai_analysis
         JOIN analysis_dispatches d ON d.analysis_id = ai_analysis.id
         JOIN workflow_jobs j ON j.id = d.job_id
         WHERE j.state = 'running' AND j.lease_expires_at > NOW()
           AND j.lease_owner = d.owner_id AND j.fencing_token = d.fencing_token
           AND analysis_type = 'fault_diagnosis'
           AND instance_id = ?
           AND trigger_type = ?
           AND cache_key LIKE ?
           AND status IN ('pending', 'running')
         ORDER BY ai_analysis.created_at DESC, ai_analysis.id DESC LIMIT 1`,
        [lookup.instanceId, lookup.triggerType, cacheKeyPattern],
      ) as any;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const row = rows[0];
      return {
        id: Number(row.id),
        status: row.status,
        sessionKey: typeof row.sessionKey === 'string' && row.sessionKey.length > 0 ? row.sessionKey : null,
      };
    } catch (error) {
      console.error('查询活跃分析失败:', error);
      throw new Error('ANALYSIS_ACTIVE_LOOKUP_UNAVAILABLE');
    }
  }

  async markDispatched(analysisId: number, sessionKey: string): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) throw new Error('ANALYSIS_STORE_UNAVAILABLE');
    const [result] = await pool.execute(
      `UPDATE ai_analysis SET session_key = ?
       WHERE id = ? AND status IN ('pending', 'running')
         AND NOT EXISTS (SELECT 1 FROM analysis_dispatches d WHERE d.analysis_id = ai_analysis.id) AND session_key IS NULL`,
      [sessionKey, analysisId],
    ) as any;
    return Number(result.affectedRows) === 1;
  }

  /**
   * 查找最近的已完成分析（用于缓存去重）
   */
  async findRecentCompleted(cacheKey: string, ttlMs: number, versions?: { evidence: string; config: string; authorization: string }): Promise<{ analysisId?: number; result?: any } | null> {
    const pool = this.getPool();
    if (!pool || !versions || !Number.isFinite(ttlMs)) return null;
    try {
      const [rows] = await pool.query(
        `SELECT ai_analysis.id as analysisId, result FROM ai_analysis
         JOIN analysis_dispatches d ON d.analysis_id = ai_analysis.id
         WHERE cache_key = ? AND status = 'completed'
           AND d.request_state = 'completed' AND d.evidence_version = ? AND d.config_version = ? AND d.authorization_version = ?
           AND completed_at > DATE_SUB(NOW(), INTERVAL ? MICROSECOND)
         ORDER BY completed_at DESC LIMIT 1`,
        [cacheKey, versions.evidence, versions.config, versions.authorization, ttlMs * 1000]
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
      const [update] = await pool.execute(
          `UPDATE ai_analysis SET
           status = 'completed',
           result = ?,
           execution_trace = ?,
           \`usage\` = ?,
           duration_ms = ?,
           completed_at = NOW()
           WHERE id = ? AND status IN ('pending', 'running')
         AND NOT EXISTS (SELECT 1 FROM analysis_dispatches d WHERE d.analysis_id = ai_analysis.id)`,
          [
            resultValue,
            data.executionTrace ? JSON.stringify(data.executionTrace) : null,
            data.usage ? JSON.stringify(data.usage) : null,
            data.duration_ms || null,
            analysisId,
          ]
        ) as any;
      if (update.affectedRows === 0) return { success: false, error: 'ANALYSIS_ALREADY_TERMINAL' };
      return { success: true };
    } catch (error: any) {
      console.error('完成分析失败:', error);
      return { success: false, error: error.message };
    }
  }

  /** Persist new Agent output only after it satisfies the versioned envelope contract. */
  async completeAnalysisEnvelope(
    analysisId: number,
    envelope: unknown,
    data: { usage?: any; duration_ms?: number; executionTrace?: any } = {},
  ): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'ANALYSIS_EXECUTION_CONTEXT_REQUIRED' };
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
      const [update] = await pool.execute(
        `UPDATE ai_analysis SET
         status = 'failed',
         error_message = ?,
         completed_at = NOW()
         WHERE id = ? AND status IN ('pending', 'running')
         AND NOT EXISTS (SELECT 1 FROM analysis_dispatches d WHERE d.analysis_id = ai_analysis.id)`,
        [errorMessage, analysisId]
      ) as any;
      if (update.affectedRows === 0) return { success: false, error: 'ANALYSIS_ALREADY_TERMINAL' };
      return { success: true };
    } catch (error: any) {
      console.error('标记分析失败失败:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 兼容旧调用：仅把无法确认派发状态的历史超时记录标记为 unknown。
   * durable 分析由独立恢复扫描按租约与执行身份处理。
   */
  async checkAndFailStuckAnalyses(): Promise<{ failed_count: number }> {
    // Compatibility entry point; durable recovery belongs to the wired dispatcher.
    // A legacy timeout cannot prove the request was never billed.
    const pool = this.getPool();
    if (!pool) return { failed_count: 0 };
    await pool.execute(`UPDATE ai_analysis a LEFT JOIN analysis_dispatches d ON d.analysis_id = a.id
      SET a.legacy_status = a.status, a.status = 'unknown', a.recovery_reason = 'LEGACY_DISPATCH_UNCONFIRMED'
      WHERE d.analysis_id IS NULL AND a.status IN ('pending','running') AND a.created_at < NOW() - INTERVAL 10 MINUTE`);
    return { failed_count: 0 };
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
        `SELECT a.*, i.lifecycle_state AS instance_lifecycle_state, d.job_id, d.request_state, d.attempt_number, d.current_run_id, d.authorization_version,
         JSON_UNQUOTE(JSON_EXTRACT(d.request_snapshot, '$.actor.userId')) AS request_actor_id
         FROM ai_analysis a LEFT JOIN analysis_dispatches d ON d.analysis_id = a.id LEFT JOIN database_instances i ON i.id = a.instance_id WHERE a.id = ?`,
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

  /** Snapshot data is never attached to generic result/list reads. */
  async getEvidenceSnapshot(analysisId: number, actor: ActorContext): Promise<EvidenceSnapshot | null> {
    if (!Number.isSafeInteger(analysisId) || analysisId <= 0 || !hasPermission(new Set(actor.permissions), 'ai:view')) return null;
    const pool = this.getPool();
    if (!pool) return null;
    const [rows] = await pool.execute<any[]>(`SELECT d.request_snapshot FROM analysis_dispatches d
      JOIN ai_analysis a ON a.id = d.analysis_id WHERE d.analysis_id = ?`, [analysisId]);
    if (!rows[0]?.request_snapshot) return null;
    const request = typeof rows[0].request_snapshot === 'string' ? JSON.parse(rows[0].request_snapshot) : rows[0].request_snapshot;
    if (!request.evidence || Number(request.actor?.userId) !== actor.userId
      || request.authorizationVersion !== analysisAuthorizationVersion(actor)
      || !canReadResource(actor, request.subject)) return null;
    return request.evidence;
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
        SELECT ai_analysis.*, (SELECT lifecycle_state FROM database_instances WHERE id = ai_analysis.instance_id) AS instance_lifecycle_state FROM ai_analysis WHERE 1=1
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
  async findByCacheKey(cacheKey: string, versions?: { evidence: string; config: string; authorization: string }): Promise<AiAnalysisRecord | null> {
    // Historical results have no verified evidence/configuration identity. Keep
    // them readable in history but never present them as a fresh result cache.
    if (!versions) return null;
    const found = await this.findRecentCompleted(cacheKey, 1_800_000, versions);
    return found?.analysisId ? this.getAnalysisById(found.analysisId) : null;
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
      const [result] = await pool.execute(`DELETE FROM ai_analysis WHERE id = ? AND NOT (status IN ('pending','running','unknown')
        AND EXISTS (SELECT 1 FROM analysis_dispatches d WHERE d.analysis_id = ai_analysis.id))`, [analysisId]) as any;
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
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) as unknown
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
   * 轮询分析状态直到完成、失败或观察期限结束，不修改状态。
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
      if (record.status === 'failed' || record.status === 'unknown') return record;
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Observers do not own the execution deadline or mutate terminal state.
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

    if (typeof row.analysis_envelope === 'string') {
      try { row.analysis_envelope = JSON.parse(row.analysis_envelope); } catch { row.analysis_envelope = null; }
    }

    return row as AiAnalysisRecord;
  }
}

// 单例
export const aiAnalysisDatabaseService = new AiAnalysisDatabaseService();
