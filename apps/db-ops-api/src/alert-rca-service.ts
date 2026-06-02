/**
 * 告警根因分析服务 (Alert Root Cause Analysis)
 * 当告警触发时，自动收集上下文数据并生成根因分析报告
 */
import { dbConnection } from './db-connection.js';
import { llmService, ChatMessage } from './llm-service.js';
import { dispatchOrReuse } from './ai-agent-bridge.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { alertDatabaseService } from './alert-database-service.js';
import { metricsDatabaseService } from './metrics-database-service.js';
import { databaseService } from './database-service.js';

const RCA_LEVELS = new Set(['warning', 'error', 'critical']);

// In-memory lock to prevent concurrent duplicate analyses
const pendingAnalyses = new Set<string>();

interface AlertDetails {
  id: number;
  instance_id: number | null;
  alert_type: string;
  level: string;
  title: string;
  message: string;
  metric_name: string | null;
  metric_value: string | null;
  threshold_value: string | null;
  created_at: Date;
  instance_name?: string;
}

class AlertRCAService {
  /**
   * 分析单个告警的根因
   * @param alertId 告警 ID
   * @param trigger 触发类型：manual 或 auto
   * @returns analysisId
   */
  async analyzeAlert(
    alertId: number,
    trigger: 'manual' | 'auto' = 'auto'
  ): Promise<{ success: boolean; analysisId?: number; sessionKey?: string; error?: string; status?: string }> {
    // a. 获取告警详情
    const alert = await this._getAlertById(alertId);
    if (!alert) {
      return { success: false, error: `告警 ${alertId} 不存在` };
    }

    // b. 验证告警级别
    if (!this.shouldTriggerRCA(alert.level)) {
      return { success: false, error: `告警级别 ${alert.level} 不触发 RCA（仅 warning/error/critical）` };
    }

    // c. 验证 instance_id
    if (!alert.instance_id) {
      return { success: false, error: '告警无关联实例，无法分析' };
    }
    const instanceId = alert.instance_id;

    // d. Build cache key and in-memory lock: prevent concurrent duplicate analyses
    const cacheKey = `alert:${alertId}:${instanceId}`;
    if (pendingAnalyses.has(cacheKey)) {
      return { success: false, error: '分析正在创建中，请稍后重试' };
    }
    // Acquire lock atomically before any await to prevent race condition
    pendingAnalyses.add(cacheKey);
    let lockReleased = false;
    const releaseLock = () => {
      if (!lockReleased) {
        pendingAnalyses.delete(cacheKey);
        lockReleased = true;
      }
    };

    try {
      // e. 去重检查：15 分钟内相同 alert+instance 的分析
      const existing = await aiAnalysisDatabaseService.getAnalysisList({
        analysis_type: 'alert_rca',
        status: 'running',
        cache_key: cacheKey,
        limit: 1,
      });
      const recentRunning = existing.length > 0
        && existing[0].created_at
        && (Date.now() - existing[0].created_at.getTime()) < 15 * 60 * 1000
        ? existing[0] : null;
      if (recentRunning) {
        releaseLock();
        return { success: true, analysisId: recentRunning.id, sessionKey: (recentRunning as any).session_key };
      }

      const completedCache = await aiAnalysisDatabaseService.getAnalysisList({
        analysis_type: 'alert_rca',
        status: 'completed',
        cache_key: cacheKey,
        limit: 1,
      });
      const recentCompleted = completedCache.length > 0
        && completedCache[0].created_at
        && (Date.now() - completedCache[0].created_at.getTime()) < 15 * 60 * 1000
        ? completedCache[0] : null;
      if (recentCompleted) {
        releaseLock();
        return { success: true, analysisId: recentCompleted.id, sessionKey: (recentCompleted as any).session_key };
      }

      // f. 创建分析记录 (lock held)
      const createResult = await aiAnalysisDatabaseService.createAnalysis({
        analysis_type: 'alert_rca',
        instance_id: instanceId,
        related_id: alertId,
        trigger_type: trigger,
        cache_key: cacheKey,
      });
      if (!createResult.success) {
        releaseLock();
        return { success: false, error: createResult.error };
      }
      const analysisId = createResult.analysisId!;
      const sessionKey = `rca-${alertId}-${analysisId}`;

      // f2. 回填 session_key
      await aiAnalysisDatabaseService.setSessionKey(analysisId, sessionKey);

      // g. 更新状态为 running
      await aiAnalysisDatabaseService.updateStatus(analysisId, 'running');

      // h. 通过 Agent 执行分析（await 确保 session 先创建）
      await dispatchOrReuse({
        type: 'alert_rca',
        cacheKey: `rca:${alertId}:${instanceId}`,
        instanceId,
        sessionKey,
        triggerType: trigger,
        existingAnalysisId: analysisId,
        userMessage: `对告警 ${alertId} 进行根因分析。

告警详情：
- 标题：${alert.title || '未知'}
- 级别：${alert.level || 'N/A'}
- 类型：${alert.alert_type || 'N/A'}
- 实例ID：${instanceId}
- 描述：${alert.message || '无'}
${alert.metric_name ? `- 指标：${alert.metric_name} = ${alert.metric_value ?? '?'}（阈值: ${alert.threshold_value ?? '?'}）` : ''}
- 发生时间：${alert.created_at instanceof Date ? alert.created_at.toISOString() : String(alert.created_at)}

请使用 db_* 工具采集当前数据库指标、历史趋势、慢查询、活跃会话、锁等待和错误日志。分析根因并给出修复建议。完成后调用 slide_complete_analysis 保存结果。`,
      }).catch((err) => {
        console.error(`[RCA] Agent 分析 ${analysisId} 失败:`, err);
        aiAnalysisDatabaseService.failAnalysis(analysisId, err.message).catch(() => {});
      });

      // Release lock immediately after starting background analysis
      releaseLock();

      return { success: true, analysisId, sessionKey, status: 'queued' };
    } catch (err) {
      releaseLock();
      throw err;
    }
  }

