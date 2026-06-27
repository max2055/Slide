/**
 * Cron 任务配置模块类型定义
 */

/** 任务状态 */
export type CronJobStatus = 'success' | 'error' | 'running' | 'skipped' | 'timeout' | 'partial';

/** cron_jobs 表映射 */
export interface CronJobConfig {
  id: number;
  name: string;
  task_description: string;
  output_schema: Record<string, unknown> | null;
  cron_expr: string;
  enabled: boolean;
  task_type: 'script' | 'agent';
  script_id: number | null;
  target_instance_id: number | null;
  timezone: string;
  description: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_result: string | null;
  timeout_seconds: number;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

/** cron_job_logs 表映射 */
export interface CronJobLog {
  id: number;
  job_id: number;
  started_at: string;
  finished_at: string | null;
  status: CronJobStatus;
  result_summary: string | null;
  error_message: string | null;
  result: string | null;
  structured_result: Record<string, unknown> | null;
  tools_used: string[] | null;
  tool_events: any[] | null;
  usage: Record<string, number> | null;
  stop_reason: string | null;
  duration_ms: number | null;
  error_trace: string | null;
  partial_trace: string | null;
}

/** cron_job_params 表映射 */
export interface CronJobParam {
  id: number;
  job_id: number;
  param_key: string;
  param_value: string | null;
}

/** cron_scripts 表映射 */
export interface CronScript {
  id: number;
  name: string;
  description: string | null;
  script_type: 'sql' | 'shell';
  content: string;
  target_db_type: 'mysql' | 'postgresql' | 'oracle' | 'dameng' | 'mongodb' | 'redis' | 'elasticsearch';
  created_at: string;
  updated_at: string;
}

/** POST /api/cron/scripts request body */
export interface CreateScriptInput {
  name: string;
  description?: string;
  content: string;
  target_db_type: 'mysql' | 'postgresql' | 'oracle' | 'dameng' | 'mongodb' | 'redis' | 'elasticsearch';
  script_type?: 'sql' | 'shell';
}

/** PUT /api/cron/scripts/:id request body */
export interface UpdateScriptInput {
  name?: string;
  description?: string;
  content?: string;
  target_db_type?: 'mysql' | 'postgresql' | 'oracle' | 'dameng' | 'mongodb' | 'redis' | 'elasticsearch';
  script_type?: 'sql' | 'shell';
}

