/**
 * 告警根因分析服务 (Alert Root Cause Analysis)
 * 当告警触发时，自动收集上下文数据并生成根因分析报告
 */
import { dbConnection } from './db-connection.js';
import { dispatchOrReuse } from './ai-agent-bridge.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { alertDatabaseService } from './alert-database-service.js';

const RCA_LEVELS = new Set(['warning', 'error', 'critical']);

// In-memory lock to prevent concurrent duplicate analyses
const pendingAnalyses = new Set<string>();

interface AlertDetails {
  id: number;
  instance_id: number | null;
  server_id: number | null;
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

    // c. An RCA subject is exactly one managed resource.
    const instanceId = alert.instance_id ?? undefined;
    const serverId = alert.server_id ?? undefined;
    if ((instanceId ? 1 : 0) + (serverId ? 1 : 0) !== 1) {
      return { success: false, error: '告警无有效资源主体，无法分析' };
    }
    const subjectType = serverId ? 'server' : 'instance';
    const subjectId = serverId ?? instanceId!;

    // d. Build cache key and in-memory lock: prevent concurrent duplicate analyses
    const cacheKey = `alert:${alertId}:${subjectType}:${subjectId}`;
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
        server_id: serverId,
        related_id: alertId,
        trigger_type: trigger,
        cache_key: cacheKey,
      });
      if (!createResult.success) {
        releaseLock();
        return { success: false, error: createResult.error };
      }
      const analysisId = createResult.analysisId!;
      const sessionKey = `rca-${subjectType}-${alertId}-${analysisId}`;

      // f2. 回填 session_key
      await aiAnalysisDatabaseService.setSessionKey(analysisId, sessionKey);

      // g. 更新状态为 running
      await aiAnalysisDatabaseService.updateStatus(analysisId, 'running');

      // h. 通过 Agent 执行分析（await 确保 session 先创建）
      await dispatchOrReuse({
        type: 'alert_rca',
        cacheKey: `rca:${alertId}:${subjectType}:${subjectId}`,
        instanceId,
        serverId,
        sessionKey,
        triggerType: trigger,
        existingAnalysisId: analysisId,
        userMessage: `对告警 ${alertId} 进行根因分析。

告警详情：
- 标题：${alert.title || '未知'}
- 级别：${alert.level || 'N/A'}
- 类型：${alert.alert_type || 'N/A'}
- 资源主体：${subjectType} #${subjectId}
- 描述：${alert.message || '无'}
${alert.metric_name ? `- 指标：${alert.metric_name} = ${alert.metric_value ?? '?'}（阈值: ${alert.threshold_value ?? '?'}）` : ''}
- 发生时间：${alert.created_at instanceof Date ? alert.created_at.toISOString() : String(alert.created_at)}

请基于以上已持久化的告警事实分析根因、明确证据边界并给出修复建议。当前后台分析仅提供 slide_complete_analysis 工具；不要调用其他工具。完成后必须调用该工具保存结果。`,
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
        `SELECT id, instance_id, server_id, alert_type, level, title, message,
                metric_name, metric_value, threshold_value, created_at
         FROM alerts WHERE id = ?`,
        [alertId]
      ) as any;

      if (!Array.isArray(rows) || rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id,
        instance_id: row.instance_id,
        server_id: row.server_id,
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

}

// 单例
export const alertRCAService = new AlertRCAService();
export { AlertRCAService };
