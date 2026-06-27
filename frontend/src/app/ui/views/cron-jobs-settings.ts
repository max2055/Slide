/**
 * Cron 任务管理页面
 * 管理定时采集和分析任务的启用/停用、表达式编辑、手动触发和运行日志查看
 */
import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { customElement, state } from "lit/decorators.js";
import "../components/app-dialog.js";
import "../components/app-card.js";
import "../components/app-empty-state.js";
import { authFetch } from "../../../api/index.js";
import { showToast } from "../components/app-toast-container.js";
import "../components/script-editor.js";

interface CronJobConfig {
  id: number;
  name: string;
  task_description: string;
  cron_expr: string;
  enabled: boolean;
  timezone: string;
  description: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_result: string | null;
  timeout_seconds: number;
  task_type?: "script" | "agent";
  script_id?: number | null;
  target_instance_id?: number | null;
}

interface CronJobLog {
  id: number;
  job_id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  result_summary: string | null;
  result: string | null;
  structured_result: Record<string, unknown> | null;
  error_message: string | null;
  duration_ms: number | null;
  stop_reason: string | null;
  error_trace: string | null;
  tools_used: string[] | null;
  tool_events: any[] | null;
  usage: Record<string, number> | null;
}

interface CronScript {
  id: number;
  name: string;
  description: string | null;
  script_type: string;
  content: string;
  target_db_type: string;
}

interface DatabaseInstance {
  id: number;
  name: string;
  db_type: string;
  host: string;
  port: number;
}

const CRON_PRESETS = [
  { label: "每分钟", value: "* * * * *" },
  { label: "每5分钟", value: "*/5 * * * *" },
  { label: "每小时", value: "0 * * * *" },
  { label: "每天（午夜）", value: "0 0 * * *" },
  { label: "每天（08:00）", value: "0 8 * * *" },
];

