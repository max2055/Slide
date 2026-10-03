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
import { randomUUID } from 'node:crypto';
import type { JobExecutionContext } from '../workflows/worker-runtime.js';
import { cronRunStore, type CronRun, type CronCompletion } from './cron-run-store.js';
import { validateBinding } from './script-policy.js';
import { executeControlSql } from './control-sql-executor.js';
import type { ActorContext } from '../auth/actor-context.js';
import { actorContextService } from '../auth/actor-context.js';
import { cronAuthorityService, CRON_MAINTENANCE_HANDLERS } from './cron-authority.js';
import { hasUnrestrictedInstanceAccess } from '../auth/require-instance-access.js';
import { hasPermission } from '../auth/require-permission.js';

export interface WorkflowEnqueuer { enqueue(input: { id: string; type: string; schemaVersion: number; payload: Record<string, unknown>; idempotencyKey: string; maxAttempts?: number; availableAt?: Date }): Promise<void>; }

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
  private pendingSettlements = new Map<number, Promise<void>>();

  constructor(
    jobService: CronJobDatabaseService,
    cronExecutor: CronExecutor,
    private readonly workflow?: WorkflowEnqueuer,
    private readonly typedHandler?: (type: string, payload: Record<string, unknown>, runId: string, context?: JobExecutionContext) => Promise<CronCompletion | undefined>,
    private readonly assertOwned: () => Promise<void> = async () => {},
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
    await this.assertOwned();
    await cronRunStore.recover();
    await this.jobService.ensureSeedData();
    await this.assertOwned();
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
      await this.assertOwned();
      if (!this.running) return;

      for (const config of enabledJobs) {
        this.scheduleJob(config);
      }

      console.log(`CronManager: ${enabledJobs.length} 个任务已调度`);
    } catch (error) {
      console.error('CronManager 重载失败:', error);
      throw error;
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
      () => this.triggerJob(config, undefined, `scheduled:${Math.floor(Date.now() / 1000)}`).then(() => {}).catch(error => console.error('Cron enqueue failed:', error.message)),
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

  async triggerJob(config: CronJobConfig, trigger?: ActorContext, key: string = randomUUID(), params: unknown = {}): Promise<CronRun> {
    await this.assertOwned();
    return cronRunStore.enqueue(config.id, trigger?.userId ?? null, key, params, config.output_schema);
  }

  async executeRun(runId: string, context?: JobExecutionContext): Promise<void> {
    context?.signal.throwIfAborted();
    const run = await cronRunStore.get(runId);
    if (!run || run.status !== 'queued') return;
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('CRON_RUN_STORE_UNAVAILABLE');
    const lock = await pool.getConnection();
    const lockName = `slide:cron:${run.jobId}`;
    try {
      const [rows] = await lock.query<any[]>('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
      if (!rows[0].acquired || this.runningFlags.has(run.jobId)) {
        if (await cronRunStore.start(runId)) await cronRunStore.finish(runId, 'cancelled', 'CRON_JOB_BUSY');
        return;
      }
      if (!await cronRunStore.start(runId)) return;
      const config = await this.jobService.getJobById(run.jobId);
      if (!config) { await cronRunStore.finish(runId, 'failed', 'CRON_JOB_DELETED'); return; }
      config.output_schema = run.outputSchema;
      const trigger = run.triggeredBy === null ? undefined : await actorContextService.loadActiveActor(run.triggeredBy, undefined, `cron:${runId}`);
      await this.executeJob(config, trigger, runId, context);
    } catch (error: any) {
      await cronRunStore.finish(runId, 'failed', error.message);
      throw error;
    } finally {
      const release = async () => { try { await lock.query('SELECT RELEASE_LOCK(?)', [lockName]); } finally { lock.release(); } };
      const pending = this.pendingSettlements.get(run.jobId);
      if (pending) await pending;
      await release();
    }
  }

  /**
   * 执行任务（含并发守卫和日志记录）
   */
  public async executeJob(config: CronJobConfig, trigger?: ActorContext, runId?: string, context?: JobExecutionContext): Promise<void> {
    if (this.runningFlags.has(config.id)) {
      console.warn(`CronManager: 任务 #${config.id} "${config.name}" 跳过（正在执行中）`);
      return;
    }

    this.runningFlags.add(config.id);
    const startTime = Date.now();
    let logId: number | null = null;
    let executionSettled: Promise<void> | undefined;

    try {
      const current = await this.jobService.getJobById(config.id);
      if (!current) throw new Error('CRON_JOB_DELETED');
      config = runId ? { ...current, output_schema: config.output_schema } : current;
      if (!trigger && config.enabled === false) {
        if (runId) await cronRunStore.finish(runId, 'cancelled', 'CRON_JOB_DISABLED');
        return;
      }
      logId = await this.jobService.startLog(config.id);
      if (runId) await cronRunStore.bindLog(runId, logId);
      // Keep the attempted trigger/subject even when authorization later fails.
      if (!await this.jobService.recordExecutionAuthority(logId, {
        phase: 'authorization-pending', principal_type: config.principal_type ?? 'user',
        owner_user_id: config.owner_user_id ?? null, triggered_by: trigger?.userId ?? null,
        resource_scope: config.resource_scope ?? null,
      })) throw new Error('CRON_AUDIT_UNAVAILABLE');
      if (config.handler_key) {
        if (config.principal_type !== 'system-maintenance' || config.identity_status !== 'bound'
          || !CRON_MAINTENANCE_HANDLERS.has(config.handler_key)) throw new Error('CRON_MAINTENANCE_DENIED');
        if (trigger) {
          const actor = await actorContextService.revalidateActor(trigger);
          if (!hasUnrestrictedInstanceAccess(actor) || !hasPermission(new Set(actor.permissions), 'cron:manage')) throw new Error('CRON_TRIGGER_SCOPE_DENIED');
        }
        if (!await this.jobService.recordExecutionAuthority(logId, { principal_type: 'system-maintenance',
          capability: config.handler_key, triggered_by: trigger?.userId ?? null })) throw new Error('CRON_AUDIT_UNAVAILABLE');
        if (runId) {
          if (!this.typedHandler) throw new Error('WORKFLOW_RUNTIME_UNAVAILABLE');
          const completion = await this.typedHandler(config.handler_key, { cronJobId: config.id, runId }, runId, context);
          context?.signal.throwIfAborted();
          if (!completion) {
            await cronRunStore.finish(runId, 'unknown', 'CRON_COMPLETION_MISSING');
            await this.jobService.completeLog(logId, 'unknown', 'Maintenance handler returned without business evidence');
            await this.jobService.updateRunResult(config.id, 'unknown');
            return;
          }
          const status = completion.status === 'failure' ? 'failed' : completion.status;
          await cronRunStore.saveCompletion(runId, completion);
          await this.jobService.completeLog(logId, status === 'failed' ? 'error' : status, completion.summary, undefined, { ...completion });
          await cronRunStore.finish(runId, status);
          await this.jobService.updateRunResult(config.id, status === 'failed' ? 'error' : status);
        } else {
          if (!this.workflow) throw new Error('WORKFLOW_RUNTIME_UNAVAILABLE');
          const occurrence = new Date().toISOString().slice(0, 16);
          await this.workflow.enqueue({ id: randomUUID(), type: config.handler_key, schemaVersion: 1,
            payload: { cronJobId: config.id, occurrence }, idempotencyKey: `cron:${config.id}:${occurrence}`,
            maxAttempts: Math.max(1, config.retry_count + 1) });
          await this.jobService.completeLog(logId, 'partial', 'Maintenance handler enqueued; business outcome unknown');
          await this.jobService.updateRunResult(config.id, 'partial');
        }
        return;
      }
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

      // Keep the pinned-script validation ahead of identity checks for legacy
      // diagnostics, without executing either path until both gates succeed.
      if (config.task_type === 'script') validateBinding(config.script_binding, config.script_id!, config.target_instance_id);
      const authority = await cronAuthorityService.authorize(config, trigger);
      if (!await this.jobService.recordExecutionAuthority(logId, authority.audit)) throw new Error('CRON_AUDIT_UNAVAILABLE');
      console.log(`CronManager: 执行任务 #${config.id} "${config.name}"`);

      // 分支：script 类型任务直接执行 SQL，不走 Agent
      if (config.task_type === 'script') {
        await this.executeScriptJob(config, logId, () => authority.refreshActor(), runId);
        return;
      }

      const result = await this.cronExecutor.execute(
        config.id,
        config.task_description,
        config.timeout_seconds || 300,
        config.output_schema,
        authority,
        runId ? { runId, signal: context?.signal, save: completion => cronRunStore.saveCompletion(runId, completion) } : undefined,
      );

      executionSettled = result.executionSettled;
      if (executionSettled) this.pendingSettlements.set(config.id, executionSettled);
      const durationMs = Date.now() - startTime;
      const legacyStatus = result.resolution?.kind === 'timed_out' || ['timeout', 'timed_out'].includes(result.stopReason) ? 'timeout'
        : result.resolution?.kind === 'partial' || result.stopReason === 'max_iterations' ? 'partial'
        : result.error || result.stopReason !== 'completed' ? 'error'
        : 'success';
      const businessStatus = result.businessStatus ?? (legacyStatus === 'success' ? 'unknown' : legacyStatus === 'partial' ? 'partial' : 'failed');
      const status = businessStatus === 'failed' ? 'error' : businessStatus === 'unknown' ? (legacyStatus === 'timeout' ? 'timeout' : 'unknown') : businessStatus;

      await this.jobService.completeLog(logId, status,
        result.finalContent || '执行完成',
        result.error || undefined,
        result.structuredResult || null,
        {
          tools_used: result.toolsUsed,
          tool_events: result.toolEvents,
          usage: result.usage,
          stop_reason: result.stopReason,
          partial_trace: result.cancellationPending
            ? JSON.stringify({ cancellation_pending: true, outcome: 'unknown', scheduling: 'blocked_until_settled' })
            : undefined,
          duration_ms: durationMs,
        },
      );
      if (runId) await cronRunStore.finish(runId, businessStatus, !result.structuredResult ? result.error || 'CRON_COMPLETION_MISSING' : undefined);
      await this.jobService.updateRunResult(config.id, status);
      console.log(`CronManager: 任务 #${config.id} "${config.name}" ${status}（${durationMs}ms）`);
    } catch (error: any) {
      console.error(`CronManager: 任务 #${config.id} "${config.name}" 执行失败:`, error.message);

      if (logId !== null) {
        await this.jobService.completeLog(logId, 'error', `执行失败`, error.message, {
          error_trace: error.stack,
        });
      }
      if (runId) await cronRunStore.finish(runId, 'failed', error.message);
      await this.jobService.updateRunResult(config.id, 'error');
      if (trigger) throw error;
    } finally {
      // Reporting a timeout must not release ownership of an in-flight operation.
      // Do not await here: non-cooperative operations must not hang the caller/logging.
      if (executionSettled) {
        void executionSettled.then(() => { this.runningFlags.delete(config.id); this.pendingSettlements.delete(config.id); });
      } else {
        this.runningFlags.delete(config.id);
      }
    }
  }

  /**
   * 执行 script 类型任务（直接执行 SQL，不走 AI Agent）
   */
  private async executeScriptJob(config: CronJobConfig, logId: number, revalidate: () => Promise<ActorContext>, runId?: string): Promise<void> {
    if (!config.script_id) throw new Error(`任务 #${config.id} 没有绑定脚本`);
    const binding = validateBinding(config.script_binding, config.script_id, config.target_instance_id);
    const audit = { script_id: binding.scriptId, sha256: binding.sha256, capability: binding.capability, authorized_by: binding.authorizedBy };
    if (!await this.jobService.recordScriptAuthorization(logId, audit)) {
      throw new Error('CRON_AUDIT_UNAVAILABLE');
    }

    await revalidate();
    let result: { success: boolean; columns?: string[]; rows?: any[]; rowCount?: number; duration_ms?: number; error?: string };

    if (config.target_instance_id !== null) {
      // Per Pitfall 3: Set timeout guard before execution
      const timeoutMs = (config.timeout_seconds || 300) * 1000;
      result = await sqlExecutor.executeSql(config.target_instance_id, binding.content, {
        timeoutMs,
      });
    } else {
      const pool = dbConnection.getPool();
      if (!pool) throw new Error('数据库未连接');
      result = await executeControlSql(pool, binding, config.timeout_seconds, logId);
    }

    // Unified structured_result format matching agent mode
    const structuredResult = {
      ...audit,
      success: result.success,
      rowCount: result.rowCount ?? 0,
      columns: result.columns ?? [],
      duration_ms: result.duration_ms ?? 0,
      error: result.error ?? null,
    };

    if (runId) {
      await cronRunStore.saveCompletion(runId, { status: result.success ? 'success' : 'failure', summary: result.success ? 'Script completed' : 'Script failed', result: structuredResult });
      await cronRunStore.finish(runId, result.success ? 'success' : 'failed');
    }
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
   * 获取当前任务状态摘要
   */
  getStatus(): { running: boolean; scheduledJobs: number } {
    return {
      running: this.running,
      scheduledJobs: this.jobs.size,
    };
  }
}
