/**
 * 告警事件生命周期管理服务
 * 完整事件流：open → investigating → handled → resolved → closed
 * 支持 AI 分析、处理记录、关闭、复盘。
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection';
import { alertRCAService } from './alert-rca-service';

const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  open: ['investigating', 'resolved', 'closed'],
  investigating: ['handled', 'resolved', 'closed'],
  handled: ['resolved', 'closed'],
  resolved: ['closed'],
  closed: [],
};

class AlertEventService {
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * 获取事件列表，支持过滤和分页
   */
  async getEvents(options?: {
    instance_id?: number;
    status?: string;
    severity?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      let sql = `
        SELECT e.*, COUNT(DISTINCT m.alert_id) AS alert_count,
               d.name AS instance_name
        FROM alert_events e
        LEFT JOIN alert_event_members m ON e.id = m.event_id
        LEFT JOIN database_instances d ON e.instance_id = d.id
        WHERE 1=1
      `;
      const params: any[] = [];

      if (options?.instance_id !== undefined) {
        sql += ' AND e.instance_id = ?';
        params.push(options.instance_id);
      }
      if (options?.status) {
        const statuses = options.status.split(',').map(s => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          sql += ' AND e.status = ?';
          params.push(statuses[0]);
        } else if (statuses.length > 1) {
          sql += ` AND e.status IN (${statuses.map(() => '?').join(',')})`;
          params.push(...statuses);
        }
      }
      if (options?.severity) {
        sql += ' AND e.severity = ?';
        params.push(options.severity);
      }

      sql += ' GROUP BY e.id ORDER BY e.created_at DESC';

      if (options?.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(options.limit);
      }
      if (options?.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }

      const [rows] = await pool.execute(sql, params) as any;

      // Get total count for pagination
      let total = rows.length;
      if (options?.limit !== undefined) {
        let countSql = 'SELECT COUNT(DISTINCT e.id) AS total FROM alert_events e WHERE 1=1';
        const countParams: any[] = [];
        if (options?.instance_id !== undefined) { countSql += ' AND e.instance_id = ?'; countParams.push(options.instance_id); }
        if (options?.status) {
          const statuses = options.status.split(',').map(s => s.trim()).filter(Boolean);
          if (statuses.length === 1) {
            countSql += ' AND e.status = ?'; countParams.push(statuses[0]);
          } else if (statuses.length > 1) {
            countSql += ` AND e.status IN (${statuses.map(() => '?').join(',')})`;
            countParams.push(...statuses);
          }
        }
        if (options?.severity) { countSql += ' AND e.severity = ?'; countParams.push(options.severity); }
        const [countRows] = await pool.execute(countSql, countParams) as any;
        total = countRows[0]?.total ?? rows.length;
      }

      return { items: rows, total };
    } catch (error) {
      console.error('获取事件列表失败:', error);
      return { items: [], total: 0 };
    }
  }

  /**
   * 获取事件详情 + 关联告警 + 操作日志
   */
  async getEventById(eventId: number): Promise<any | null> {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      // 事件详情
      const [events] = await pool.execute(
        `SELECT e.*, d.name AS instance_name
         FROM alert_events e
         LEFT JOIN database_instances d ON e.instance_id = d.id
         WHERE e.id = ?`,
        [eventId]
      ) as any;

      if (!Array.isArray(events) || events.length === 0) return null;

      // 关联告警
      const [alerts] = await pool.execute(
        `SELECT a.id, a.level, a.status, a.title, a.metric_name, a.metric_value, a.created_at
         FROM alert_event_members m
         JOIN alerts a ON m.alert_id = a.id
         WHERE m.event_id = ?
         ORDER BY a.created_at ASC`,
        [eventId]
      ) as any;

      // 操作日志
      const [logs] = await pool.execute(
        `SELECT id, action, actor_id, details, created_at
         FROM alert_event_logs
         WHERE event_id = ?
         ORDER BY created_at DESC`,
        [eventId]
      ) as any;

      return {
        ...events[0],
        alerts: alerts || [],
        logs: logs || [],
      };
    } catch (error) {
      console.error('获取事件详情失败:', error);
      return null;
    }
  }

  /**
   * 创建事件（通常由 eventAggregator 自动调用）
   */
  async createEvent(data: {
    event_id: string;
    title: string;
    description?: string;
    instance_id: number;
    source_type?: string;
    severity: string;
  }): Promise<{ success: boolean; eventId?: number }> {
    const pool = this.getPool();
    if (!pool) return { success: false };

    try {
      const [result] = await pool.execute(
        `INSERT INTO alert_events (event_id, title, description, instance_id, source_type, severity, status)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        [data.event_id, data.title, data.description || null, data.instance_id, data.source_type || null, data.severity]
      ) as any;
      return { success: true, eventId: result.insertId };
    } catch (error) {
      console.error('创建事件失败:', error);
      return { success: false };
    }
  }

  /**
   * 更新事件属性（标题、描述、严重级别等）
   */
  async updateEvent(eventId: number, data: {
    title?: string;
    description?: string;
    severity?: string;
    source_type?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const sets: string[] = [];
      const params: any[] = [];
      if (data.title !== undefined) { sets.push('title = ?'); params.push(data.title); }
      if (data.description !== undefined) { sets.push('description = ?'); params.push(data.description); }
      if (data.severity !== undefined) { sets.push('severity = ?'); params.push(data.severity); }
      if (data.source_type !== undefined) { sets.push('source_type = ?'); params.push(data.source_type); }

      if (sets.length === 0) {
        return { success: false, error: '没有需要更新的字段' };
      }

      params.push(eventId);
      await pool.execute(
        `UPDATE alert_events SET ${sets.join(', ')} WHERE id = ?`,
        params
      );

      await this._logEvent(eventId, 'note_added', undefined, { action: 'updated', fields: data });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 删除事件
   */
  async deleteEvent(eventId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      // 删除关联的 members 和 logs
      await pool.execute('DELETE FROM alert_event_members WHERE event_id = ?', [eventId]);
      await pool.execute('DELETE FROM alert_event_logs WHERE event_id = ?', [eventId]);
      await pool.execute('DELETE FROM alert_events WHERE id = ?', [eventId]);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 分配事件处理人
   */
  async assignEvent(eventId: number, userId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      await pool.execute('UPDATE alert_events SET assigned_to = ? WHERE id = ?', [userId, eventId]);
      await this._logEvent(eventId, 'note_added', userId, { action: 'assigned', user_id: userId });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 开始调查
   */
  async startInvestigation(eventId: number, userId?: number): Promise<{ success: boolean; error?: string }> {
    return this._transitionStatus(eventId, 'investigating', userId, { action: 'investigation_started' });
  }

  /**
   * 添加处理记录
   */
  async addHandlerNote(eventId: number, note: string, userId?: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      await this._logEvent(eventId, 'handled', userId, { note, user_id: userId });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 解决事件
   */
  async resolveEvent(eventId: number, resolutionNotes: string, userId?: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      // 校验状态流转
      if (!(await this._canTransition(eventId, 'resolved'))) {
        return { success: false, error: '当前状态不允许直接解决' };
      }

      await pool.execute(
        'UPDATE alert_events SET status = ?, resolution_notes = ?, resolved_at = NOW(), resolved_by = ? WHERE id = ?',
        ['resolved', resolutionNotes, userId || null, eventId]
      );

      await this._logEvent(eventId, 'resolved', userId, { resolution_notes: resolutionNotes });

      // 将所有未关闭的关联告警标记为 resolved
      await pool.execute(
        `UPDATE alerts SET status = 'resolved' WHERE id IN (
          SELECT alert_id FROM alert_event_members WHERE event_id = ?
        ) AND status IN ('unread', 'read', 'acknowledged')`,
        [eventId]
      );

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 关闭事件
   */
  async closeEvent(eventId: number, userId?: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      // closed 状态不允许再操作
      const [rows] = await pool.execute('SELECT status FROM alert_events WHERE id = ?', [eventId]) as any;
      if (rows[0]?.status === 'closed') {
        return { success: false, error: '事件已关闭，无法再次操作' };
      }

      await pool.execute(
        'UPDATE alert_events SET status = ? WHERE id = ?',
        ['closed', eventId]
      );

      await this._logEvent(eventId, 'status_changed', userId, { from: rows[0]?.status, to: 'closed', action: 'closed' });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 为事件关联的所有告警触发 RCA 分析
   */
  async triggerRCAForEvent(eventId: number, userId?: number): Promise<{ success: boolean; analysisIds?: number[]; sessionKeys?: string[] }> {
    const pool = this.getPool();
    if (!pool) return { success: false };

    try {
      const [members] = await pool.execute(
        'SELECT alert_id FROM alert_event_members WHERE event_id = ?',
        [eventId]
      ) as any;

      if (!Array.isArray(members) || members.length === 0) {
        return { success: false };
      }

      const analysisIds: number[] = [];
      const sessionKeys: string[] = [];
      for (const member of members) {
        const result = await alertRCAService.analyzeAlert(member.alert_id, 'manual');
        if (result.success && result.analysisId) {
          analysisIds.push(result.analysisId);
          if (result.sessionKey) sessionKeys.push(result.sessionKey);
        }
      }

      await this._logEvent(eventId, 'note_added', userId, {
        action: 'rca_triggered',
        analysis_ids: analysisIds,
        session_keys: sessionKeys,
        user_id: userId,
      });

      return { success: true, analysisIds, sessionKeys };
    } catch (error) {
      console.error('触发事件 RCA 失败:', error);
      return { success: false };
    }
  }

  /**
   * 添加事件复盘
   */
  async addPostmortem(eventId: number, postmortem: any, userId?: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      // Store postmortem as an event log entry instead of overwriting description
      await this._logEvent(eventId, 'note_added', userId, {
        action: 'postmortem_added',
        user_id: userId,
        postmortem,
      });

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * MTTR 统计（仅统计已解决/已关闭的事件）
   * MTTR = 从 created_at 到 resolved_at/closed_at 的时间（分钟）
   */
  async getMTTRStats(): Promise<{
    avg_mttr_minutes: number;
    median_mttr_minutes: number;
    p95_mttr_minutes: number;
    total_resolved: number;
  }> {
    const pool = this.getPool();
    if (!pool) {
      return { avg_mttr_minutes: 0, median_mttr_minutes: 0, p95_mttr_minutes: 0, total_resolved: 0 };
    }

    try {
      // 获取所有已解决/已关闭事件的 MTTR 值
      const [rows] = await pool.execute(
        `SELECT TIMESTAMPDIFF(MINUTE, created_at, COALESCE(resolved_at, updated_at)) AS mttr_minutes
         FROM alert_events
         WHERE status IN ('resolved', 'closed')
           AND resolved_at IS NOT NULL
         ORDER BY mttr_minutes`
      ) as any;

      if (!Array.isArray(rows) || rows.length === 0) {
        return { avg_mttr_minutes: 0, median_mttr_minutes: 0, p95_mttr_minutes: 0, total_resolved: 0 };
      }

      const values: number[] = rows
        .map((r: any) => Number(r.mttr_minutes))
        .filter((v: number) => !isNaN(v) && v >= 0)
        .sort((a: number, b: number) => a - b);

      if (values.length === 0) {
        return { avg_mttr_minutes: 0, median_mttr_minutes: 0, p95_mttr_minutes: 0, total_resolved: 0 };
      }

      const total = values.length;
      const avg = values.reduce((sum: number, v: number) => sum + v, 0) / total;
      const median = this._percentile(values, 50);
      const p95 = this._percentile(values, 95);

      return {
        avg_mttr_minutes: Math.round(avg * 100) / 100,
        median_mttr_minutes: Math.round(median * 100) / 100,
        p95_mttr_minutes: Math.round(p95 * 100) / 100,
        total_resolved: total,
      };
    } catch (error) {
      console.error('获取 MTTR 统计失败:', error);
      return { avg_mttr_minutes: 0, median_mttr_minutes: 0, p95_mttr_minutes: 0, total_resolved: 0 };
    }
  }

  /**
   * Auto-resolve events when all their member alerts are resolved.
   * Call this after an individual alert has been resolved (e.g. by auto-recovery).
   */
  async autoResolveByAlert(alertId: number): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;

    try {
      // Find events this alert belongs to that are still in active statuses
      const [memberships] = await pool.execute(
        `SELECT DISTINCT m.event_id, e.status
         FROM alert_event_members m
         JOIN alert_events e ON e.id = m.event_id
         WHERE m.alert_id = ? AND e.status IN ('open', 'investigating', 'handled')`,
        [alertId]
      ) as any;

      if (!Array.isArray(memberships) || memberships.length === 0) return;

      for (const m of memberships) {
        // Check if ALL member alerts of this event are now resolved/closed
        const [unresolved] = await pool.execute(
          `SELECT COUNT(*) AS cnt FROM alert_event_members mem
           JOIN alerts a ON a.id = mem.alert_id
           WHERE mem.event_id = ?
             AND a.status NOT IN ('resolved', 'closed')`,
          [m.event_id]
        ) as any;

        if (unresolved[0]?.cnt === 0) {
          await pool.execute(
            `UPDATE alert_events SET status = 'resolved', resolved_at = NOW() WHERE id = ?`,
            [m.event_id]
          );
          await this._logEvent(m.event_id, 'resolved', undefined, {
            action: 'auto_resolved',
            note: '所有关联告警已恢复，事件自动解决',
            trigger_alert_id: alertId,
          });
          console.log(`[AlertEventService] Auto-resolved event #${m.event_id} (all member alerts recovered)`);
        }
      }
    } catch (error) {
      console.error('[AlertEventService] autoResolveByAlert failed:', error);
    }
  }

  /**
   * Retroactively resolve all events whose member alerts are all resolved/closed.
   * One-time cleanup for events accumulated before auto-resolve was implemented.
   */
  async retroactiveResolve(): Promise<{ resolved: number }> {
    const pool = this.getPool();
    if (!pool) return { resolved: 0 };

    try {
      // Find active events where no member alert is still active
      const [events] = await pool.execute(
        `SELECT e.id, e.status
         FROM alert_events e
         WHERE e.status IN ('open', 'investigating', 'handled')
           AND e.id IN (
             SELECT DISTINCT m.event_id FROM alert_event_members m
           )
           AND NOT EXISTS (
             SELECT 1 FROM alert_event_members mem
             JOIN alerts a ON a.id = mem.alert_id
             WHERE mem.event_id = e.id
               AND a.status NOT IN ('resolved', 'closed')
           )`
      ) as any;

      if (!Array.isArray(events) || events.length === 0) {
        console.log('[AlertEventService] retroactiveResolve: no stale events to clean up');
        return { resolved: 0 };
      }

      let resolved = 0;
      for (const e of events) {
        await pool.execute(
          `UPDATE alert_events SET status = 'resolved', resolved_at = NOW() WHERE id = ?`,
          [e.id]
        );
        await this._logEvent(e.id, 'resolved', undefined, {
          action: 'retroactive_resolved',
          note: '补录：所有关联告警已恢复，事件自动解决',
        });
        resolved++;
      }

      console.log(`[AlertEventService] Retroactive resolve: ${resolved} events resolved`);
      return { resolved };
    } catch (error) {
      console.error('[AlertEventService] retroactiveResolve failed:', error);
      return { resolved: 0 };
    }
  }

  /**
   * 计算百分位值（已排序数组）
   */
  private _percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  /**
   * 搜索事件，支持关键词、实例、状态、严重级别、时间范围过滤
   */
  async searchEvents(query: {
    keyword?: string;
    instance_id?: number;
    status?: string;
    severity?: string;
    date_from?: string;
    date_to?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      let sql = `
        SELECT e.*, COUNT(DISTINCT m.alert_id) AS alert_count,
               d.name AS instance_name
        FROM alert_events e
        LEFT JOIN alert_event_members m ON e.id = m.event_id
        LEFT JOIN database_instances d ON e.instance_id = d.id
        WHERE 1=1
      `;
      const params: any[] = [];

      if (query.keyword) {
        sql += ' AND (e.title LIKE ? OR e.description LIKE ?)';
        const kw = `%${query.keyword}%`;
        params.push(kw, kw);
      }
      if (query.instance_id !== undefined) {
        sql += ' AND e.instance_id = ?';
        params.push(query.instance_id);
      }
      if (query.status) {
        const statuses = query.status.split(',').map(s => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          sql += ' AND e.status = ?';
          params.push(statuses[0]);
        } else if (statuses.length > 1) {
          sql += ` AND e.status IN (${statuses.map(() => '?').join(',')})`;
          params.push(...statuses);
        }
      }
      if (query.severity) {
        sql += ' AND e.severity = ?';
        params.push(query.severity);
      }
      if (query.date_from) {
        sql += ' AND e.created_at >= ?';
        params.push(query.date_from);
      }
      if (query.date_to) {
        sql += ' AND e.created_at <= ?';
        params.push(query.date_to);
      }

      sql += ' GROUP BY e.id ORDER BY e.created_at DESC';

      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const [rows] = await pool.execute(sql, params) as any;
      return rows;
    } catch (error) {
      console.error('搜索事件失败:', error);
      return [];
    }
  }

  /**
   * 事件统计
   */
  async getEventStats(): Promise<{
    total: number; open: number; investigating: number;
    handled: number; resolved: number; closed: number;
  }> {
    const pool = this.getPool();
    if (!pool) {
      return { total: 0, open: 0, investigating: 0, handled: 0, resolved: 0, closed: 0 };
    }

    try {
      const [rows] = await pool.execute(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN status = 'investigating' THEN 1 ELSE 0 END) AS investigating,
          SUM(CASE WHEN status = 'handled' THEN 1 ELSE 0 END) AS handled,
          SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
          SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed
         FROM alert_events`
      ) as any;

      return rows[0] || { total: 0, open: 0, investigating: 0, handled: 0, resolved: 0, closed: 0 };
    } catch (error) {
      console.error('获取事件统计失败:', error);
      return { total: 0, open: 0, investigating: 0, handled: 0, resolved: 0, closed: 0 };
    }
  }

  /**
   * 检查状态是否允许流转
   */
  private async _canTransition(eventId: number, newStatus: string): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) return false;

    try {
      const [rows] = await pool.execute('SELECT status FROM alert_events WHERE id = ?', [eventId]) as any;
      if (!Array.isArray(rows) || rows.length === 0) return false;

      const currentStatus = rows[0].status;
      const allowed = VALID_STATUS_TRANSITIONS[currentStatus] || [];
      return allowed.includes(newStatus);
    } catch (error) {
      return false;
    }
  }

  /**
   * 执行状态流转（带校验）
   */
  private async _transitionStatus(
    eventId: number,
    newStatus: string,
    userId: number | undefined,
    details: any
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      if (!(await this._canTransition(eventId, newStatus))) {
        return { success: false, error: `不允许从当前状态转换到 ${newStatus}` };
      }

      await pool.execute(
        'UPDATE alert_events SET status = ? WHERE id = ?',
        [newStatus, eventId]
      );

      await this._logEvent(eventId, 'status_changed', userId, {
        action: newStatus,
        ...details,
      });

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取事件操作日志
   */
  async getEventLogs(eventId: number): Promise<any[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const [rows] = await pool.execute(
        `SELECT id, event_id, action, actor_id, details, created_at
         FROM alert_event_logs
         WHERE event_id = ?
         ORDER BY created_at ASC`,
        [eventId]
      ) as any;
      return rows.map((row: any) => ({
        ...row,
        note: typeof row.details === 'string' ? row.details : JSON.stringify(row.details),
      }));
    } catch {
      return [];
    }
  }

  /**
   * 记录事件日志
   */
  private async _logEvent(
    eventId: number,
    action: string,
    userId: number | undefined,
    details: any
  ): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;

    await pool.execute(
      `INSERT INTO alert_event_logs (event_id, action, actor_id, details, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [eventId, action, userId || null, JSON.stringify(details)]
    );
  }
}

// 单例导出
export const alertEventService = new AlertEventService();