  /**
   * 执行实际的数据收集和 LLM 分析
   */
  /** @deprecated Replaced by dispatchOrReuse Agent path */
  private async _executeAnalysis(
    analysisId: number,
    alert: AlertDetails,
    instanceId: number
  ): Promise<void> {
    // g. 收集上下文数据（每项独立 try/catch）
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const now = new Date();

    // 指标趋势
    let metricsText = '无指标数据';
    try {
      const metrics = await metricsDatabaseService.getHistoricalMetrics(instanceId, fiveMinAgo, now);
      const limited = metrics.slice(-20);
      metricsText = this._formatMetricsTrend(limited);
    } catch (err: any) {
      console.warn('[RCA] 获取指标趋势失败:', err.message);
    }

    // 活跃会话
    let sessionsText = '无会话数据';
    try {
      const sessions = await databaseService.getActiveSessions(instanceId);
      const top5 = (sessions || []).slice(0, 5);
      sessionsText = this._formatSessions(top5);
    } catch (err: any) {
      console.warn('[RCA] 获取活跃会话失败:', err.message);
    }

    // 慢查询
    let slowQueriesText = '无慢查询数据';
    try {
      const slowQueries = await metricsDatabaseService.getSlowQueries(instanceId, 10);
      slowQueriesText = this._formatSlowQueries(slowQueries);
    } catch (err: any) {
      console.warn('[RCA] 获取慢查询失败:', err.message);
    }

    // 锁等待
    let lockWaitText = '锁等待信息不可用';
    try {
      const conn = databaseService.getConnection(instanceId);
      if (conn) {
        lockWaitText = await this._getLockWaitInfo(conn);
      }
    } catch (err: any) {
      console.warn('[RCA] 获取锁等待信息失败:', err.message);
    }

    // 最近告警
    let recentAlertsText = '无最近告警';
    try {
      const recentAlerts = await alertDatabaseService.getAlerts({ instance_id: instanceId, limit: 5 });
      recentAlertsText = this._formatRecentAlerts(recentAlerts);
    } catch (err: any) {
      console.warn('[RCA] 获取最近告警失败:', err.message);
    }

    // h. 构建 prompt
    const prompt = this.buildRCAPrompt(
      alert,
      [metricsText],
      [sessionsText],
      [slowQueriesText],
      [lockWaitText],
      [recentAlertsText],
      []
    );

    const systemPrompt = `你是一位资深数据库运维专家，专门进行告警根因分析。请用中文回复。
请以结构化的 JSON 格式返回分析结果，包含以下字段：
- alert_overview: 告警概述（对象: {alert_id, alert_title, alert_level, metric_name, metric_value, timestamp}）
- root_causes: 根因分析（数组，按可能性排序，每项包含 {cause, confidence, explanation}）
- evidence: 相关证据（数组，支撑分析的具体数据）
- recommended_actions: 建议操作（数组，逐步修复指引，每项包含 {step, action, estimated_impact}）
- related_alerts: 是否有其他告警由同一根因引起（数组）
- summary: 简要总结（字符串）

只返回 JSON，不要添加其他文本。`;

    // i. 调用 LLM
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const llmResult = await llmService.chatWithTracking(messages, {
      system: systemPrompt,
      purpose: 'alert_rca',
      sessionId: `rca-${analysisId}`,
      instanceId,
      maxTokens: 8192,
    });

    // j. Store result with JSON validation
    if (llmResult.success) {
      const validatedResult = parseLlmOutput(llmResult.content);
      await aiAnalysisDatabaseService.completeAnalysis(analysisId, {
        result: validatedResult,
        usage: llmResult.usage,
        duration_ms: llmResult.duration_ms,
      });
      console.log(`[RCA] 分析 ${analysisId} 完成，耗时 ${llmResult.duration_ms}ms`);
    } else {
      await aiAnalysisDatabaseService.failAnalysis(analysisId, llmResult.error || 'LLM 调用失败');
      console.error(`[RCA] 分析 ${analysisId} 失败:`, llmResult.error);
    }
  }

