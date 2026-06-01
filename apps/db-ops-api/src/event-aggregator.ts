/**
 * 告警事件聚合服务
 * 将同一实例同一时间段的同类告警聚合为同一事件，减少告警疲劳。
 * 聚合规则：instance_id + alert_type + metric_name + 10 分钟滑动窗口
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';
import { alertRCAService } from './alert-rca-service';
import { aiAnalysisConfigService } from './ai-analysis-config-service';

class EventAggregator {
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  private _levelToRank(level: string): number {
    const ranks: Record<string, number> = { info: 1, warning: 2, error: 3, critical: 4, p0: 5 };
    return ranks[level] || 0;
  }

  private _rankToLevel(rank: number): string {
    const levels: Record<number, string> = { 1: 'info', 2: 'warning', 3: 'error', 4: 'critical', 5: 'p0' };
    return levels[rank] || 'info';
  }

  /**
   * 执行事件聚合
   * Phase 1: 查找候选已有事件（10分钟内活跃的 open/investigating 事件）
   * Phase 2: 获取未聚合告警（按 instance+type+metric 排序）
   * Phase 3: 应用层滑动窗口分组（时间差 <= 10 分钟为同组）
   * Phase 4: 处理分组（吸收到已有事件 或 创建新事件）
   */
  async aggregate(): Promise<{ eventsCreated: number; alertsAggregated: number }> {
    const pool = this.getPool();
    if (!pool) return { eventsCreated: 0, alertsAggregated: 0 };

    try {
      // Phase 1: 查找候选已有事件
      // 查找 10 分钟内还有活动的 open/investigating 事件，
      // 新告警如果属于同一 instance+type+metric 则可能被吸收
      const [existingEvents] = await pool.execute(
        `SELECT e.id, e.event_id, e.instance_id, e.source_type, e.severity,
                MAX(m.created_at) AS last_alert_at,
                a.alert_type, a.metric_name
         FROM alert_events e
         JOIN alert_event_members m ON m.event_id = e.id
         JOIN alerts a ON a.id = m.alert_id
         WHERE e.status IN ('open', 'investigating')
           AND e.created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
         GROUP BY e.id, e.instance_id, e.source_type, a.alert_type, a.metric_name`
      ) as any;

      // 构建事件查找 Map: key = instance_id:alert_type:metric_name
      const eventMap = new Map<string, { eventPk: number; eventId: string; lastAlertAt: Date; severity: string }>();
      for (const evt of (existingEvents as any[])) {
        const key = `${evt.instance_id}:${evt.alert_type}:${evt.metric_name}`;
        const existing = eventMap.get(key);
        if (!existing || new Date(evt.last_alert_at) > new Date(existing.lastAlertAt)) {
          eventMap.set(key, {
            eventPk: evt.id,
            eventId: evt.event_id,
            lastAlertAt: evt.last_alert_at,
            severity: evt.severity,
          });
        }
      }

      // Phase 2: 获取未聚合告警（按 key + created_at 排序）
      const [alerts] = await pool.execute(
        `SELECT a.id, a.instance_id, a.alert_type, a.metric_name, a.level, a.created_at
         FROM alerts a
         WHERE a.status IN ('unread', 'read')
           AND a.created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
           AND NOT EXISTS (SELECT 1 FROM alert_event_members m WHERE m.alert_id = a.id)
         ORDER BY a.instance_id, a.alert_type, a.metric_name, a.created_at ASC`
      ) as any;

      if (!Array.isArray(alerts) || alerts.length === 0) {
        return { eventsCreated: 0, alertsAggregated: 0 };
      }

      // Phase 3: 按 (instance_id, alert_type, metric_name) 一级分组
      const alertGroups = new Map<string, any[]>();
      for (const alert of (alerts as any[])) {
        const key = `${alert.instance_id}:${alert.alert_type}:${alert.metric_name}`;
        if (!alertGroups.has(key)) alertGroups.set(key, []);
        alertGroups.get(key)!.push(alert);
      }

      // Phase 3b: 滑动窗口分组（应用层时间差比较）
      // 同一 (instance, type, metric) 内，按 created_at 排序后逐个比较时间差
      const groupsToProcess: {
        instance_id: number;
        alert_type: string;
        metric_name: string;
        alert_ids: number[];
        max_level: number;
        existingEventPk?: number;
        existingEventId?: string;
      }[] = [];

      alertGroups.forEach((alertList, key) => {
        const [instStr, aType, mName] = key.split(':');
        const instanceId = parseInt(instStr, 10);
        const candidateEvent = eventMap.get(key);

        let currentGroup: number[] = [];
        let maxLevel = 0;
        let lastTime: number | null = null;
        let groupIsConnected = false;
        let groupStarted = false;

        // alertList is already sorted by created_at ASC from the DB query
        for (const alert of alertList) {
          const alertTime = new Date(alert.created_at).getTime();

          if (!groupStarted) {
            // 开始一个新分组
            currentGroup = [alert.id];
            maxLevel = this._levelToRank(alert.level);
            lastTime = alertTime;
            groupStarted = true;

            // 判断本分组是否与候选事件相连
            // 仅当分组的第一个告警在候选事件最后一条告警的 10 分钟内才算连接
            groupIsConnected = candidateEvent !== undefined &&
              (alertTime - new Date(candidateEvent.lastAlertAt).getTime()) <= 10 * 60 * 1000;
          } else if ((alertTime - lastTime) <= 10 * 60 * 1000) {
            // 在 10 分钟滑动窗口内 —— 归入同一分组
            currentGroup.push(alert.id);
            maxLevel = Math.max(maxLevel, this._levelToRank(alert.level));
            lastTime = alertTime;
            // groupIsConnected 在分组开始时已确定，在此不再改变
          } else {
            // 超过 10 分钟 —— 结束当前分组，开始新分组
            if (currentGroup.length >= 2) {
              groupsToProcess.push({
                instance_id: instanceId,
                alert_type: aType,
                metric_name: mName,
                alert_ids: currentGroup,
                max_level: maxLevel,
                ...(groupIsConnected && candidateEvent
                  ? { existingEventPk: candidateEvent.eventPk, existingEventId: candidateEvent.eventId }
                  : {}),
              });
            }

            // 开始新分组（断开与候选事件的连接）
            currentGroup = [alert.id];
            maxLevel = this._levelToRank(alert.level);
            lastTime = alertTime;
            groupIsConnected = false;
          }
        }

        // 处理最后一个分组
        if (currentGroup.length >= 2) {
          groupsToProcess.push({
            instance_id: instanceId,
            alert_type: aType,
            metric_name: mName,
            alert_ids: currentGroup,
            max_level: maxLevel,
            ...(groupIsConnected && candidateEvent
              ? { existingEventPk: candidateEvent.eventPk, existingEventId: candidateEvent.eventId }
              : {}),
          });
        }
      });

      // 未形成任何可聚合分组（但有待聚合告警）
      if (groupsToProcess.length === 0) {
        const pendingCount = alerts.length;
        if (pendingCount > 0) {
          console.log(`📦 事件聚合: 发现 ${pendingCount} 条未聚合告警，但无满足 cnt>=2 的分组`);
        }
        return { eventsCreated: 0, alertsAggregated: 0 };
      }

      // Phase 4: 处理分组 —— 吸收到已有事件或创建新事件
      let eventsCreated = 0;
      let alertsAggregated = 0;

      for (const group of groupsToProcess) {
        try {
          let eventIdPk: number;
          let eventId: string;
          let isNewEvent = false;

          if (group.existingEventPk) {
            // 吸收到已有事件
            eventIdPk = group.existingEventPk;
            eventId = group.existingEventId!;
          } else {
            // 创建新事件
            isNewEvent = true;
            const severity = this._rankToLevel(group.max_level);
            eventId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
            const title = `告警事件: ${group.alert_type} on Instance ${group.instance_id}`;

            const [eventResult] = await pool.execute(
              `INSERT INTO alert_events (event_id, title, description, instance_id, source_type, severity, status)
               VALUES (?, ?, ?, ?, ?, ?, 'open')`,
              [eventId, title,
               `同实例同类型告警自动聚合 (${group.alert_ids.length} 条)`,
               group.instance_id, group.alert_type, severity]
            ) as any;
            eventIdPk = eventResult.insertId;
          }

          // 关联告警（两种路径共用）
          for (const alertId of group.alert_ids) {
            await pool.execute(
              `INSERT INTO alert_event_members (event_id, alert_id, role)
               VALUES (?, ?, 'triggered')`,
              [eventIdPk, alertId]
            );
          }

          // 事件日志（两种路径共用）
          await pool.execute(
            `INSERT INTO alert_event_logs (event_id, action, details, created_at)
             VALUES (?, 'note_added', ?, NOW())`,
            [eventIdPk, JSON.stringify({
              alert_count: group.alert_ids.length,
              alert_ids: group.alert_ids,
              action: isNewEvent ? 'created' : 'absorbed',
            })]
          );

          // 自动触发首个告警的 RCA（两种路径共用）
          const analysisConfig = await aiAnalysisConfigService.getConfig();
          if (analysisConfig.enabled) {
            await alertRCAService.analyzeAlert(group.alert_ids[0], 'auto');
          }

          if (isNewEvent) eventsCreated++;
          alertsAggregated += group.alert_ids.length;
        } catch (error) {
          console.error(`聚合事件失败 [实例 ${group.instance_id}]:`, error);
        }
      }

      return { eventsCreated, alertsAggregated };
    } catch (error) {
      console.error('事件聚合失败:', error);
      return { eventsCreated: 0, alertsAggregated: 0 };
    }
  }

  /**
   * 获取待聚合告警列表（用于 API 展示）
   */
  async getPendingAggregation(minutes: number = 10): Promise<any[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const [rows] = await pool.execute(
        `SELECT a.id, a.instance_id, a.alert_type, a.metric_name, a.level, a.title, a.created_at
         FROM alerts a
         WHERE a.status IN ('unread', 'read')
           AND a.created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
           AND NOT EXISTS (SELECT 1 FROM alert_event_members m WHERE m.alert_id = a.id)
         ORDER BY a.created_at DESC`,
        [minutes]
      ) as any;
      return rows;
    } catch (error) {
      console.error('获取待聚合告警失败:', error);
      return [];
    }
  }
}

// 单例导出
export const eventAggregator = new EventAggregator();
