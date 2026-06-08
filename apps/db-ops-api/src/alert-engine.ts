/**
 * 告警引擎服务
 * 集成维护窗口、静默期检查的告警评估和创建。
 */
import { CronJob } from 'cron';
import { alertDatabaseService } from './alert-database-service';
import { instanceDatabaseService } from './instance-database-service';
import { metricsDatabaseService } from './metrics-database-service';
import { evaluateRule, evaluateRuleWithLevels, checkDuration, checkRecoveryDuration, evaluateAllRules, getMetricValue, isValueHealthy, resolveMacrosForRule } from './alert-evaluator';
import { maintenanceWindowService } from './maintenance-window-service';
import { alertSilenceService } from './alert-silence-service';
import { eventAggregator } from './event-aggregator';
import { alertEventService } from './alert-event-service';
import { dbConnection } from './db-connection';

interface AlertEngineStatus {
  running: boolean;
  lastRun: Date | null;
  nextRun: Date | null;
  evaluatedCount: number;
  triggeredCount: number;
  skippedByMaintenance: number;
  skippedBySilence: number;
}

class AlertEngine {
  private evaluationJob: CronJob | null = null;
  private running = false;
  private lastRun: Date | null = null;
  private nextRun: Date | null = null;
  private evaluatedCount = 0;
  private triggeredCount = 0;
  private skippedByMaintenance = 0;
  private skippedBySilence = 0;

  /**
   * 启动评估循环
   */
  startEvaluationLoop(): void {
    if (this.running) {
      console.log('⚠️ 告警引擎已在运行中');
      return;
    }

    try {
      // 每 60 秒评估一次
      this.evaluationJob = new CronJob(
        '0 * * * * *', // 每分钟第 0 秒
        async () => {
          try {
            await this.evaluateAndCreateAlerts();
            this.lastRun = new Date();
          } catch (error) {
            console.error('告警评估失败:', error);
          }
        },
        null,
        true,
        'Asia/Shanghai'
      );

      this.running = true;
      console.log('✅ 告警评估任务已启动（每 60 秒）');

      // 启动时补录：将历史积累的、所有成员告警已恢复的事件自动 resolve
      alertEventService.retroactiveResolve().then(result => {
        if (result.resolved > 0) {
          console.log(`🧹 启动补录完成：${result.resolved} 个历史事件已自动解决`);
        }
      }).catch(err => {
        console.warn('启动补录失败:', err);
      });
    } catch (error) {
      console.error('启动告警引擎失败:', error);
      this.running = false;
    }
  }

  /**
   * 停止评估循环
   */
  stopEvaluationLoop(): void {
    if (this.evaluationJob) {
      this.evaluationJob.stop();
      this.evaluationJob = null;
      this.running = false;
      console.log('🛑 告警评估任务已停止');
    }
  }

