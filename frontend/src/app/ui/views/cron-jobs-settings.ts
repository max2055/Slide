/**
 * Cron 任务管理页面
 * 管理定时采集和分析任务的启用/停用、表达式编辑、手动触发和运行日志查看
 */
import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";

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
}

interface Toast {
  message: string;
  type: "success" | "error";
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
  @state() private toast: Toast | null = null;

  static styles = [sharedBtnStyles, css`
    :host { display: block; }
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

    .dialog-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; animation: overlay-fade-in 0.15s ease; }
    @keyframes overlay-fade-in { from { opacity: 0; } to { opacity: 1; } }
    .dialog { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); width: 520px; max-height: 85vh; overflow-y: auto; box-shadow: var(--shadow-lg); animation: dialog-in 0.2s ease; }
    @keyframes dialog-in { from { opacity:0; transform:scale(0.96) translateY(8px); } to { opacity:1; transform:scale(1) translateY(0); } }
    .dialog-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    .dialog-title { font-size: 16px; font-weight: 600; margin: 0; color: var(--text-strong); }
    .dialog-body { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
    .dialog-footer { padding: 14px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; }
    .dialog-error { font-size: 12px; margin: 0 20px; padding: 8px 12px; color: var(--destructive); background: var(--danger-subtle, rgba(220,38,38,0.08)); border-radius: var(--radius-sm); }

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

    .form-group { display: flex; flex-direction: column; gap: 4px; }
    .form-label { font-size: 12px; font-weight: 600; color: var(--text); }
    .form-input { width: 100%; padding: 8px 10px; font-size: 13px; font-family: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); outline: none; box-sizing: border-box; transition: border-color 0.15s; }
    .form-input:focus { border-color: var(--accent); }
    .form-input::placeholder { color: var(--muted); }
    .form-textarea { min-height: 80px; line-height: 1.5; resize: vertical; max-height: 240px; }
    .form-mono { font-family: var(--mono, monospace); font-size: 12px; }
    .form-hint { font-size: 10px; color: var(--muted); }
    .cron-presets { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .cron-preset-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; font-size: 11px; font-family: inherit; color: var(--muted); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; transition: all 0.15s; }
    .cron-preset-chip:hover { color: var(--text); border-color: var(--accent); }
    .cron-preset-chip.active { color: var(--accent-foreground, #fff); background: var(--accent); border-color: var(--accent); }
    .cron-preset-expr { font-family: var(--mono, monospace); font-size: 10px; opacity: 0.7; }
    .toast { position: fixed; bottom: 24px; right: 24px; z-index: 1001; padding: 10px 16px; border-radius: var(--radius-sm); font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.2); transition: opacity 0.3s; }
    .toast--success { background: rgba(34,197,94,0.9); color: #fff; }
    .toast--error { background: rgba(220,38,38,0.9); color: #fff; }
  `];

  override connectedCallback() {
    super.connectedCallback();
    this.loadCronJobs();
  }