  /**
   * 为实例的所有未处理告警触发 RCA
   */
  async analyzeAlertsForInstance(instanceId: number): Promise<number[]> {
    const alerts = await alertDatabaseService.getAlerts({
      instance_id: instanceId,
      status: 'unread',
      limit: 50,
    });

    const analysisIds: number[] = [];
    for (const alert of alerts) {
      const level = alert.severity || alert.level || 'info';
      if (!this.shouldTriggerRCA(level)) continue;

      const alertId = alert.id;
      const result = await this.analyzeAlert(alertId, 'auto');
      if (result.success && result.analysisId) {
        analysisIds.push(result.analysisId);
      }
    }

    return analysisIds;
  }

  /**
   * 判断是否应该触发 RCA
   */
  shouldTriggerRCA(alertLevel: string): boolean {
    return RCA_LEVELS.has(alertLevel.toLowerCase());
  }

  /**
   * 获取 RCA 历史记录
   */
  async getRCAHistory(alertId: number, limit: number = 10): Promise<any[]> {
    return aiAnalysisDatabaseService.getAnalysisList({
      analysis_type: 'alert_rca',
      related_id: alertId,
      limit,
    });
  }

  /**
   * 获取 RCA 服务状态统计
   */
  async getStatus(): Promise<any> {
    return aiAnalysisDatabaseService.getAnalysisStats('alert_rca');
  }

  // ==================== 私有方法 ====================