  /**
   * 评估并创建告警
   */
  async evaluateAndCreateAlerts(): Promise<{ evaluated: number; triggered: number }> {
    this.evaluatedCount++;
    const triggeredAlerts = await evaluateAllRules();

    // 更新统计
    this.triggeredCount += triggeredAlerts.length;

    // 为每个触发的告警创建记录（检查维护窗口和静默期）
    for (const alert of triggeredAlerts) {
      try {
        await this.createAlertFromRule(alert);
      } catch (error) {
        console.error('创建告警记录失败:', error);
      }
    }

    // 事件聚合：将同一实例同一时间段的同类告警聚合为事件
    try {
      const aggregationResult = await eventAggregator.aggregate();
      if (aggregationResult.eventsCreated > 0) {
        console.log(`📦 事件聚合: 创建 ${aggregationResult.eventsCreated} 个事件, 聚合 ${aggregationResult.alertsAggregated} 条告警`);
      }
    } catch (error) {
      console.error('事件聚合失败:', error);
    }

    // 自动恢复：检查所有活跃告警的指标是否已恢复到健康范围，是则自动解决
    try {
      const activeAlerts = await alertDatabaseService.getActiveAlerts();
      for (const alert of activeAlerts) {
        try {
          if (!alert.instance_id || !alert.metric_name) continue;

          // 特殊处理：可用性告警（rule_id=0），实例恢复可达且指标新鲜才恢复
          const ruleId = alert.tags?.rule_id;
          if (ruleId === 0 || alert.metric_name === '_availability') {
            const metrics = await metricsDatabaseService.getRealtimeMetrics(alert.instance_id);
            const isFresh = metrics && metrics.recorded_at &&
              (Date.now() - new Date(metrics.recorded_at).getTime()) <= 5 * 60 * 1000;
            if (isFresh) {
              await alertDatabaseService.resolveAlert(alert.id);
              console.log(`[AlertEngine] Auto-resolved availability alert #${alert.id} (instance reachable again)`);
              await alertEventService.autoResolveByAlert(alert.id).catch(err =>
                console.warn(`[AlertEngine] Event auto-resolve check failed for alert #${alert.id}:`, err)
              );
            }
            continue;
          }

          if (!ruleId) continue;

          const rule = await alertDatabaseService.getRuleById(ruleId);
          if (!rule) continue;

          // 使用与触发对称的持续时间检查：需要持续健康才恢复
          // 并加载该规则的 macros（包括模板和实例覆盖）
          const duration = (rule.duration_seconds as number) || 60;
          const macros = await resolveMacrosForRule(rule, alert.instance_id);
          const recovered = await checkRecoveryDuration(alert.instance_id, rule, duration, macros);
          if (recovered) {
            await alertDatabaseService.resolveAlert(alert.id);
            console.log(`[AlertEngine] Auto-resolved alert #${alert.id} (${alert.metric_name} recovered for ${duration}s)`);
            // 联动事件：如果此告警所属事件的所有成员都已恢复，则自动 resolve 事件
            await alertEventService.autoResolveByAlert(alert.id).catch(err =>
              console.warn(`[AlertEngine] Event auto-resolve check failed for alert #${alert.id}:`, err)
            );
          }
        } catch (err) {
          console.warn(`[AlertEngine] Recovery check failed for alert #${alert.id}:`, err);
        }
      }
    } catch (error) {
      console.warn('[AlertEngine] Auto-recovery loop failed:', error);
    }

    return {
      evaluated: this.evaluatedCount,
      triggered: triggeredAlerts.length,
    };
  }

  /**
   * 根据规则创建告警
   */
  private async createAlertFromRule(alertData: {
    rule: any;
    instanceId: number;
    instanceName: string;
    currentValue: number;
    thresholdUsed?: number;
    triggeredLevel?: 'warning' | 'error' | 'critical';
  }): Promise<void> {
    const { rule, instanceId, instanceName, currentValue, thresholdUsed, triggeredLevel } = alertData;

    // 1. 检查维护窗口
    const mwCheck = await maintenanceWindowService.isActiveMaintenanceWindow(instanceId);
    if (mwCheck.active && mwCheck.window?.suppress_evaluation) {
      console.log(`🔇 维护窗口跳过评估: ${rule.name} on instance ${instanceName} (${mwCheck.window.name})`);
      this.skippedByMaintenance++;
      return;
    }

    // 2. 检查静默期
    const isSilenced = await alertSilenceService.isSilenced(instanceId, rule.metric_name);
    if (isSilenced) {
      console.log(`⏭️ 静默跳过: ${rule.name} on instance ${instanceName}`);
      this.skippedBySilence++;
      return;
    }

    // 3. 去重：检查是否存在未解决的相同告警，存在则 touch 而不是创建新记录
    // availability 告警的 rule_id 为 0，也需要去重
    const existing = await alertDatabaseService.findActiveAlert(instanceId, rule.metric_name, rule.id);
    if (existing) {
      await alertDatabaseService.touchAlert(existing.id, currentValue);
      console.log(`[AlertEngine] Dedup: touching existing alert #${existing.id} (${rule.metric_name}=${currentValue}), skipping new alert`);
      return;
    }

    // 4. 映射严重级别
    const levelMap: Record<string, 'info' | 'warning' | 'error' | 'critical'> = {
      info: 'info',
      warning: 'warning',
      error: 'error',
      critical: 'critical',
    };

    // 5. 映射告警类型
    const typeMap: Record<string, 'performance' | 'availability' | 'security' | 'capacity'> = {
      cpu_usage: 'performance',
      memory_usage: 'performance',
      disk_usage: 'capacity',
      connections: 'performance',
      qps: 'performance',
      tps: 'performance',
      health_score: 'availability',
      slow_queries: 'performance',
      _availability: 'availability',
    };

    const severity = triggeredLevel || rule.severity;
    const threshold = thresholdUsed ?? rule.threshold;
    const title = `[${severity.toUpperCase()}] ${rule.name} - ${instanceName}`;
    const message = `指标 "${rule.metric_name}" 当前值为 ${currentValue}，超过阈值 ${threshold} (${rule.operator} ${threshold})`;

    const tags: any = {
      rule_id: rule.id,
      rule_name: rule.name,
      auto_generated: true,
    };

    // 6. 标记维护窗口抑制的告警（评估但不通知）
    if (mwCheck.active) {
      tags.maintenance_window = true;
    }

    const result = await alertDatabaseService.createAlert({
      instance_id: instanceId,
      alert_type: typeMap[rule.metric_name] || 'performance',
      level: levelMap[severity] || 'warning',
      title,
      message,
      description: rule.description || `告警规则：${rule.name}`,
      source: 'alert-engine',
      metric_name: rule.metric_name,
      metric_value: String(currentValue),
      threshold_value: String(threshold),
      tags,
    });

    // 7. 创建告警后，为该实例+指标设置静默期（使用规则配置的静默时长，默认 5 分钟）
    const silenceDuration = (rule.silence_minutes as number) ?? 5;
    if (result.success && result.alertId) {
      await alertSilenceService.silence(instanceId, rule.metric_name, silenceDuration, result.alertId);
    }

    console.log(`🚨 创建告警：${title}`);
  }