  private showToast(message: string, type: "success" | "error" = "success") {
    this.toast = { message, type };
    setTimeout(() => { this.toast = null; }, 3000);
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
      this.showToast("更新任务状态失败", "error");
    }
  }

  private openCreateDialog() {
    this.formName = "";
    this.formDescription = "";
    this.formTaskDescription = "";
    this.formCronExpr = "0 * * * *";
    this.formEnabled = true;
    this.formSaving = false;
    this.formError = null;
    this.editingJob = null;
    this.showCreateDialog = true;
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
    this.showCreateDialog = true;
  }

  private closeFormDialog() {
    this.showCreateDialog = false;
    this.editingJob = null;
    this.formName = "";
    this.formTaskDescription = "";
    this.formError = null;
  }

  private async saveTask() {
    if (!this.formName.trim()) { this.formError = "任务名称不能为空"; return; }
    if (this.formTaskDescription.trim().length < 10) { this.formError = "任务内容至少需要10个字符"; return; }
    this.formSaving = true;
    this.formError = null;
    try {
      const body = { name: this.formName, description: this.formDescription, task_description: this.formTaskDescription, cron_expr: this.formCronExpr, enabled: this.formEnabled };
      const isEdit = !!this.editingJob;
      const url = isEdit ? `/api/cron/jobs/${this.editingJob.id}` : "/api/cron/jobs";
      const res = await authFetch(url, { method: isEdit ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { const errBody = await res.json().catch(() => ({})); throw new Error(errBody.error || "保存失败"); }
      this.closeFormDialog();
      this.loadCronJobs();
      this.showToast(isEdit ? "更新成功" : "创建成功");
    } catch (e: any) {
      this.formError = e.message || "保存失败";
      this.formSaving = false;
    }
  }

  private onNameInput(e: Event) { this.formName = (e.target as HTMLInputElement).value; }
  private onDescInput(e: Event) { this.formDescription = (e.target as HTMLInputElement).value; }
  private onTaskDescInput(e: Event) { this.formTaskDescription = (e.target as HTMLInputElement).value; }
  private onCronExprInput(e: Event) { this.formCronExpr = (e.target as HTMLInputElement).value; }

  private confirmDelete(job: CronJobConfig) { this.deleteConfirmJob = job; this.deleteConfirmOpen = true; }
  private closeDeleteConfirm() { this.deleteConfirmOpen = false; this.deleteConfirmJob = null; this.deleteDeleting = false; }

  private async executeDelete() {
    if (!this.deleteConfirmJob) return;
    this.deleteDeleting = true;
    try {
      const res = await authFetch(`/api/cron/jobs/${this.deleteConfirmJob.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "删除失败");
      this.closeDeleteConfirm();
      this.showToast("已删除");
      this.loadCronJobs();
    } catch (e: any) {
      this.showToast(`删除失败：${e.message || "未知错误"}`, "error");
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
      this.showToast("已触发执行");
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
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await authFetch(`/api/cron/jobs/${jobId}/logs?limit=1`);
        if (res.ok) {
          const { logs } = await res.json() as { logs: CronJobLog[] };
          if (logs.length > 0 && logs[0].status !== "running") {
            clearInterval(interval);
            const next = new Set(this.pollingJobIds); next.delete(jobId); this.pollingJobIds = next;
            this.loadCronJobs();
            return;
          }
        }
      } catch { /* continue polling */ }
      if (attempts >= maxAttempts) { clearInterval(interval); const next = new Set(this.pollingJobIds); next.delete(jobId); this.pollingJobIds = next; }
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

  // ── Render ──

  override render() {
    if (this.loading) return html`<div class="loading">加载中...</div>`;
    if (this.error) return html`<div class="error-state"><h3>加载定时任务失败</h3><p>${this.error}</p><button class="btn" @click=${this.loadCronJobs}>重试</button></div>`;
    if (this.jobs.length === 0) return html`<div class="loading">暂无定时任务</div>`;

    return html`
      <div style="overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);">
        <div style="display:flex;align-items:center;gap:12px;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--bg-elevated);">
          <span style="font-size:12px;color:var(--muted);">${this.jobs.length} 个任务</span>
          <span style="flex:1;"></span>
          <button class="btn-primary" @click=${this.openCreateDialog}>+ 新建任务</button>
        </div>
        <div class="table-head">
          <div class="table-head-cell cell-status"></div>
          <div class="table-head-cell cell-name">任务名称</div>
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
            <div class="table-cell cell-desc">
              <span class="job-desc">${job.description || "—"}</span>
            </div>
            <div class="table-cell cell-expr">
              <span class="cron-text" title=${job.task_description ? job.task_description : ""}>${job.cron_expr}</span>
            </div>
            <div class="table-cell cell-next">
              <span class="relative-time">${formatRelativeTime(job.next_run_at)}</span>
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
      </div>

      <!-- Toast -->
      ${this.toast ? html`<div class="toast toast--${this.toast.type}">${this.toast.message}</div>` : nothing}

      <!-- Log Viewer Dialog -->
      ${this.logViewerJob ? html`
        <div class="dialog-overlay" @click=${this.closeLogViewer}>
          <div class="log-dialog" @click=${(e: Event) => e.stopPropagation()}>
            <div class="dialog-header">
              <h3 class="dialog-title">执行记录 — ${this.logViewerJob.name}</h3>
              <button class="btn-icon" @click=${this.closeLogViewer} title="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div class="log-dialog-body">
              ${this.viewerLoading ? html`<div class="log-empty">加载中...</div>` : nothing}
              ${this.viewerError ? html`<div class="dialog-error">${this.viewerError}</div>` : nothing}
              ${!this.viewerLoading && !this.viewerError && this.viewerLogs.length === 0 ? html`<div class="log-empty">暂无执行记录</div>` : nothing}
              ${this.viewerLogs.map(log => html`
                <div class="log-entry">
                  <div class="log-entry__header">
                    ${this.renderBadge(log.status)}
                    <span class="log-entry__time">${formatDateTime(log.started_at)}</span>
                    <span class="log-entry__duration">耗时 ${formatDuration(log.started_at, log.finished_at)}${log.duration_ms ? ' (' + log.duration_ms + 'ms)' : ''}</span>
                  </div>
                  ${log.error_message ? html`<div class="log-entry__error">${log.error_message}</div>` : nothing}
                  ${this.renderStructuredResult(log.structured_result)}
                  ${log.result ? html`<pre class="log-entry__result">${log.result}</pre>` : log.result_summary && !log.structured_result ? html`<div class="log-entry__summary">${log.result_summary}</div>` : !log.structured_result ? html`<div class="log-empty" style="padding:8px">无输出</div>` : nothing}
                </div>
              `)}
            </div>
          </div>
        </div>
      ` : nothing}

      <!-- Create/Edit Dialog -->
      ${this.showCreateDialog ? html`
        <div class="dialog-overlay" @click=${this.closeFormDialog}>
          <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
            <div class="dialog-header">
              <h3 class="dialog-title">${this.editingJob ? '编辑任务' : '新建任务'}</h3>
              <button class="btn-icon" @click=${this.closeFormDialog} title="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            ${this.formError ? html`<div class="dialog-error">${this.formError}</div>` : nothing}
            <div class="dialog-body">
              <div class="form-group">
                <label class="form-label">任务名称</label>
                <input class="form-input" .value=${this.formName} @input=${this.onNameInput} placeholder="例如：每日慢查询检查" />
              </div>
              <div class="form-group">
                <label class="form-label">描述</label>
                <input class="form-input" .value=${this.formDescription} @input=${this.onDescInput} placeholder="简要描述这个任务的用途" />
              </div>
              <div class="form-group">
                <label class="form-label">任务内容（自然语言）</label>
                <textarea class="form-input form-textarea" .value=${this.formTaskDescription} @input=${this.onTaskDescInput} placeholder="例如：每天早上9点检查生产环境的慢查询并生成摘要报告"></textarea>
                <div class="form-hint">告诉 AI 要做什么，用自然语言描述即可</div>
              </div>
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
            </div>
            <div class="dialog-footer">
              <button class="btn" @click=${this.closeFormDialog} ?disabled=${this.formSaving}>取消</button>
              <button class="btn-primary" @click=${this.saveTask} ?disabled=${this.formSaving}>
                ${this.formSaving ? '保存中...' : this.editingJob ? '保存修改' : '创建任务'}
              </button>
            </div>
          </div>
        </div>
      ` : nothing}

      <!-- Delete Confirm Dialog -->
      ${this.deleteConfirmOpen ? html`
        <div class="dialog-overlay" @click=${this.closeDeleteConfirm}>
          <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
            <div class="dialog-header"><h3 class="dialog-title">删除任务</h3></div>
            <div class="dialog-body">
              ${this.deleteDeleting
                ? html`<p style="color:var(--muted);text-align:center;">正在删除...</p>`
                : html`<p style="margin:0;">确定删除「<strong>${this.deleteConfirmJob?.name || ""}</strong>」吗？此操作不可撤销。</p>`}
            </div>
            <div class="dialog-footer">
              <button class="btn" @click=${this.closeDeleteConfirm} ?disabled=${this.deleteDeleting}>取消</button>
              <button class="btn-primary btn-danger" @click=${this.executeDelete} ?disabled=${this.deleteDeleting}>
                ${this.deleteDeleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ` : nothing}

      <!-- Trigger Confirm Dialog -->
      ${this.triggerDialogOpen ? html`
        <div class="dialog-overlay" @click=${this.closeTriggerDialog}>
          <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
            <div class="dialog-header"><h3 class="dialog-title">手动触发</h3></div>
            ${this.triggerError ? html`<div class="dialog-error">${this.triggerError}</div>` : nothing}
            <div class="dialog-body"><p style="margin:0;">确认立即执行「<strong>${this.triggerJobName || ""}</strong>」？</p></div>
            <div class="dialog-footer">
              <button class="btn" @click=${this.closeTriggerDialog} ?disabled=${this.triggerRunning}>取消</button>
              <button class="btn-primary" @click=${this.confirmTrigger} ?disabled=${this.triggerRunning}>
                ${this.triggerRunning ? "执行中..." : "确认执行"}
              </button>
            </div>
          </div>
        </div>
      ` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cron-jobs-settings": CronJobsSettings;
  }
}
