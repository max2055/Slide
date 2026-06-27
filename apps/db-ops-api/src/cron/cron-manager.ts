/**
 * CronManager — AI Agent 驱动的定时任务调度器
 *
 * - 从 cron_jobs 表读取已启用的任务配置
 * - 通过 CronExecutor (AgentRunner) 执行自然语言任务描述
 * - 每个启用任务创建一个 cron.CronJob 实例
 * - 使用 runningFlags 防止同一任务的并发重叠执行
 * - 每次执行记录到 cron_job_logs 表（含完整 Agent 执行迹）
 */
import { CronJob } from 'cron';
import { CronJobDatabaseService } from './cron-job-service';
import { CronJobConfig } from './types';
import { CronExecutor } from './cron-executor';
import { sqlExecutor } from '../sql-executor';
import { dbConnection } from '../db-connection';

export class CronManager {
  /** 数据库服务 */
  private jobService: CronJobDatabaseService;

  /** CronExecutor 实例 */
  private cronExecutor: CronExecutor;

  /** 是否正在运行 */
  private running: boolean = false;

  /** 当前调度的任务映射：jobId → CronJob 实例 */
  private jobs: Map<number, CronJob> = new Map();

  /** 正在执行的任务 ID 集合（并发守卫） */
  private runningFlags: Set<number> = new Set();

  constructor(
    jobService: CronJobDatabaseService,
    cronExecutor: CronExecutor,
  ) {
    this.jobService = jobService;
    this.cronExecutor = cronExecutor;
  }

  /**
   * 启动 CronManager
   * 从数据库读取已启用的任务并调度
   */
  async start(): Promise<void> {
    console.log('CronManager: 正在启动...');
    await this.jobService.ensureSeedData();
    this.running = true;
    await this.reload();
  }

  /**
   * 重载所有任务
   * 停止所有现有任务，重新从数据库读取已启用的任务并调度
   */
  async reload(): Promise<void> {
    this.stopAllJobs();

    if (!this.running) return;

    try {
      const enabledJobs = await this.jobService.getEnabledJobs();

      for (const config of enabledJobs) {
        this.scheduleJob(config);
      }

      console.log(`CronManager: ${enabledJobs.length} 个任务已调度`);
    } catch (error) {
      console.error('CronManager 重载失败:', error);
    }
  }

  /**
   * 停止 CronManager
   * 停止所有任务并将 running 标志设为 false
   */
  async stop(): Promise<void> {
    console.log('CronManager: 正在停止...');
    this.running = false;
    this.stopAllJobs();
    console.log('CronManager: 已停止');
  }

  /**
   * 停止所有已调度的任务
   */
  private stopAllJobs(): void {
    for (const [id, job] of this.jobs.entries()) {
      job.stop();
    }
    this.jobs.clear();
  }

  /**
   * 调度单个任务
   */
  private scheduleJob(config: CronJobConfig): void {
    const cronJob = new CronJob(
      config.cron_expr,
      () => this.executeJob(config),
      null,
      true, // autoStart
      config.timezone || 'Asia/Shanghai'
    );
    this.jobs.set(config.id, cronJob);

    // 记录初始 next_run_at
    const firstNext = cronJob.nextDate();
    if (firstNext) {
      this.jobService.updateNextRun(config.id, firstNext.toJSDate()).catch(err => {
        console.warn(`CronManager: 初始 next_run_at 更新失败 #${config.id}:`, err.message);
      });
    }
  }

