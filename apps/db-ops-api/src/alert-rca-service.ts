import type { ActorContext } from './auth/actor-context.js';
import { assertWorkflowActive } from './workflows/execution-context.js';
/**
 * 告警根因分析服务 (Alert Root Cause Analysis)
 * 当告警触发时，自动收集上下文数据并生成根因分析报告
 */
import { dbConnection } from './db-connection.js';
import { dispatchOrReuse } from './ai-agent-bridge.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { alertDatabaseService } from './alert-database-service.js';

const RCA_LEVELS = new Set(['warning', 'error', 'critical']);

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
    trigger: 'manual' | 'auto' = 'auto',
    actor?: ActorContext, retryOf?: number,
  ): Promise<{ success: boolean; analysisId?: number; sessionKey?: string; error?: string; status?: string }> {
    // a. 获取告警详情
    assertWorkflowActive();
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

    assertWorkflowActive();
    const result = await dispatchOrReuse({
        type: 'alert_rca', cacheKey: `alert:${alertId}:${subjectType}:${subjectId}`,
        instanceId, serverId, sessionKey: `rca-${subjectType}-${alertId}`,
        triggerType: trigger, actor, retryOf, relatedId: alertId,
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
    });
    return { success: result.success !== false, analysisId: result.analysisId,
      sessionKey: `rca-${subjectType}-${alertId}-${result.analysisId}`, status: result.status,
      ...(result.status === 'unknown' ? { error: 'ANALYSIS_PROVIDER_RESULT_UNKNOWN：重试可能再次计费，需要明确确认' } : {}),
    };
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
