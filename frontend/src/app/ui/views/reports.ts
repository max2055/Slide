import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state } from "lit/decorators.js";
import { icons } from "../../../icons.js";
import { authFetch } from "../../../api/index.js";

interface Report {
  id: number;
  name: string;
  type?: string;
  title: string;
  instance_name?: string;
  status: "completed" | "running" | "failed";
  created_at: string;
  created_by?: string;
  file_path?: string;
  format?: string;
}

interface ReportConfig {
  id: number;
  name: string;
  cron: string;
  type: string;
  instance_id: number;
  format: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  next_run?: string;
}

interface ReportType {
  type: string;
  icon: string;
  title: string;
  desc: string;
}

@customElement("reports-page")
export class ReportsPage extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host {
      display: block;
      animation: fade-in 0.25s var(--ease-out);
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .page {
      padding: 0 0 var(--space-xl) 0;
    }

    /* 主卡片 */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      margin-bottom: var(--space-lg);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
      background: var(--bg-elevated);
    }

    .card-title {
      font-size: var(--text-lg);
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--text-strong);
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }

    .card-title svg {
      width: 16px;
      height: 16px;
      opacity: 0.72;
    }

    .card-sub {
      font-size: var(--text-base);
      color: var(--muted);
      margin-top: var(--space-xs);
    }

    /* 报表类型网格 */
    .report-types-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--space-md);
      padding: var(--space-lg);
    }

    .report-type-card {
      display: flex;
      align-items: flex-start;
      gap: var(--space-md);
      padding: var(--space-lg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--card);
      cursor: pointer;
      transition: all var(--duration-normal) var(--ease-out);
    }

    .report-type-card:hover {
      border-color: var(--accent);
      transform: translateY(-1px);
      box-shadow: var(--shadow-sm);
    }

    .report-type-card__icon {
      width: 44px;
      height: 44px;
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--text-2xl);
      background: var(--accent-subtle);
      flex-shrink: 0;
      color: var(--accent);
    }
    .report-type-card__icon svg {
      width: 22px;
      height: 22px;
    }

    .report-type-card__content {
      flex: 1;
    }

    .report-type-card__title {
      font-size: var(--text-md);
      font-weight: 600;
      color: var(--text-strong);
      margin-bottom: var(--space-xs);
    }

    .report-type-card__desc {
      font-size: var(--text-sm);
      color: var(--muted);
      line-height: 1.5;
    }

    .report-type-card__action {
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--accent);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      font-weight: 500;
      color: var(--accent);
      background: transparent;
      cursor: pointer;
      transition: all var(--duration-normal) var(--ease-out);
      flex-shrink: 0;
    }

    .report-type-card__action:hover {
      background: var(--accent);
      color: var(--accent-foreground);
    }

    /* 表格样式 */
    .table-container {
      overflow-x: auto;
    }

    .table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: var(--text-base);
    }

    .table th {
      position: sticky;
      top: 0;
      z-index: 3;
      padding: var(--space-md) var(--space-md);
      text-align: left;
      font-weight: 600;
      font-size: var(--text-xs);
      color: var(--muted);
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .table td {
      padding: var(--space-md) var(--space-md);
      border-bottom: 1px solid var(--border);
      color: var(--text);
      vertical-align: middle;
    }

    .table tbody tr {
      transition: background var(--duration-fast) ease;
    }

    .table tbody tr:hover {
      background: var(--bg-hover);
    }

    .table tbody tr:last-child td {
      border-bottom: none;
    }

    .report-title {
      font-weight: 600;
      color: var(--text-strong);
      font-size: var(--text-md);
    }

    .type-badge {
      display: inline-flex;
      align-items: center;
      padding: var(--space-xs) var(--space-md);
      background: rgba(59, 130, 246, 0.12);
      color: var(--info);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .instance-badge {
      display: inline-flex;
      align-items: center;
      padding: var(--space-xs) var(--space-md);
      background: var(--secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      color: var(--text);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-xs) var(--space-md);
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      font-weight: 500;
    }

    .status-badge.ok {
      background: var(--ok-subtle);
      color: var(--ok);
    }

    .status-badge.blue {
      background: rgba(59, 130, 246, 0.12);
      color: var(--info);
    }

    .status-badge.red {
      background: var(--danger-subtle);
      color: var(--danger);
    }

    .time-ago {
      font-size: var(--text-sm);
      color: var(--muted);
    }

    /* 操作按钮 */
    .actions {
      display: flex;
      gap: var(--space-sm);
    }

    .action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-xs);
      padding: var(--space-xs) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      font-weight: 500;
      color: var(--text);
      background: var(--secondary);
      cursor: pointer;
      transition: all var(--duration-normal) var(--ease-out);
    }

    .action-btn svg {
      width: 16px;
      height: 16px;
    }

    .action-btn:hover {
      background: var(--accent);
      color: var(--accent-foreground);
      border-color: var(--accent);
    }

    /* 加载和空状态 */
    .loading, .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 200px;
      color: var(--muted);
    }

    .empty__content {
      text-align: center;
      padding: 40px var(--space-xl);
    }

    .empty__icon {
      width: 48px;
      height: 48px;
      margin-bottom: var(--space-md);
      opacity: 0.6;
      color: var(--muted);
    }
    .empty__icon svg {
      width: 16px;
      height: 16px;
    }

    .empty__title {
      font-size: var(--text-lg);
      color: var(--text-strong);
      margin-bottom: var(--space-sm);
    }

    .empty__desc {
      font-size: var(--text-base);
      color: var(--muted);
    }

    /* 弹窗样式 */
    .modal-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5); z-index: 1000;
      display: flex; align-items: center; justify-content: center;
    }
    .modal {
      background: var(--card); border-radius: var(--radius-lg);
      border: 1px solid var(--border); max-width: 600px; width: 90%;
      max-height: 80vh; overflow-y: auto;
    }
    .modal-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: var(--space-lg); border-bottom: 1px solid var(--border);
    }
    .modal-title { font-size: var(--text-lg); font-weight: 600; color: var(--text-strong); }
    .modal-close {
      background: none; border: none; cursor: pointer; color: var(--muted); padding: 4px;
    }
    .modal-body { padding: var(--space-lg); }
    .modal-footer {
      display: flex; justify-content: flex-end; gap: var(--space-md);
      padding: var(--space-lg); border-top: 1px solid var(--border);
    }
    .field-row {
      display: flex; flex-direction: column; gap: var(--space-xs);
      margin-bottom: var(--space-md);
    }
    .field-label {
      font-size: var(--text-sm); font-weight: 600; color: var(--text-strong);
    }
    .field-input {
      padding: 8px 10px; border: 1px solid var(--border);
      border-radius: var(--radius-md); background: var(--input);
      color: var(--text); font-size: var(--text-base);
    }
    .cfg-toggle { cursor: pointer; }
    .cfg-toggle__track {
      width: 36px; height: 20px; border-radius: 10px; background: var(--border);
      position: relative; transition: background 0.2s;
    }
    .cfg-toggle__track.on { background: var(--accent); }
    .cfg-toggle__thumb {
      width: 16px; height: 16px; border-radius: 50%; background: white;
      position: absolute; top: 2px; left: 2px; transition: left 0.2s;
    }
    .cfg-toggle__track.on .cfg-toggle__thumb { left: 18px; }
  `];

  @state() private reports: Report[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private stats = { total: 0, completed: 0, running: 0, failed: 0 };
  @state() private instances: Array<{ id: number; name: string }> = [];
  @state() private selectedInstanceId: number | null = null;
  @state() private configs: ReportConfig[] = [];
  @state() private configsLoading = true;
  @state() private editingConfig: ReportConfig | null = null;
  @state() private showConfigDialog = false;
  @state() private showDeleteConfirm = false;
  @state() private deletingConfig: ReportConfig | null = null;
  @state() private configForm: Partial<ReportConfig> & { instance_id?: number } = {};
  @state() private saving = false;

  private reportTypes: ReportType[] = [
    { type: "health", icon: "activity", title: "健康检查报告", desc: "数据库实例健康状态全面检查" },
    { type: "performance", icon: "zap", title: "性能分析报告", desc: "SQL 性能分析和索引优化建议" },
    { type: "slow_query", icon: "clock", title: "慢查询报告", desc: "慢查询日志分析和性能瓶颈识别" },
    { type: "capacity", icon: "trending-up", title: "容量规划报告", desc: "存储使用趋势和扩容建议" },
  ];

  private get token() {
    return localStorage.getItem("token");
  }

  private get headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  override firstUpdated() {
    this.loadReports();
    this.loadStats();
    this.loadInstances();
    this.loadConfigs();
  }

  private async loadInstances() {
    try {
      const res = await authFetch('/api/database/instances');
      if (res.ok) {
        this.instances = await res.json();
      }
    } catch (err: any) {
      console.error('加载实例列表失败:', err);
    }
  }

  private async loadConfigs() {
    try {
      const res = await authFetch('/api/reports/configs');
      if (res.ok) {
        const data: ReportConfig[] = await res.json();
        // next_run is pre-computed by the API — no client-side CronJob needed
        this.configs = data;
      } else {
        console.error('加载定时配置失败:', res.status, res.statusText);
      }
      this.configsLoading = false;
    } catch (err: any) {
      console.error('加载定时配置失败:', err);
      this.configsLoading = false;
    }
  }

  private async loadStats() {
    try {
      const res = await authFetch('/api/reports/stats');
      if (res.ok) {
        this.stats = await res.json();
      }
    } catch (err: any) {
      console.error('加载统计失败:', err);
    }
  }

  private async loadReports() {
    try {
      const res = await authFetch('/api/reports', {
        headers: this.headers,
      });
      if (res.ok) {
        this.reports = await res.json();
      }
      this.loading = false;
    } catch (err: any) {
      this.error = err.message;
      this.loading = false;
    }
  }

  override render() {
    if (this.loading) {
      return html`<div class="loading">加载中...</div>`;
    }

    if (this.error) {
      return html`<div class="loading" style="color: var(--destructive);">${this.error}</div>`;
    }

    return html`
      <div class="page">
        <!-- 生成报表卡片 -->
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">${icons['bar-chart']} 生成报表</div>
              <div class="card-sub">选择报表类型生成分析报告</div>
            </div>
            <div style="margin-top: var(--space-md);">
              <label style="font-size: var(--text-base); color: var(--muted); margin-right: 8px;">目标实例：</label>
              <select
                style="padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--input); color: var(--text); font-size: var(--text-base); min-width: 200px;"
                @change=${(e: Event) => { this.selectedInstanceId = Number((e.target as HTMLSelectElement).value); }}
              >
                <option value="">— 选择实例 —</option>
                ${this.instances.map(i => html`
                  <option value=${i.id}>${i.name}</option>
                `)}
              </select>
            </div>
          </div>

          <div class="report-types-grid">
            ${this.reportTypes.map(rt => html`
              <div class="report-type-card" @click=${() => this._generateReport(rt.type)}>
                <div class="report-type-card__icon">${icons[rt.icon as keyof typeof icons]}</div>
                <div class="report-type-card__content">
                  <div class="report-type-card__title">${rt.title}</div>
                  <div class="report-type-card__desc">${rt.desc}</div>
                </div>
                <button class="report-type-card__action">生成</button>
              </div>
            `)}
          </div>
        </div>

        <!-- 历史报告卡片 -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">${icons['file-text']} 历史报告</div>
          </div>

          ${this.reports.length > 0
            ? html`
                <div class="table-container">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>标题</th>
                        <th style="width: 100px; text-align:center;">类型</th>
                        <th style="width: 140px; text-align:center;">实例</th>
                        <th style="width: 90px; text-align:center;">状态</th>
                        <th style="width: 120px; text-align:center;">创建时间</th>
                        <th style="width: 140px; text-align:center;">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${this.reports.map((report) => html`
                        <tr>
                          <td class="report-title">${report.name || report.title}</td>
                          <td style="text-align:center;"><span class="type-badge">${this._reportTypeLabel(report.type)}</span></td>
                          <td style="text-align:center;">
                            ${report.instance_name
                              ? html`<span class="instance-badge">${report.instance_name}</span>`
                              : html`<span style="color: var(--muted);">—</span>`
                            }
                          </td>
                          <td style="text-align:center;"><span class="status-badge ${report.status === 'completed' ? 'ok' : report.status === 'running' ? 'blue' : 'red'}">${this._statusLabel(report.status)}</span></td>
                          <td style="text-align:center;"><span class="time-ago">${this._formatTime(report.created_at)}</span></td>
                          <td style="text-align:center;">
                            <div class="actions">
                              <button class="btn primary" @click=${() => this._download(report)}>下载</button>
                              <button class="action-btn" @click=${() => this._view(report)}>查看</button>
                            </div>
                          </td>
                        </tr>
                      `)}
                    </tbody>
                  </table>
                </div>
              `
            : html`
                <div class="empty">
                  <div class="empty__content">
                    <div class="empty__icon">${icons['file-text']}</div>
                    <div class="empty__title">暂无历史报告</div>
                    <div class="empty__desc">选择上方的报表类型生成第一份报告</div>
                  </div>
                </div>
              `
          }
        </div>
      </div>
    `;
  }

  private _reportTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      health: "健康检查",
      performance: "性能分析",
      slow_query: "慢查询",
      capacity: "容量规划",
    };
    return labels[type] || type;
  }

  private _statusLabel(status: string): string {
    const labels: Record<string, string> = { completed: "已完成", running: "生成中", failed: "失败" };
    return labels[status] || status;
  }

  private _formatTime(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (hours < 24) return `${hours} 小时前`;
    return `${days} 天前`;
  }

  private _refreshConfigs() {
    this.configsLoading = true;
    this.loadConfigs();
  }

  private _resetForm() {
    this.configForm = {
      name: '',
      cron: '',
      type: 'health',
      instance_id: undefined,
      format: 'html',
      enabled: true,
    };
  }

  private _openCreateDialog() {
    this._resetForm();
    this.editingConfig = null;
    this.showConfigDialog = true;
  }

  private _openEditDialog(cfg: ReportConfig) {
    this.editingConfig = cfg;
    this.configForm = { ...cfg };
    this.showConfigDialog = true;
  }

  private async _toggleConfig(cfg: ReportConfig) {
    const originalEnabled = cfg.enabled;
    cfg.enabled = !cfg.enabled;
    this.requestUpdate();
    try {
      const res = await authFetch(`/api/reports/configs/${cfg.id}`, {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify({ enabled: cfg.enabled }),
      });
      if (!res.ok) throw new Error('更新失败');
      this.loadConfigs();
    } catch (err: any) {
      cfg.enabled = originalEnabled;
      this.requestUpdate();
      alert(`切换状态失败：${err.message}`);
    }
  }

  private _confirmDelete(cfg: ReportConfig) {
    this.deletingConfig = cfg;
    this.showDeleteConfirm = true;
  }

  private async _deleteConfig() {
    if (!this.deletingConfig) return;
    try {
      await authFetch(`/api/reports/configs/${this.deletingConfig.id}`, {
        method: 'DELETE',
        headers: this.headers,
      });
      this.showDeleteConfirm = false;
      this.deletingConfig = null;
      this.loadConfigs();
    } catch (err: any) {
      alert(`删除失败：${err.message}`);
    }
  }

  private async _saveConfig() {
    const { name, cron, type, instance_id, format, enabled } = this.configForm;
    if (!name || !cron || !type || !instance_id) {
      alert('请填写所有必填字段');
      return;
    }
    this.saving = true;
    try {
      if (this.editingConfig) {
        const res = await authFetch(`/api/reports/configs/${this.editingConfig.id}`, {
          method: 'PUT',
          headers: this.headers,
          body: JSON.stringify({ name, cron, type, instance_id, format, enabled }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || '保存失败');
        }
      } else {
        const res = await authFetch('/api/reports/configs', {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ name, cron, type, instance_id, format, enabled }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || '创建失败');
        }
      }
      this.showConfigDialog = false;
      this.loadConfigs();
    } catch (err: any) {
      alert(`保存失败：${err.message}`);
    } finally {
      this.saving = false;
    }
  }

  private async _generateReport(type: string) {
    try {
      if (!this.selectedInstanceId) {
        alert('请先选择数据库实例');
        return;
      }
      const instanceId = this.selectedInstanceId;

      const res = await authFetch('/api/reports/generate', {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ type, instanceId }),
      });

      if (res.ok) {
        const result = await res.json();
        alert(`报表生成任务已创建：${result.name}`);
        this.loadReports();
        this.loadStats();
      } else {
        const err = await res.json();
        alert(`生成失败：${err.error}`);
      }
    } catch (err: any) {
      alert(`生成失败：${err.message}`);
    }
  }

  private async _download(report: Report) {
    try {
      const token = localStorage.getItem("token");
      const res = await authFetch(`/api/reports/${report.id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${report.name || report.title || 'report'}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`下载失败：${err.message}`);
    }
  }

  private async _view(report: Report) {
    try {
      const res = await authFetch(`/api/reports/${report.id}`, {
        headers: this.headers,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.content) {
          // Open in new window with HTML content via Blob URL
          const blob = new Blob([data.content], { type: 'text/html' });
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank');
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } else {
          alert('报表内容为空');
        }
      }
    } catch (err: any) {
      alert(`查看失败：${err.message}`);
    }
  }
}

if (!customElements.get("reports-page")) {
  customElements.define("reports-page", ReportsPage);
}