  /**
   * 获取评估状态
   */
  getEvaluationStatus(): AlertEngineStatus {
    return {
      running: this.running,
      lastRun: this.lastRun,
      nextRun: this.evaluationJob?.nextDates()[0] ? new Date(this.evaluationJob.nextDates()[0].toISO()) : null,
      evaluatedCount: this.evaluatedCount,
      triggeredCount: this.triggeredCount,
      skippedByMaintenance: this.skippedByMaintenance,
      skippedBySilence: this.skippedBySilence,
    };
  }

  /**
   * 手动触发评估
   */
  async triggerEvaluation(): Promise<{ evaluated: number; triggered: number }> {
    console.log('🔍 手动触发告警评估...');
    return this.evaluateAndCreateAlerts();
  }

  /**
   * 从 metric-registry 同步告警规则
   * 首次启动或新增指标时自动创建对应规则
   */
  async syncRulesFromRegistry(): Promise<{ created: number; updated: number }> {
    const { metricRegistry } = await import('./metric-registry');
    const metrics = metricRegistry.getAll();
    const existingRules = await alertDatabaseService.getAlertRules();
    const existingMetrics = new Set(existingRules.map(r => r.metric_name));
    let updated = 0;

    const pool = dbConnection.getPool();

    for (const m of metrics) {
      // D-14: 日志提醒 — 如果指标已关闭采集但仍有告警规则引用
      if (!m.is_collected && existingMetrics.has(m.id)) {
        console.log(`⚠️ 指标 "${m.name}(${m.id})" 已关闭采集，但存在告警规则引用`);
      }

      // Backfill db_types on existing rules if missing
      const existing = existingRules.find(r => r.metric_name === m.id);
      if (existing && (!existing.db_types || existing.db_types.length === 0)) {
        if (pool) {
          await pool.execute(
            'UPDATE alert_rules SET db_types = ? WHERE id = ?',
            [JSON.stringify(m.db_types), existing.id]
          );
          updated++;
          console.log(`  ↳ 回填规则 #${existing.id} db_types: ${m.db_types.join(', ')}`);
        }
      }
    }
    if (updated > 0) {
      console.log(`🔄 告警规则同步: ${updated} 回填 db_types`);
    }
    return { created: 0, updated };
  }
}

// 单例
export const alertEngine = new AlertEngine();