  /**
   * 通过直接 SQL 获取告警详情
   */
  private async _getAlertById(alertId: number): Promise<AlertDetails | null> {
    const pool = dbConnection.getPool();
    if (!pool) return null;

    try {
      const [rows] = await pool.execute(
        `SELECT id, instance_id, alert_type, level, title, message,
                metric_name, metric_value, threshold_value, created_at
         FROM alerts WHERE id = ?`,
        [alertId]
      ) as any;

      if (!Array.isArray(rows) || rows.length === 0) return null;
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
        created_at: row.created_at,
      };
    } catch (error) {
      console.error('获取告警详情失败:', error);
      return null;
    }
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 格式化指标趋势为文本
   */
  private _formatMetricsTrend(metrics: any[]): string {
    if (!metrics || metrics.length === 0) return '无指标数据';

    const cpuValues = metrics.map((m) => m.cpu_usage ?? 0);
    const memValues = metrics.map((m) => m.memory_usage ?? 0);
    const connValues = metrics.map((m) => m.connections ?? 0);
    const qpsValues = metrics.map((m) => m.qps ?? 0);

    const formatTrend = (values: number[], label: string, unit: string): string => {
      if (values.length === 0) return `${label}: 无数据`;
      const first = values[0].toFixed(1);
      const last = values[values.length - 1].toFixed(1);
      const avg = (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
      const max = Math.max(...values).toFixed(1);
      return `${label}: ${first}${unit} → ${last}${unit} (均值: ${avg}${unit}, 峰值: ${max}${unit})`;
    };

    return [
      formatTrend(cpuValues, 'CPU', '%'),
      formatTrend(memValues, '内存', '%'),
      formatTrend(connValues, '连接数', ''),
      formatTrend(qpsValues, 'QPS', ''),
    ].join('\n');
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 格式化活跃会话为文本
   */
  private _formatSessions(sessions: any[]): string {
    if (!sessions || sessions.length === 0) return '无活跃会话';

    const lines = sessions.slice(0, 5).map((s, i) => {
      const cmd = s.command || 'Unknown';
      const state = s.state || 'Unknown';
      const time = s.time || 0;
      const info = s.info || '';
      const host = s.host || '';
      return `  ${i + 1}. [${cmd}] ${state} (${time}s) ${host} ${info ? '- ' + info.substring(0, 80) : ''}`;
    });

    return `${sessions.length} 个活跃会话:\n${lines.join('\n')}`;
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 格式化慢查询为文本
   */
  private _formatSlowQueries(queries: any[]): string {
    if (!queries || queries.length === 0) return '无慢查询数据';

    const lines = queries.slice(0, 10).map((q, i) => {
      const avgTime = (q.avg_time_ms || 0).toFixed(0);
      const maxTime = (q.max_time_ms || 0).toFixed(0);
      const count = q.execution_count || 0;
      const sql = q.sql_text ? q.sql_text.substring(0, 100) : '';
      return `  ${i + 1}. 平均: ${avgTime}ms, 最大: ${maxTime}ms, 执行: ${count}次 | ${sql}`;
    });

    return `Top ${Math.min(queries.length, 10)} 慢查询:\n${lines.join('\n')}`;
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 获取锁等待信息
   */
  private async _getLockWaitInfo(conn: any): Promise<string> {
    try {
      const [rows] = await conn.execute(`
        SELECT
          r.trx_id AS waiting_trx_id,
          r.trx_mysql_thread_id AS waiting_thread,
          r.trx_query AS waiting_query,
          b.trx_id AS blocking_trx_id,
          b.trx_mysql_thread_id AS blocking_thread,
          b.trx_query AS blocking_query
        FROM information_schema.innodb_lock_waits w
        INNER JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id
        INNER JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id
      `) as any;

      if (!Array.isArray(rows) || rows.length === 0) {
        return '当前无锁等待';
      }

      const lines = rows.slice(0, 5).map((r: any, i: number) => {
        return `  ${i + 1}. 等待线程 ${r.waiting_thread} 被线程 ${r.blocking_thread} 阻塞`;
      });

      return `发现 ${rows.length} 个锁等待:\n${lines.join('\n')}`;
    } catch {
      return '锁等待信息不可用';
    }
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 格式化最近告警为文本
   */
  private _formatRecentAlerts(alerts: any[]): string {
    if (!alerts || alerts.length === 0) return '无最近告警';

    const lines = alerts.slice(0, 5).map((a, i) => {
      const level = a.level || a.severity || 'unknown';
      const title = a.title || 'Unknown';
      const time = a.created_at
        ? new Date(a.created_at).toLocaleString('zh-CN')
        : '';
      return `  ${i + 1}. [${level.toUpperCase()}] ${title} (${time})`;
    });

    return `最近 ${alerts.length} 条告警:\n${lines.join('\n')}`;
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 构建 RCA Prompt
   */
  buildRCAPrompt(
    alert: AlertDetails,
    metricsText: string[],
    sessionsText: string[],
    slowQueriesText: string[],
    lockWaitText: string[],
    recentAlertsText: string[],
    _schemaChangesText: string[]
  ): string {
    const lines = [
      '## 告警概述',
      `- 告警ID: ${alert.id}`,
      `- 标题: ${alert.title}`,
      `- 级别: ${alert.level}`,
      `- 类型: ${alert.alert_type}`,
      `- 指标: ${alert.metric_name || 'N/A'} = ${alert.metric_value || 'N/A'} (阈值: ${alert.threshold_value || 'N/A'})`,
      `- 时间: ${alert.created_at instanceof Date ? alert.created_at.toISOString() : String(alert.created_at)}`,
      '',
      '## 最近 5 分钟指标趋势',
      metricsText.join('\n'),
      '',
      '## 活跃会话 (Top 5)',
      sessionsText.join('\n'),
      '',
      '## 慢查询 (Top 10)',
      slowQueriesText.join('\n'),
      '',
      '## 锁等待信息',
      lockWaitText.join('\n'),
      '',
      '## 最近告警 (同实例)',
      recentAlertsText.join('\n'),
      '',
      '请分析以上数据，找出导致该告警的根本原因。',
    ];

    return lines.join('\n');
  }
}

/**
 * @deprecated Replaced by dispatchOrReuse Agent path
 * Parse LLM output, extracting JSON from potential markdown wrapping
 */
function parseLlmOutput(content: string): any {
  // Extract JSON from potential markdown wrapping
  const jsonMatch = content.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (jsonMatch) {
    content = jsonMatch[1].trim();
  }
  try {
    return JSON.parse(content);
  } catch {
    // Store as raw text with a warning flag
    return { raw: content, parse_error: true };
  }
}

// 单例
export const alertRCAService = new AlertRCAService();
export { AlertRCAService };