  /**
   * 执行任务（含并发守卫和日志记录）
   */
  public async executeJob(config: CronJobConfig): Promise<void> {
    if (this.runningFlags.has(config.id)) {
      console.warn(`CronManager: 任务 #${config.id} "${config.name}" 跳过（正在执行中）`);
      return;
    }

    this.runningFlags.add(config.id);
    const startTime = Date.now();
    let logId: number | null = null;

    try {
      // 记录下次执行时间
      const cronJob = this.jobs.get(config.id);
      if (cronJob) {
        const nextDate = cronJob.nextDate();
        if (nextDate) {
          this.jobService.updateNextRun(config.id, nextDate.toJSDate()).catch(err => {
            console.warn(`CronManager: 更新任务 #${config.id} next_run_at 失败:`, err.message);
          });
        }
      }

      logId = await this.jobService.startLog(config.id);
      console.log(`CronManager: 执行任务 #${config.id} "${config.name}"`);

      // 分支：script 类型任务直接执行 SQL，不走 Agent
      if (config.task_type === 'script') {
        await this.executeScriptJob(config, logId);
        return;
      }

      const result = await this.cronExecutor.execute(
        config.id,
        config.task_description,
        config.timeout_seconds || 300,
        config.output_schema,
      );

      const durationMs = Date.now() - startTime;
      const status = result.error ? 'error'
        : result.stopReason === 'max_iterations' ? 'partial'
        : 'success';

      await this.jobService.completeLog(logId, status,
        result.finalContent || '执行完成',
        result.error || undefined,
        result.structuredResult || null,
        {
          tools_used: result.toolsUsed,
          tool_events: result.toolEvents,
          usage: result.usage,
          stop_reason: result.stopReason,
          duration_ms: durationMs,
        },
      );
      await this.jobService.updateRunResult(config.id, status);
      console.log(`CronManager: 任务 #${config.id} "${config.name}" ${status}（${durationMs}ms）`);
    } catch (error: any) {
      console.error(`CronManager: 任务 #${config.id} "${config.name}" 执行失败:`, error.message);

      if (logId !== null) {
        await this.jobService.completeLog(logId, 'error', `执行失败`, error.message, {
          error_trace: error.stack,
        });
      }
      await this.jobService.updateRunResult(config.id, 'error');
    } finally {
      this.runningFlags.delete(config.id);
    }
  }

  /**
   * 执行 script 类型任务（直接执行 SQL，不走 AI Agent）
   */
  private async executeScriptJob(config: CronJobConfig, logId: number): Promise<void> {
    if (!config.script_id) throw new Error(`任务 #${config.id} 没有绑定脚本`);
    const { scriptService } = await import('./script-service');
    const script = await scriptService.getScriptById(config.script_id!);
    if (!script) throw new Error(`脚本 #${config.script_id} 不存在`);

    let result: { success: boolean; columns?: string[]; rows?: any[]; rowCount?: number; duration_ms?: number; error?: string };

    if (config.target_instance_id) {
      // Per Pitfall 3: Set timeout guard before execution
      const timeoutMs = (config.timeout_seconds || 300) * 1000;
      const preparedSql = script.content;
      // For MySQL: prefix with SET max_execution_time
      let timeoutSql = '';
      if (script.target_db_type === 'mysql') {
        timeoutSql = `SET SESSION max_execution_time = ${timeoutMs};\n`;
      }
      const execSql = timeoutSql + preparedSql;
      result = await sqlExecutor.executeSql(config.target_instance_id, execSql);
    } else {
      // Per Pitfall 4: Execute against Slide's own MySQL DB (no target instance)
      result = await this.executeInternalSql(script.content);
    }

    // Unified structured_result format matching agent mode
    const structuredResult = {
      success: result.success,
      rowCount: result.rowCount ?? 0,
      columns: result.columns ?? [],
      duration_ms: result.duration_ms ?? 0,
      error: result.error ?? null,
    };

    const status = result.success ? 'success' : 'error';

    await this.jobService.completeLog(
      logId, status,
      result.success ? `Script executed: ${result.rowCount} rows in ${result.duration_ms}ms`
                    : `Script failed: ${result.error}`,
      result.error || undefined,
      structuredResult,
      { duration_ms: result.duration_ms ?? 0 },
    );

    await this.jobService.updateRunResult(config.id, status);
  }

  /**
   * 对 Slide 自身 MySQL DB 执行 SQL（target_instance_id 为 null 时使用）
   */
  private async executeInternalSql(sql: string): Promise<{
    success: boolean; columns?: string[]; rows?: any[]; rowCount?: number; duration_ms?: number; error?: string;
  }> {
    const startTime = Date.now();
    try {
      const pool = dbConnection.getPool();
      if (!pool) return { success: false, error: '数据库未连接', duration_ms: Date.now() - startTime };
      const [rows] = await pool.execute(sql) as any;
      return {
        success: true,
        columns: rows.length > 0 ? Object.keys(rows[0]) : [],
        rows,
        rowCount: Array.isArray(rows) ? rows.length : 0,
        duration_ms: Date.now() - startTime,
      };
    } catch (err: any) {
      return { success: false, error: err.message, duration_ms: Date.now() - startTime };
    }
  }

  /**
   * 获取当前任务状态摘要
   */
  getStatus(): { running: boolean; scheduledJobs: number } {
    return {
      running: this.running,
      scheduledJobs: this.jobs.size,
    };
  }
}
