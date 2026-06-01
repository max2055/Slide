/**
 * Cron 任务数据库服务
 * 提供 cron_jobs / cron_job_logs / cron_job_params 三表的 CRUD 操作
 */
import mysql from 'mysql2/promise';
import { dbConnection } from '../db-connection';
import { CronJobConfig, CronJobLog, CronJobParam } from './types';

export class CronJobDatabaseService {
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

  // ==================== cron_jobs CRUD ====================

  /**
   * 获取所有任务配置（按名称排序）
   */
  async getJobs(): Promise<CronJobConfig[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const [rows] = await pool.execute(
        `SELECT id, name, task_description, cron_expr, enabled, timezone, description,
                last_run_at, next_run_at, last_result, timeout_seconds, retry_count,
                created_at, updated_at
         FROM cron_jobs
         ORDER BY name`
      ) as any;
      return rows as CronJobConfig[];
    } catch (error) {
      console.error('查询定时任务列表失败:', error);
      return [];
    }
  }

  /**
   * 获取所有已启用的任务配置
   */
  async getEnabledJobs(): Promise<CronJobConfig[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const [rows] = await pool.execute(
        `SELECT id, name, task_description, cron_expr, enabled, timezone, description,
                last_run_at, next_run_at, last_result, timeout_seconds, retry_count,
                created_at, updated_at
         FROM cron_jobs
         WHERE enabled = 1
         ORDER BY name`
      ) as any;
      return rows as CronJobConfig[];
    } catch (error) {
      console.error('查询已启用定时任务失败:', error);
      return [];
    }
  }

  /**
   * 根据 ID 获取任务配置
   */
  async getJobById(id: number): Promise<CronJobConfig | null> {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      const [rows] = await pool.execute(
        `SELECT id, name, task_description, output_schema, cron_expr, enabled, timezone, description,
                last_run_at, next_run_at, last_result, timeout_seconds, retry_count,
                created_at, updated_at
         FROM cron_jobs
         WHERE id = ?`,
        [id]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0] as CronJobConfig;
      }
      return null;
    } catch (error) {
      console.error('查询定时任务失败:', error);
      return null;
    }
  }

  /**
   * 更新任务配置（仅更新非 undefined 的字段）
   */
  async updateJob(id: number, data: Partial<Pick<CronJobConfig, 'task_description' | 'cron_expr' | 'enabled' | 'timezone' | 'description' | 'timeout_seconds' | 'retry_count'>>): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) throw new Error('数据库未连接');

    try {
      const updates: string[] = [];
      const values: any[] = [];

      if (data.task_description !== undefined) {
        updates.push('task_description = ?');
        values.push(data.task_description);
      }

      if (data.cron_expr !== undefined) {
        updates.push('cron_expr = ?');
        values.push(data.cron_expr);
      }

      if (data.enabled !== undefined) {
        updates.push('enabled = ?');
        values.push(data.enabled ? 1 : 0);
      }

      if (data.timezone !== undefined) {
        updates.push('timezone = ?');
        values.push(data.timezone);
      }

      if (data.description !== undefined) {
        updates.push('description = ?');
        values.push(data.description);
      }

      if (data.timeout_seconds !== undefined) {
        updates.push('timeout_seconds = ?');
        values.push(data.timeout_seconds);
      }

      if (data.retry_count !== undefined) {
        updates.push('retry_count = ?');
        values.push(data.retry_count);
      }

      if (updates.length === 0) return false;

      values.push(id);

      const [result] = await pool.execute(
        `UPDATE cron_jobs SET ${updates.join(', ')} WHERE id = ?`,
        values
      ) as any;

      return (result as any).affectedRows > 0;
    } catch (error: any) {
      console.error('更新定时任务失败:', error);
      throw error;
    }
  }

  /**
   * 创建定时任务
   */
  /** Auto-seed default cron jobs if table is empty (recovery from Phase 113 migration) */
  async ensureSeedData(): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;
    try {
      const [rows] = await pool.execute('SELECT COUNT(*) as cnt FROM cron_jobs') as any;
      if (rows[0].cnt > 0) return;

      const defaults: Array<{name: string; task_description: string; cron_expr: string; description?: string}> = [
        { name: 'TopSQL 自动分析', cron_expr: '*/10 * * * * *', task_description: 'Every 10 seconds, scan all active database instances for slow queries with average execution time >= 10 seconds. For each new slow query found, perform an automated AI analysis to identify optimization opportunities. Skip queries that have already been analyzed within the last 30 minutes. Call slide_complete_cron with your findings summary.', description: '自动分析慢查询并给出优化建议' },
        { name: '告警 RCA 分析', cron_expr: '*/10 * * * * *', task_description: 'Every 10 seconds, check for new alerts created within the last 30 seconds. For each alert matching configured severity levels and active time windows, perform automated root cause analysis. Call slide_complete_cron with the RCA findings.', description: '对告警进行根因分析' },
        { name: '故障自动诊断', cron_expr: '0 * * * * *', task_description: 'Every 60 seconds, diagnose database instances that are reporting unhealthy status. For each affected instance, run comprehensive diagnostics: health check, performance analysis, connection check. Generate a diagnostic report. Call slide_complete_cron when diagnosis is complete.', description: '自动诊断不健康实例' },
        { name: '容量数据采集', cron_expr: '0 */5 * * * *', task_description: 'Every 5 minutes, collect capacity metrics from all active database instances. For each instance, query total storage size in GB, number of databases, and number of tables per database. Call slide_complete_cron with capacity summary.', description: '定期采集容量数据' },
        { name: 'Schema 快照采集', cron_expr: '30 */30 * * * *', task_description: 'Every 30 minutes, collect complete schema snapshots from all active database instances. Detect and report schema changes since the last snapshot. Call slide_complete_cron with schema change summary.', description: '定期采集Schema快照' },
        { name: '索引信息采集', cron_expr: '15,45 * * * *', task_description: 'Every 30 minutes at :15 and :45, collect index information from all active database instances. Gather index names, columns, types, and usage statistics. Call slide_complete_cron with the index inventory results.', description: '定期采集索引信息' },
        { name: '基线计算', cron_expr: '0 2 * * *', task_description: 'Every day at 2:00 AM, calculate performance metric baselines for all database instances. For each instance, compute per-metric baselines for CPU usage, memory utilization, IOPS, query latency, and connection counts. Call slide_complete_cron with baseline computation results.', description: '每日计算性能基线' },
        { name: '基线清理', cron_expr: '0 3 * * 0', task_description: 'Every Sunday at 3:00 AM, clean up baseline data older than 30 days. Call slide_complete_cron when cleanup is complete.', description: '每周清理过期基线' },
        { name: '数据库日志采集', cron_expr: '0 */5 * * * *', task_description: 'Every 5 minutes, collect and store database logs from all available sources. Call slide_complete_cron with a summary of collected log entries.', description: '定期采集数据库日志' },
        { name: '静默过期清理', cron_expr: '0 * * * *', task_description: 'Every hour, check for expired alert silence rules. Remove any silence rules whose validity period has ended. Call slide_complete_cron with the count of expired rules cleaned.', description: '每小时清理过期静默规则' },
        { name: '定时报表调度', cron_expr: '0 * * * * *', task_description: 'Every 60 seconds, scan all enabled report configurations. For each matching cron schedule, generate the scheduled report in the configured format. Call slide_complete_cron with the report generation results.', description: '按配置生成定时报表' },
        { name: '(预留) 升级规则监控', cron_expr: '*/10 * * * * *', task_description: 'Every 10 seconds, check alert escalation rules for pending escalations. Process auto-escalation logic for unacknowledged alerts. Call slide_complete_cron with status.', description: '监控告警升级规则' },
        { name: '(预留) 通知推送检查', cron_expr: '*/30 * * * * *', task_description: 'Every 30 seconds, check the notification queue for pending notifications. Process and deliver queued notifications. Call slide_complete_cron with status.', description: '检查通知推送队列' },
      ];

      for (const d of defaults) {
        await pool.execute(
          'INSERT INTO cron_jobs (name, task_description, cron_expr, timezone, description, timeout_seconds, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [d.name, d.task_description, d.cron_expr, 'Asia/Shanghai', d.description || null, 300, true]
        );
      }
      console.log(`[CronJobService] Seeded ${defaults.length} default cron jobs`);
    } catch (err: any) {
      console.warn('[CronJobService] Seed check failed (non-fatal):', err.message);
    }
  }

  async createJob(data: {
    name: string;
    task_description: string;
    cron_expr: string;
    timezone?: string;
    description?: string;
    timeout_seconds?: number;
  }): Promise<number> {
    const pool = this.getPool();
    if (!pool) throw new Error('数据库未连接');

    try {
      const [result] = await pool.execute(
        `INSERT INTO cron_jobs (name, task_description, cron_expr, timezone, description, timeout_seconds)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          data.name,
          data.task_description,
          data.cron_expr,
          data.timezone || 'Asia/Shanghai',
          data.description || null,
          data.timeout_seconds || 300,
        ]
      ) as any;
      return (result as any).insertId;
    } catch (error: any) {
      console.error('创建定时任务失败:', error);
      throw error;
    }
  }

  /**
   * 启停任务
   */
  async toggleJob(id: number, enabled: boolean): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) throw new Error('数据库未连接');

    try {
      const [result] = await pool.execute(
        'UPDATE cron_jobs SET enabled = ? WHERE id = ?',
        [enabled ? 1 : 0, id]
      ) as any;

      return (result as any).affectedRows > 0;
    } catch (error: any) {
      console.error('启停定时任务失败:', error);
      throw error;
    }
  }

  /**
   * 删除定时任务（日志通过 CASCADE 自动清理）
   */
  async deleteJob(id: number): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) return false;

    try {
      const [result] = await pool.execute(
        'DELETE FROM cron_jobs WHERE id = ?',
        [id]
      ) as any;
      return (result as any).affectedRows > 0;
    } catch (error) {
      console.error('删除定时任务失败:', error);
      return false;
    }
  }

  /**
   * 更新任务执行结果
   */
  async updateRunResult(id: number, status: string, summary?: string): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) return false;

    try {
      const [result] = await pool.execute(
        'UPDATE cron_jobs SET last_run_at = NOW(), last_result = ? WHERE id = ?',
        [status, id]
      ) as any;

      return (result as any).affectedRows > 0;
    } catch (error) {
      console.error('更新任务执行结果失败:', error);
      return false;
    }
  }

  /**
   * 更新下次执行时间
   */
  async updateNextRun(id: number, nextRunAt: Date): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) return false;

    try {
      const [result] = await pool.execute(
        'UPDATE cron_jobs SET next_run_at = ? WHERE id = ?',
        [nextRunAt, id]
      ) as any;

      return (result as any).affectedRows > 0;
    } catch (error) {
      console.error('更新下次执行时间失败:', error);
      return false;
    }
  }

  // ==================== cron_job_logs CRUD ====================

  /**
   * 创建执行日志（初始状态为 running）
   */
  async startLog(jobId: number): Promise<number> {
    const pool = this.getPool();
    if (!pool) throw new Error('数据库未连接');

    try {
      const [result] = await pool.execute(
        'INSERT INTO cron_job_logs (job_id, started_at, status) VALUES (?, NOW(), \'running\')',
        [jobId]
      ) as any;

      return (result as any).insertId;
    } catch (error: any) {
      console.error('创建执行日志失败:', error);
      throw error;
    }
  }

  /**
   * 完成执行日志（更新状态、结束时间、结果摘要、Agent 迹数据）
   */
  async completeLog(
    logId: number,
    status: string,
    summary?: string,
    errorMessage?: string,
    structuredResult?: Record<string, unknown> | null,
    trace?: {
      tools_used?: string[];
      tool_events?: any[];
      usage?: Record<string, number>;
      stop_reason?: string;
      duration_ms?: number;
      partial_trace?: string;
      error_trace?: string;
    },
  ): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) return false;

    try {
      const [result] = await pool.execute(
        `UPDATE cron_job_logs
         SET finished_at = NOW(), status = ?, result_summary = ?,
             error_message = ?,
             structured_result = ?,
             tools_used = ?,
             tool_events = ?,
             \`usage\` = ?,
             stop_reason = ?,
             duration_ms = ?,
             partial_trace = ?,
             error_trace = ?
         WHERE id = ?`,
        [
          status,
          summary || null,
          errorMessage || null,
          structuredResult ? JSON.stringify(structuredResult) : null,
          trace?.tools_used ? JSON.stringify(trace.tools_used) : null,
          trace?.tool_events ? JSON.stringify(trace.tool_events) : null,
          trace?.usage ? JSON.stringify(trace.usage) : null,
          trace?.stop_reason || null,
          trace?.duration_ms || null,
          trace?.partial_trace || null,
          trace?.error_trace || null,
          logId,
        ]
      ) as any;

      return (result as any).affectedRows > 0;
    } catch (error) {
      console.error('更新执行日志失败:', error);
      return false;
    }
  }

  /**
   * 获取任务执行日志（按时间倒序）
   */
  async getLogs(jobId: number, limit: number = 20, offset: number = 0): Promise<{ logs: CronJobLog[]; total: number }> {
    const pool = this.getPool();
    if (!pool) return { logs: [], total: 0 };

    try {
      const [countResult] = await pool.execute(
        'SELECT COUNT(*) AS total FROM cron_job_logs WHERE job_id = ?',
        [jobId]
      ) as any;
      const total = countResult[0]?.total || 0;

      const [rows] = await pool.execute(
        `SELECT id, job_id, started_at, finished_at, status, result_summary, error_message,
                result, structured_result, tools_used, tool_events, \`usage\`, stop_reason, duration_ms, error_trace, partial_trace
         FROM cron_job_logs
         WHERE job_id = ?
         ORDER BY started_at DESC
         LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
        [jobId]
      ) as any;

      return { logs: rows as CronJobLog[], total };
    } catch (error) {
      console.error('查询执行日志失败:', error);
      return { logs: [], total: 0 };
    }
  }

  // ==================== cron_job_params CRUD ====================

  /**
   * 获取任务参数
   */
  async getParams(jobId: number): Promise<CronJobParam[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      const [rows] = await pool.execute(
        'SELECT id, job_id, param_key, param_value FROM cron_job_params WHERE job_id = ?',
        [jobId]
      ) as any;

      return rows as CronJobParam[];
    } catch (error) {
      console.error('查询任务参数失败:', error);
      return [];
    }
  }
}

// 单例
export const cronJobService = new CronJobDatabaseService();