function formatRelativeTime(isoStr: string | null): string {
  if (!isoStr) return "—";
  const now = Date.now();
  const date = new Date(isoStr).getTime();
  const diffMs = date - now;
  const absDiff = Math.abs(diffMs);
  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (diffMs > 0) {
    if (days > 0) return `${days} 天后`;
    if (hours > 0) return `${hours} 小时后`;
    if (minutes > 0) return `${minutes} 分钟后`;
    return `${seconds} 秒后`;
  }
  if (days > 0) return `${days} 天前`;
  if (hours > 0) return `${hours} 小时前`;
  if (minutes > 0) return `${minutes} 分钟前`;
  return `${seconds} 秒前`;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "运行中";
  const diffMs = new Date(end).getTime() - new Date(start).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    return `${m}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatDateTime(isoStr: string): string {
  const d = new Date(isoStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

type BadgeVariant = "ok" | "danger" | "warn" | "muted";
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  success: "ok",
  error: "danger",
  skipped: "warn",
  running: "muted",
  partial: "warn",
  timeout: "danger",
};
const STATUS_LABEL: Record<string, string> = {
  success: "成功",
  error: "失败",
  skipped: "跳过",
  running: "运行中",
  partial: "部分",
  timeout: "超时",
  na: "未执行",
};

@customElement("cron-jobs-settings")
export class CronJobsSettings extends LitElement {
  @state() private jobs: CronJobConfig[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;

  @state() private showCreateDialog = false;
  @state() private editingJob: CronJobConfig | null = null;
  @state() private formName = "";
  @state() private formDescription = "";
  @state() private formTaskDescription = "";
  @state() private formCronExpr = "";
  @state() private formEnabled = true;
  @state() private formSaving = false;
  @state() private formError: string | null = null;

  @state() private deleteConfirmJob: CronJobConfig | null = null;
  @state() private deleteConfirmOpen = false;
  @state() private deleteDeleting = false;

  @state() private logViewerJob: CronJobConfig | null = null;
  @state() private viewerLogs: CronJobLog[] = [];
  @state() private viewerLoading = false;
  @state() private viewerError: string | null = null;

  @state() private triggerDialogOpen = false;
  @state() private triggerJobId: number | null = null;
  @state() private triggerJobName: string | null = null;
  @state() private triggerError: string | null = null;
  @state() private triggerRunning = false;

  @state() private pollingJobIds = new Set<number>();
  private _pollInterval: ReturnType<typeof setInterval> | null = null;

  @state() private formTaskType: "agent" | "script" = "agent";
  @state() private formScriptId: number | null = null;
  @state() private formTargetInstanceId: number | null = null;
  @state() private scripts: CronScript[] = [];
  @state() private instances: DatabaseInstance[] = [];
  @state() private scriptEditorContent = "";
  @state() private scriptEditorDbType = "mysql";
  @state() private selectedScriptTemplate: CronScript | null = null;
  @state() private testResult: string | null = null;
  @state() private testRunning = false;

  static styles = [sharedBtnStyles, css`
    :host { display: block; }
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    .page-header h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: var(--text-strong); }
    .page-header p { font-size: 13px; color: var(--muted); margin: 0; }
    .loading { padding: 40px; text-align: center; color: var(--muted); font-size: 13px; }
    .error-state { padding: 40px; text-align: center; }
    .error-state h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: var(--text); }
    .error-state p { font-size: 12px; color: var(--muted); margin: 0 0 16px; }

    .table-head { display: flex; width: 100%; border-bottom: 1px solid var(--border); background: var(--bg-elevated); }
    .table-head-cell { padding: 8px 10px; font-weight: 600; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    .table-row { display: flex; width: 100%; border-bottom: 1px solid var(--border); transition: background 0.15s; }
    .table-row:hover { background: var(--bg-elevated, rgba(255,255,255,0.03)); }
    .table-cell { padding: 10px; display: flex; align-items: center; gap: 6px; overflow: hidden; }
    .cell-status { width: 48px; justify-content: center; }
    .cell-name { flex: 1; min-width: 0; }
    .cell-desc { flex: 2; min-width: 0; }
    .cell-expr { width: 180px; min-width: 180px; }
    .cell-next { width: 150px; min-width: 150px; }
    .cell-last { width: 150px; min-width: 150px; }
    .cell-result { width: 100px; min-width: 100px; }
    .cell-actions { width: 150px; min-width: 150px; justify-content: flex-end; gap: 4px; flex-shrink: 0; overflow: visible; }
    .job-name { font-weight: 600; color: var(--text); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; user-select: none; }
    .job-name:hover { color: var(--accent); }
    .job-name--disabled { color: var(--muted); }
    .job-desc { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cron-text { font-family: var(--mono, monospace); font-size: 11px; color: var(--text); cursor: pointer; white-space: nowrap; }
    .cron-text:hover { color: var(--accent); }
    .relative-time { font-size: 11px; color: var(--muted); white-space: nowrap; }



    .log-dialog { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); width: 900px; max-width: 95vw; max-height: 85vh; overflow-y: auto; box-shadow: var(--shadow-lg); animation: dialog-in 0.2s ease; display: flex; flex-direction: column; }
    .log-dialog-body { padding: 16px 20px 20px; overflow-y: auto; flex: 1; }
    .log-entry { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; margin-bottom: 12px; }
    .log-entry:last-child { margin-bottom: 0; }
    .log-entry__header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .log-entry__time { font-size: 12px; color: var(--muted); flex: 1; }
    .log-entry__duration { font-size: 12px; color: var(--muted); font-family: var(--mono, monospace); }
    .log-entry__error { font-size: 12px; color: var(--danger); background: var(--danger-subtle); padding: 8px 10px; border-radius: var(--radius-sm); margin-bottom: 8px; white-space: pre-wrap; word-break: break-word; }
    .log-entry__result { font-size: 12px; color: var(--text); background: var(--bg-elevated); padding: 10px 12px; border-radius: var(--radius-sm); margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; font-family: var(--font-body); line-height: 1.6; }
    .log-entry__summary { font-size: 13px; color: var(--text); line-height: 1.5; }
    .log-empty { text-align: center; padding: 40px 20px; color: var(--muted); font-size: 13px; }

    .sr-card { margin-bottom: 8px; }
    .sr-stats { display: flex; gap: 10px; margin-bottom: 10px; }
    .sr-stat { flex: 1; text-align: center; padding: 8px 4px; background: var(--bg-elevated); border-radius: var(--radius-sm); }
    .sr-stat.ok { background: var(--ok-subtle); }
    .sr-stat.warn { background: var(--warn-subtle); }
    .sr-stat.danger { background: var(--danger-subtle); }
    .sr-stat-value { display: block; font-size: 18px; font-weight: 700; color: var(--text-strong); }
    .sr-stat.ok .sr-stat-value { color: var(--ok); }
    .sr-stat.warn .sr-stat-value { color: var(--warn); }
    .sr-stat.danger .sr-stat-value { color: var(--danger); }
    .sr-stat-label { display: block; font-size: 10px; color: var(--muted); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.04em; }
    .sr-failures { border-top: 1px solid var(--border); padding-top: 8px; }
    .sr-failures-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; display: block; margin-bottom: 6px; }
    .sr-failure-item { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; }
    .sr-failure-instance { font-weight: 500; color: var(--text); min-width: 100px; }
    .sr-failure-reason { color: var(--muted); }

    /* Tool execution trace */
    .tool-trace { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 10px; }
    .tool-trace__header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .tool-trace__title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .tool-trace__count { font-size: 11px; color: var(--muted); }
    .tool-trace__usage { font-size: 11px; color: var(--muted); font-family: var(--mono, monospace); margin-left: auto; }
    .tool-trace__list { display: flex; flex-direction: column; gap: 4px; }
    .tool-trace__item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: var(--bg-elevated); border-radius: var(--radius-sm); font-size: 12px; }
    .tool-trace__item--error { background: var(--danger-subtle, rgba(220,38,38,0.08)); }
    .tool-trace__index { font-size: 10px; color: var(--muted); font-family: var(--mono, monospace); min-width: 18px; text-align: right; }
    .tool-trace__name { font-weight: 500; color: var(--text); font-family: var(--mono, monospace); }
    .tool-trace__args { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-family: var(--mono, monospace); font-size: 11px; }
    .tool-trace__error-tag { font-size: 10px; color: var(--danger); background: var(--danger-subtle, rgba(220,38,38,0.12)); padding: 1px 6px; border-radius: var(--radius-sm); font-weight: 600; }

    .form-group { display: flex; flex-direction: column; gap: 4px; }
    .form-label { font-size: var(--text-sm); font-weight: 600; color: var(--text); }
    .form-input { width: 100%; padding: var(--space-sm) var(--space-md); font-size: var(--text-base); font-family: inherit; color: var(--text); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); outline: none; box-sizing: border-box; transition: border-color 0.15s; }
    .form-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
    .form-input::placeholder { color: var(--muted); }
    .form-textarea { min-height: 80px; line-height: 1.5; resize: vertical; max-height: 240px; }
    .form-mono { font-family: var(--mono, monospace); font-size: var(--text-sm); }
    .form-hint { font-size: var(--text-xs); color: var(--muted); }
    .cron-presets { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .cron-preset-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; font-size: 11px; font-family: inherit; color: var(--muted); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; transition: all 0.15s; }
    .cron-preset-chip:hover { color: var(--text); border-color: var(--accent); }
    .cron-preset-chip.active { color: var(--accent-foreground, #fff); background: var(--accent); border-color: var(--accent); }
    .cron-preset-expr { font-family: var(--mono, monospace); font-size: 10px; opacity: 0.7; }


  `];

  override connectedCallback() {
    super.connectedCallback();
    this.loadCronJobs();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  private async loadCronJobs() {
    this.loading = true;
    this.error = null;
    try {
      const res = await authFetch("/api/cron/jobs");
      if (!res.ok) throw new Error(`加载失败 (${res.status})`);
      this.jobs = await res.json();
    } catch (e: any) {
      this.error = e.message || "加载定时任务失败";
    } finally {
      this.loading = false;
    }
  }

  private async toggleJob(job: CronJobConfig) {
    const newEnabled = !job.enabled;
    const prevEnabled = job.enabled;
    job.enabled = newEnabled;
    this.jobs = [...this.jobs];
    this.requestUpdate();
    try {
      const res = await authFetch(`/api/cron/jobs/${job.id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newEnabled }),
      });
      if (!res.ok) throw new Error("更新失败");
    } catch (e: any) {
      job.enabled = prevEnabled;
      this.jobs = [...this.jobs];
      this.requestUpdate();
      showToast("更新任务状态失败", "error");
    }
  }

  private async openCreateDialog() {
    this.formName = "";
    this.formDescription = "";
    this.formTaskDescription = "";
    this.formCronExpr = "0 * * * *";
    this.formEnabled = true;
    this.formSaving = false;
    this.formError = null;
    this.editingJob = null;
    this.formTaskType = "agent";
    this.formScriptId = null;
    this.formTargetInstanceId = null;
    this.scriptEditorContent = "";
    this.selectedScriptTemplate = null;
    this.testResult = null;
    this.showCreateDialog = true;
    // Fetch scripts and instances in background
    this.loadScriptsAndInstances();
  }

  private async loadScriptsAndInstances() {
    try {
      const [scriptsRes, instancesRes] = await Promise.all([
        authFetch("/api/cron/scripts"),
        authFetch("/api/database/instances"),
      ]);
      if (scriptsRes.ok) this.scripts = await scriptsRes.json();
      if (instancesRes.ok) this.instances = await instancesRes.json();
    } catch {
      // Swallow — user can still use agent mode
    }
  }

  private openEditDialog(job: CronJobConfig) {
    this.formName = job.name;
    this.formDescription = job.description || "";
    this.formTaskDescription = job.task_description;
    this.formCronExpr = job.cron_expr;
    this.formEnabled = job.enabled;
    this.formSaving = false;
    this.formError = null;
    this.editingJob = job;
    this.formTaskType = job.task_type || "agent";
    this.formScriptId = job.script_id ?? null;
    this.formTargetInstanceId = job.target_instance_id ?? null;
    this.selectedScriptTemplate = null;
    this.testResult = null;
    this.showCreateDialog = true;
    // Load scripts/instances and try to populate editor content
    this.loadScriptsAndInstances().then(() => {
      if (this.formTaskType === "script" && this.formScriptId) {
        const tmpl = this.scripts.find((s) => s.id === this.formScriptId);
        if (tmpl) {
          this.scriptEditorContent = tmpl.content;
          this.scriptEditorDbType = tmpl.target_db_type;
          this.selectedScriptTemplate = tmpl;
        }
      }
    });
  }

  private closeFormDialog() {
    this.showCreateDialog = false;
    this.editingJob = null;
    this.formName = "";
    this.formTaskDescription = "";
    this.formError = null;
    this.formTaskType = "agent";
    this.formScriptId = null;
    this.formTargetInstanceId = null;
    this.scriptEditorContent = "";
    this.selectedScriptTemplate = null;
    this.testResult = null;
  }

  private async saveTask() {
    if (!this.formName.trim()) { this.formError = "任务名称不能为空"; return; }
    if (this.formTaskType === "agent" && this.formTaskDescription.trim().length < 10) { this.formError = "任务内容至少需要10个字符"; return; }
    if (this.formTaskType === "script") {
      if (!this.scriptEditorContent.trim()) { this.formError = "SQL 脚本内容不能为空"; return; }
      if (!this.formTargetInstanceId) { this.formError = "请选择目标实例"; return; }
    }
    this.formSaving = true;
    this.formError = null;
    try {
      let scriptId = this.formScriptId;
      // For custom SQL (no template selected), create script first
      if (this.formTaskType === "script" && !scriptId && this.scriptEditorContent.trim()) {
        const scriptRes = await authFetch("/api/cron/scripts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: this.formName + " (custom)",
            description: this.formDescription || "Custom SQL script for cron job",
            script_type: "sql",
            content: this.scriptEditorContent,
            target_db_type: this.scriptEditorDbType,
          }),
        });
        if (!scriptRes.ok) { const errBody = await scriptRes.json().catch(() => ({})); throw new Error(errBody.error || "创建脚本失败"); }
        const newScript = await scriptRes.json();
        scriptId = newScript.id;
      }

      const body: Record<string, unknown> = {
        name: this.formName,
        description: this.formDescription,
        cron_expr: this.formCronExpr,
        enabled: this.formEnabled,
      };
      if (this.formTaskType === "agent") {
        body.task_description = this.formTaskDescription;
      } else {
        body.task_type = "script";
        body.task_description = this.scriptEditorContent;
        body.script_id = scriptId;
        body.target_instance_id = this.formTargetInstanceId;
      }

      const isEdit = !!this.editingJob;
      const url = isEdit ? `/api/cron/jobs/${this.editingJob.id}` : "/api/cron/jobs";
      const res = await authFetch(url, { method: isEdit ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { const errBody = await res.json().catch(() => ({})); throw new Error(errBody.error || "保存失败"); }
      this.closeFormDialog();
      this.loadCronJobs();
      showToast(isEdit ? "更新成功" : "创建成功");
    } catch (e: any) {
      this.formError = e.message || "保存失败";
      this.formSaving = false;
    }
  }

  private onNameInput(e: Event) { this.formName = (e.target as HTMLInputElement).value; }
  private onDescInput(e: Event) { this.formDescription = (e.target as HTMLInputElement).value; }
  private onTaskDescInput(e: Event) { this.formTaskDescription = (e.target as HTMLInputElement).value; }
  private onCronExprInput(e: Event) { this.formCronExpr = (e.target as HTMLInputElement).value; }

  private onTaskTypeChange(e: Event) {
    this.formTaskType = (e.target as HTMLSelectElement).value as "agent" | "script";
  }

  private onScriptTemplateChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const id = parseInt(select.value, 10);
    if (!id) {
      this.selectedScriptTemplate = null;
      this.formScriptId = null;
      return;
    }
    const tmpl = this.scripts.find((s) => s.id === id);
    if (tmpl) {
      this.selectedScriptTemplate = tmpl;
      this.formScriptId = tmpl.id;
      this.scriptEditorContent = tmpl.content;
      this.scriptEditorDbType = tmpl.target_db_type;
    }
  }

  private onInstanceChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const id = parseInt(select.value, 10);
    this.formTargetInstanceId = id || null;
    const inst = this.instances.find((i) => i.id === id);
    if (inst) {
      this.scriptEditorDbType = inst.db_type;
    }
  }

  private onScriptEditorChange(e: CustomEvent) {
    this.scriptEditorContent = e.detail.content;
  }

  private async onTestExecute() {
    if (!this.formScriptId || !this.formTargetInstanceId) return;
    this.testRunning = true;
    this.testResult = null;
    try {
      const res = await authFetch(`/api/cron/scripts/${this.formScriptId}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: this.formTargetInstanceId }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || "测试执行失败");
      }
      const data = await res.json();
      this.testResult = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    } catch (e: any) {
      this.testResult = `错误：${e.message || "未知错误"}`;
    } finally {
      this.testRunning = false;
    }
  }

  private confirmDelete(job: CronJobConfig) { this.deleteConfirmJob = job; this.deleteConfirmOpen = true; }
  private closeDeleteConfirm() { this.deleteConfirmOpen = false; this.deleteConfirmJob = null; this.deleteDeleting = false; }

  private async executeDelete() {
    if (!this.deleteConfirmJob) return;
    this.deleteDeleting = true;
    try {
      const res = await authFetch(`/api/cron/jobs/${this.deleteConfirmJob.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "删除失败");
      this.closeDeleteConfirm();
      showToast("已删除");
      this.loadCronJobs();
    } catch (e: any) {
      showToast(`删除失败：${e.message || "未知错误"}`, "error");
      this.deleteDeleting = false;
    }
  }

  private openTriggerDialog(job: CronJobConfig) {
    this.triggerDialogOpen = true; this.triggerJobId = job.id; this.triggerJobName = job.name;
    this.triggerError = null; this.triggerRunning = false;
  }

  private closeTriggerDialog() {
    this.triggerDialogOpen = false; this.triggerJobId = null;
    this.triggerJobName = null; this.triggerError = null; this.triggerRunning = false;
  }

  private async confirmTrigger() {
    if (this.triggerJobId === null) return;
    this.triggerRunning = true; this.triggerError = null;
    try {
      const res = await authFetch(`/api/cron/jobs/${this.triggerJobId}/run`, { method: "POST" });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || "触发失败"); }
      this.closeTriggerDialog();
      showToast("已触发执行");
      this.pollJobStatus(this.triggerJobId);
    } catch (e: any) {
      this.triggerError = e.message || "触发失败";
    } finally {
      this.triggerRunning = false;
    }
  }

  private pollJobStatus(jobId: number) {
    if (this.pollingJobIds.has(jobId)) return;
    this.pollingJobIds = new Set(this.pollingJobIds).add(jobId);
    let attempts = 0;
    const maxAttempts = 10;
    this._pollInterval = setInterval(async () => {
      attempts++;
      try {
        const res = await authFetch(`/api/cron/jobs/${jobId}/logs?limit=1`);
        if (res.ok) {
          const { logs } = await res.json() as { logs: CronJobLog[] };
          if (logs.length > 0 && logs[0].status !== "running") {
            clearInterval(this._pollInterval!);
            this._pollInterval = null;
            const next = new Set(this.pollingJobIds); next.delete(jobId); this.pollingJobIds = next;
            this.loadCronJobs();
            return;
          }
        }
      } catch { /* continue polling */ }
      if (attempts >= maxAttempts) { clearInterval(this._pollInterval!); this._pollInterval = null; const next = new Set(this.pollingJobIds); next.delete(jobId); this.pollingJobIds = next; }
    }, 3000);
  }

  private async openLogViewer(job: CronJobConfig) {
    this.logViewerJob = job; this.viewerLogs = []; this.viewerLoading = true; this.viewerError = null;
    try {
      const res = await authFetch(`/api/cron/jobs/${job.id}/logs?limit=200`);
      if (!res.ok) throw new Error("加载日志失败");
      const { logs } = await res.json() as { logs: CronJobLog[] };
      this.viewerLogs = logs || [];
    } catch (e: any) {
      this.viewerError = e.message || "加载日志失败";
    } finally {
      this.viewerLoading = false;
    }
  }

  private closeLogViewer() { this.logViewerJob = null; this.viewerLogs = []; }

  private renderBadge(result: string | null) {
    const key = result || "na";
    return html`<app-badge variant=${STATUS_VARIANT[key] || "muted"}>${STATUS_LABEL[key] || "未执行"}</app-badge>`;
  }

  private renderStructuredResult(sr: Record<string, unknown> | null) {
    if (!sr) return nothing;

    // Script mode format: { success, rowCount, columns, duration_ms, error }
    if ('success' in sr && 'rowCount' in sr) {
      const success = sr.success;
      const rowCount = sr.rowCount as number ?? 0;
      const durationMs = sr.duration_ms as number ?? 0;
      const error = sr.error as string | null;
      const columns = sr.columns as string[] | undefined;
      return html`
        <div class="sr-card">
          <div class="sr-stats">
            <div class="sr-stat ${success ? 'ok' : 'danger'}">
              <span class="sr-stat-value">${success ? '成功' : '失败'}</span>
              <span class="sr-stat-label">状态</span>
            </div>
            <div class="sr-stat">
              <span class="sr-stat-value">${rowCount}</span>
              <span class="sr-stat-label">返回行数</span>
            </div>
            <div class="sr-stat">
              <span class="sr-stat-value">${durationMs}ms</span>
              <span class="sr-stat-label">耗时</span>
            </div>
          </div>
          ${error ? html`<div class="log-entry__error">${error}</div>` : nothing}
          ${columns && columns.length > 0 ? html`
            <div style="font-size:11px;color:var(--muted);margin-top:6px;">列: ${columns.join(', ')}</div>
          ` : nothing}
        </div>
      `;
    }

    // Agent mode format: { instances, failures, coverage_rate }
    const instances = sr.instances as Record<string, unknown> | undefined;
    const failures = sr.failures as Array<Record<string, unknown>> | undefined;
    const cov = typeof sr.coverage_rate === 'number' ? sr.coverage_rate : null;

    return html`
      <div class="sr-card">
        ${instances ? html`
          <div class="sr-stats">
            <div class="sr-stat">
              <span class="sr-stat-value">${instances.total ?? '—'}</span>
              <span class="sr-stat-label">扫描实例</span>
            </div>
            <div class="sr-stat ok">
              <span class="sr-stat-value">${instances.succeeded ?? '—'}</span>
              <span class="sr-stat-label">成功</span>
            </div>
            <div class="sr-stat ${(instances.failed as number) > 0 ? 'danger' : ''}">
              <span class="sr-stat-value">${instances.failed ?? '—'}</span>
              <span class="sr-stat-label">失败</span>
            </div>
            ${cov !== null ? html`
              <div class="sr-stat ${cov < 0.8 ? 'warn' : cov < 0.5 ? 'danger' : 'ok'}">
                <span class="sr-stat-value">${Math.round(cov * 100)}%</span>
                <span class="sr-stat-label">覆盖率</span>
              </div>
            ` : nothing}
          </div>
        ` : nothing}
        ${failures && failures.length > 0 ? html`
          <div class="sr-failures">
            <span class="sr-failures-title">失败详情</span>
            ${failures.map((f: any) => html`
              <div class="sr-failure-item">
                <span class="sr-failure-instance">${f.instance || '?'}</span>
                <span class="sr-failure-reason">${f.reason || '未知'}</span>
              </div>
            `)}
          </div>
        ` : nothing}
        ${!instances ? html`<pre class="log-entry__result">${JSON.stringify(sr, null, 2)}</pre>` : nothing}
      </div>
    `;
  }

  /**
   * Render tool execution trace — shows each tool call with status and detail
   */
  private renderToolTrace(log: CronJobLog) {
    const tools = log.tools_used;
    const events = log.tool_events;
    const usage = log.usage;

    if (!tools?.length && !events?.length) return nothing;

    return html`
      <div class="tool-trace">
        <div class="tool-trace__header">
          <span class="tool-trace__title">执行轨迹</span>
          <span class="tool-trace__count">${tools?.length || 0} 个工具调用</span>
          ${usage ? html`
            <span class="tool-trace__usage">
              tokens: ${usage.total_tokens ?? usage.input_tokens ?? '?'}
              ${usage.duration_ms ? ` · ${Math.round(usage.duration_ms / 1000)}s` : ''}
            </span>
          ` : nothing}
        </div>
        <div class="tool-trace__list">
          ${(events?.length ? events : tools?.map((name: string) => ({ name, status: 'ok', detail: '' }))).map((ev: any, i: number) => {
            const isError = ev.status === 'error';
            return html`
              <div class="tool-trace__item ${isError ? 'tool-trace__item--error' : ''}">
                <span class="tool-trace__index">${i + 1}</span>
                <span class="tool-trace__name">${ev.name || '?'}</span>
                ${ev.detail ? html`
                  <span class="tool-trace__args" title=${typeof ev.detail === 'string' ? ev.detail : JSON.stringify(ev.detail)}>
                    ${typeof ev.detail === 'string' ? ev.detail.slice(0, 120) : JSON.stringify(ev.detail).slice(0, 120)}
                  </span>
                ` : nothing}
                ${isError ? html`<span class="tool-trace__error-tag">错误</span>` : nothing}
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }

  // ── Render ──

  override render() {
    if (this.loading) return html`<div class="loading">加载中...</div>`;
    if (this.error) return html`<div class="error-state"><h3>加载定时任务失败</h3><p>${this.error}</p><button class="btn" @click=${this.loadCronJobs}>重试</button></div>`;
    if (this.jobs.length === 0) return html`<app-empty-state title="暂无定时任务"></app-empty-state>`;

    return html`
      <div class="page-header">
        <div>
          <h1>定时任务</h1>
          <p>管理定时采集和分析任务的调度与监控</p>
        </div>
        <button class="btn-primary" @click=${this.openCreateDialog}>+ 新建任务</button>
      </div>
      <app-card variant="default" style="overflow-x:auto;">
        <div class="table-head">
          <div class="table-head-cell cell-status"></div>
          <div class="table-head-cell cell-name">任务名称</div>
          <div class="table-head-cell cell-mode" style="width:70px;min-width:70px;">模式</div>
          <div class="table-head-cell cell-desc">描述</div>
          <div class="table-head-cell cell-expr">Cron 表达式</div>
          <div class="table-head-cell cell-next">下次执行</div>
          <div class="table-head-cell cell-last">上次执行</div>
          <div class="table-head-cell cell-result">结果</div>
          <div class="table-head-cell cell-actions"></div>
        </div>
        ${this.jobs.map((job) => html`
          <div class="table-row">
            <div class="table-cell cell-status">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${job.enabled ? 'var(--ok)' : 'var(--muted)'}" title=${job.enabled ? "已启用" : "已停用"}></span>
            </div>
            <div class="table-cell cell-name">
              <span class="job-name ${job.enabled ? "" : "job-name--disabled"}"
                @click=${() => this.openLogViewer(job)}
                title="查看执行记录">${job.name}</span>
            </div>
            <div class="table-cell cell-mode" style="width:70px;min-width:70px;">
              ${job.task_type === "script"
                ? html`<app-badge variant="muted">Script</app-badge>`
                : html`<app-badge variant="info">Agent</app-badge>`}
            </div>
            <div class="table-cell cell-desc">
              <span class="job-desc">${job.description || "—"}</span>
            </div>
            <div class="table-cell cell-expr">
              <span class="cron-text" title=${job.task_description ? job.task_description : ""}>${job.cron_expr}</span>
            </div>
            <div class="table-cell cell-next">
              <span class="relative-time">${job.enabled ? formatRelativeTime(job.next_run_at) : '—'}</span>
            </div>
            <div class="table-cell cell-last">
              <span class="relative-time">${formatRelativeTime(job.last_run_at)}</span>
            </div>
            <div class="table-cell cell-result">
              ${this.renderBadge(job.last_result)}
            </div>
            <div class="table-cell cell-actions">
              <app-toggle compact .checked=${job.enabled} @change=${() => this.toggleJob(job)} title=${job.enabled ? "已启用" : "已停用"}></app-toggle>
              <button class="btn-ghost" @click=${() => this.openTriggerDialog(job)}>执行</button>
              <button class="btn-icon" title="编辑" @click=${() => this.openEditDialog(job)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="btn-icon" title="删除" @click=${() => this.confirmDelete(job)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </div>
        `)}
      </app-card>

      <!-- Log Viewer Dialog -->
      ${this.logViewerJob ? html`
        <app-dialog .open=${true} size="xl" title="执行记录 — ${this.logViewerJob.name}" @app-dialog-close=${this.closeLogViewer}>
          ${this.viewerLoading ? html`<div class="log-empty">加载中...</div>` : nothing}
          ${this.viewerError ? html`<div style="font-size:12px;padding:8px 12px;color:var(--danger);background:var(--danger-subtle, rgba(220,38,38,0.08));border-radius:var(--radius-sm);margin-bottom:12px">${this.viewerError}</div>` : nothing}
          ${!this.viewerLoading && !this.viewerError && this.viewerLogs.length === 0 ? html`<div class="log-empty">暂无执行记录</div>` : nothing}
          ${this.viewerLogs.map(log => html`
            <div class="log-entry">
              <div class="log-entry__header">
                ${this.renderBadge(log.status)}
                <span class="log-entry__time">${formatDateTime(log.started_at)}</span>
                <span class="log-entry__duration">耗时 ${formatDuration(log.started_at, log.finished_at)}${log.duration_ms ? ' (' + log.duration_ms + 'ms)' : ''}</span>
              </div>
              ${log.error_message ? html`<div class="log-entry__error">${log.error_message}</div>` : nothing}
              ${this.renderToolTrace(log)}
              ${this.renderStructuredResult(log.structured_result)}
              ${log.result ? html`<pre class="log-entry__result">${log.result}</pre>` : log.result_summary && !log.structured_result ? html`<div class="log-entry__summary">${log.result_summary}</div>` : !log.structured_result ? html`<div class="log-empty" style="padding:8px">无输出</div>` : nothing}
            </div>
          `)}
        </app-dialog>
      ` : nothing}

      <!-- Create/Edit Dialog -->
      ${this.showCreateDialog ? html`
        <app-dialog .open=${true} size="md" title="${this.editingJob ? '编辑任务' : '新建任务'}" @app-dialog-close=${this.closeFormDialog}>
          ${this.formError ? html`<div style="font-size:12px;margin-bottom:12px;padding:8px 12px;color:var(--danger);background:var(--danger-subtle, rgba(220,38,38,0.08));border-radius:var(--radius-sm);">${this.formError}</div>` : nothing}
          <div class="form-group">
            <label class="form-label">任务名称</label>
            <input class="form-input" .value=${this.formName} @input=${this.onNameInput} placeholder="例如：每日慢查询检查" />
          </div>
          <div class="form-group">
            <label class="form-label">描述</label>
            <input class="form-input" .value=${this.formDescription} @input=${this.onDescInput} placeholder="简要描述这个任务的用途" />
          </div>
          <div class="form-group">
            <label class="form-label">执行模式</label>
            <select class="form-input" .value=${this.formTaskType} @change=${this.onTaskTypeChange}>
              <option value="agent">Agent 模式（AI 自然语言驱动）</option>
              <option value="script">Script 模式（SQL 脚本执行）</option>
            </select>
          </div>
          ${this.formTaskType === "agent" ? html`
            <div class="form-group">
              <label class="form-label">任务内容（自然语言）</label>
              <textarea class="form-input form-textarea" .value=${this.formTaskDescription} @input=${this.onTaskDescInput} placeholder="例如：每天早上9点检查生产环境的慢查询并生成摘要报告"></textarea>
              <div class="form-hint">告诉 AI 要做什么，用自然语言描述即可</div>
            </div>
          ` : html`
            <div class="form-group">
              <label class="form-label">SQL 脚本</label>
              <script-editor
                .content=${this.scriptEditorContent}
                .dbType=${this.scriptEditorDbType}
                @content-change=${this.onScriptEditorChange}
              ></script-editor>
            </div>
            <div class="form-group" style="display:flex;flex-direction:row;gap:var(--space-md);align-items:flex-end;">
              <div style="flex:1;">
                <label class="form-label">目标实例</label>
                <select class="form-input" @change=${this.onInstanceChange}>
                  <option value="">— 选择实例 —</option>
                  ${this.instances.map((i) => html`
                    <option value=${i.id} .selected=${this.formTargetInstanceId === i.id}>${i.name} (${i.db_type})</option>
                  `)}
                </select>
              </div>
              ${this.formTargetInstanceId ? html`
                <button class="btn" @click=${this.onTestExecute} ?disabled=${this.testRunning}>
                  ${this.testRunning ? "执行中..." : "测试执行"}
                </button>
              ` : nothing}
            </div>
            ${this.testResult !== null ? html`
              <div class="form-group">
                <label class="form-label">测试结果</label>
                <pre class="log-entry__result" style="max-height:200px;overflow:auto;font-size:11px;">${this.testResult}</pre>
              </div>
            ` : nothing}
          `}
          <div class="form-group">
            <label class="form-label">Cron 表达式</label>
            <input class="form-input form-mono" .value=${this.formCronExpr} @input=${this.onCronExprInput} placeholder="0 9 * * *" />
            <div class="cron-presets">
              ${CRON_PRESETS.map(p => html`
                <button class="cron-preset-chip ${this.formCronExpr === p.value ? 'active' : ''}" @click=${() => { this.formCronExpr = p.value; this.requestUpdate(); }}>
                  ${p.label}<span class="cron-preset-expr">${p.value}</span>
                </button>
              `)}
            </div>
          </div>
          <div class="form-group">
            <app-toggle .checked=${this.formEnabled} @change=${(e: CustomEvent) => { this.formEnabled = e.detail; }}>启用</app-toggle>
          </div>
          <div slot="footer">
            <button class="btn" @click=${this.closeFormDialog} ?disabled=${this.formSaving}>取消</button>
            <button class="btn-primary" @click=${this.saveTask} ?disabled=${this.formSaving}>
              ${this.formSaving ? '保存中...' : this.editingJob ? '保存修改' : '创建任务'}
            </button>
          </div>
        </app-dialog>
      ` : nothing}

      <!-- Delete Confirm Dialog -->
      ${this.deleteConfirmOpen ? html`
        <app-dialog .open=${true} size="sm" title="删除任务" @app-dialog-close=${this.closeDeleteConfirm}>
          ${this.deleteDeleting
            ? html`<p style="color:var(--muted);text-align:center;">正在删除...</p>`
            : html`<p style="margin:0;">确定删除「<strong>${this.deleteConfirmJob?.name || ""}</strong>」吗？此操作不可撤销。</p>`}
          <div slot="footer">
            <button class="btn" @click=${this.closeDeleteConfirm} ?disabled=${this.deleteDeleting}>取消</button>
            <button class="btn-primary" @click=${this.executeDelete} ?disabled=${this.deleteDeleting}>
              ${this.deleteDeleting ? '删除中...' : '确认删除'}
            </button>
          </div>
        </app-dialog>
      ` : nothing}

      <!-- Trigger Confirm Dialog -->
      ${this.triggerDialogOpen ? html`
        <app-dialog .open=${true} size="sm" title="手动触发" @app-dialog-close=${this.closeTriggerDialog}>
          ${this.triggerError ? html`<div style="font-size:12px;margin-bottom:12px;padding:8px 12px;color:var(--danger);background:var(--danger-subtle, rgba(220,38,38,0.08));border-radius:var(--radius-sm);">${this.triggerError}</div>` : nothing}
          <p style="margin:0;">确认立即执行「<strong>${this.triggerJobName || ""}</strong>」？</p>
          <div slot="footer">
            <button class="btn" @click=${this.closeTriggerDialog} ?disabled=${this.triggerRunning}>取消</button>
            <button class="btn-primary" @click=${this.confirmTrigger} ?disabled=${this.triggerRunning}>
              ${this.triggerRunning ? "执行中..." : "确认执行"}
            </button>
          </div>
        </app-dialog>
      ` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cron-jobs-settings": CronJobsSettings;
  }
}
