import { ListBrowser, renderListBrowser, listBrowserStyles } from '../components/list-browser.js';
import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state } from "lit/decorators.js";
import { repeat } from 'lit/directives/repeat.js';
import DOMPurify from 'dompurify';
import "../components/app-card.js";
import "../components/app-badge.js";
import "../components/app-empty-state.js";
import "../components/app-dialog.js";
import "../components/app-form-field.js";
import { icons } from "../../../icons.js";
import { authFetch } from "../../../api/index.js";
import { showToast } from "../components/app-toast-container.js";
import { reportDownloadFilename } from './report-download.js';
import { readReportDetail, readReportHistory, type Report, type ReportPreviewResult } from './report-requests.js';

type ReportTarget = 'instance' | 'server';
type ReadState = 'loading' | 'ready' | 'error';
type Preview = { report: Report; trigger: HTMLButtonElement } & (ReportPreviewResult | { state: 'loading' });

const previewMessages = {
  'no-content': '这份报表未保存正文。可尝试下载原报表。',
  'empty-response': '服务返回了空响应，无法读取报表正文。可重试查看。',
  'not-found': '该报表不存在或当前不可查看。',
  forbidden: '当前无权查看报表。',
  unavailable: '暂时无法读取这份报表。可重试查看。',
};

function isServerReport(report: Report): boolean {
  return report.target_type === 'server' || report.type === 'server_health' || report.server_id != null;
}

function previewHtml(content: string): string {
  const documentElement = DOMPurify.sanitize(content, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['meta', 'link', 'base', 'form', 'object', 'embed', 'iframe'],
    FORBID_ATTR: ['href', 'xlink:href', 'srcset'],
  }) as HTMLElement;
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  documentElement.querySelector('head')?.prepend(csp);
  return `<!doctype html>${documentElement.outerHTML}`;
}

interface ReportConfig {
  id: number;
  name: string;
  cron: string;
  type: string;
  instance_id: number | null;
  server_id?: number | null;
  format: string;
  notification_channel_ids?: number[];
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
  static styles = [listBrowserStyles, sharedFieldStyles, sharedBtnStyles, css`
    :host {
      display: block;
      animation: fade-in 0.25s var(--ease-out);
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .page {
      padding: 0;
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
      color: var(--accent-text);
    }
    .report-type-card__icon svg {
      width: 22px;
      height: 22px;
    }

    .report-type-card__content {
      flex: 1;
    }

    .report-type-card button {
      align-self: center;
      flex-shrink: 0;
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

    .report-preview-frame {
      display: block;
      width: 100%;
      height: 60vh;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
    }

    /* The sandboxed document owns focus while the reader is inside the frame. */
    app-dialog:not(:focus-within) .report-preview-frame {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .report-preview-text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
    }

    .report-view-message {
      margin: var(--space-xs) 0 0;
      max-width: 14rem;
      text-align: left;
      color: var(--muted);
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

    .time-ago {
      font-size: var(--text-sm);
      color: var(--muted);
    }

    /* 操作按钮 */
    .actions {
      display: flex;
      gap: var(--space-sm);
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

    /* Empty states */
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

  private historyBrowser = new ListBrowser();
  private historyBatch = 0;
  @state() private historyLoading: 'refresh' | 'append' | null = null;
  @state() private historyTotal: number | null = null;
  @state() private reports: Report[] = [];
  @state() private historyError: { message: string; batches: number } | null = null;
  @state() private preview: Preview | null = null;
  @state() private targetReads: Record<ReportTarget, ReadState> = { instance: 'loading', server: 'loading' };
  @state() private instances: Array<{ id: number; name: string }> = [];
  @state() private servers: Array<{ id: number; host: string; label?: string }> = [];
  @state() private notificationChannels: Array<{ id: number; name: string }> = [];
  @state() private notificationChannelsRead: ReadState = 'loading';
  @state() private selectedInstanceId: number | null = null;
  @state() private selectedTargetType: ReportTarget = 'instance';
  @state() private selectedServerId: number | null = null;
  @state() private generating = false;
  @state() private configs: ReportConfig[] = [];
  @state() private configsLoading = true;
  @state() private configsError = false;
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
    { type: "server_health", icon: "server", title: "服务器巡检报告", desc: "检查所选服务器的健康状态并评分" },
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
    this.refreshReadData();
    this.loadTargets('instance');
    this.loadTargets('server');
    this.loadConfigs();
    this.loadNotificationChannels();
  }

  private async loadTargets(scope: ReportTarget) {
    this.targetReads = { ...this.targetReads, [scope]: 'loading' };
    try {
      const response = await authFetch(scope === 'instance' ? '/api/database/instances' : '/api/servers');
      if (!response.ok) throw new Error();
      const data = await response.json();
      const rows = scope === 'server' && !Array.isArray(data) ? data?.servers : data;
      if (!Array.isArray(rows)) throw new Error();
      if (scope === 'instance') this.instances = rows;
      else this.servers = rows;
      this.targetReads = { ...this.targetReads, [scope]: 'ready' };
    } catch {
      this.targetReads = { ...this.targetReads, [scope]: 'error' };
    }
  }

  private async loadConfigs() {
    this.configsLoading = true;
    try {
      const res = await authFetch('/api/reports/configs');
      if (!res.ok) throw new Error('REPORT_CONFIG_LIST_UNAVAILABLE');
      const data: ReportConfig[] = await res.json();
      if (!Array.isArray(data)) throw new Error('REPORT_CONFIG_LIST_INVALID');
      // next_run is pre-computed by the API — no client-side CronJob needed
      this.configs = data;
      this.configsError = false;
    } catch {
      this.configsError = true;
    } finally {
      this.configsLoading = false;
    }
  }

  private async loadNotificationChannels() {
    try {
      const response = await authFetch('/api/notification/channels?enabled=true');
      if (!response.ok) throw new Error();
      const channels = await response.json();
      if (!Array.isArray(channels)) throw new Error();
      this.notificationChannels = channels;
      this.notificationChannelsRead = 'ready';
    } catch {
      this.notificationChannelsRead = 'error';
    }
  }

  private async loadStats() {
    try {
      const res = await authFetch('/api/reports/stats');
      if (!res.ok) throw new Error();
      const { total } = await res.json();
      this.historyTotal = Number.isInteger(total) && total >= 0 ? total : null;
    } catch {
      this.historyTotal = null;
    }
  }

  async refreshReadData() {
    await this.loadHistory();
  }

  private async loadHistory(append = false) {
    if (this.historyLoading) return;
    this.historyLoading = append ? 'append' : 'refresh';
    const initialBatch = this.historyBatch;
    const firstBatch = append ? initialBatch + 1 : 1;
    const lastBatch = append ? firstBatch : (this.historyError?.batches ?? Math.max(1, initialBatch));
    try {
      const reports = append ? [...this.reports] : [];
      for (let batch = firstBatch; batch <= lastBatch; batch++) {
        reports.push(...await readReportHistory(batch));
      }
      if (!this.isConnected || this.historyBatch !== initialBatch) return;
      this.reports = [...new Map(reports.map(report => [report.id, report])).values()];
      this.historyBatch = lastBatch;
      this.historyError = null;
      if (!append) await this.loadStats();
    } catch (error) {
      if (this.isConnected && this.historyBatch === initialBatch) {
        this.reports = [];
        this.historyBatch = 0;
        this.historyError = {
          message: error instanceof Error ? error.message : '暂时无法读取报表历史，请重试。',
          batches: lastBatch,
        };
      }
    } finally {
      this.historyLoading = null;
    }
  }

  private _selectTarget(scope: ReportTarget) {
    if (this.selectedTargetType === scope) return;
    this.selectedTargetType = scope;
    this.selectedInstanceId = null;
    this.selectedServerId = null;
    this.historyBrowser.page = 1;
    this.preview = null;
  }

  private _renderGeneration() {
    const scope = this.selectedTargetType;
    const isServer = scope === 'server';
    const targetLabel = isServer ? '服务器' : '数据库实例';
    const read = this.targetReads[scope];
    const options = isServer
      ? this.servers.map(server => ({ id: server.id, name: server.label ? `${server.host} (${server.label})` : server.host }))
      : this.instances;
    const selectedId = isServer ? this.selectedServerId : this.selectedInstanceId;

    return html`
      <app-card variant="default">
        <div slot="header">
          ${icons['bar-chart']} 生成报表
          <div style="margin-top:var(--space-md);display:flex;align-items:center;gap:var(--space-md);flex-wrap:wrap;">
            <div role="group" aria-label="报表目标类型">
              <button class=${isServer ? 'btn' : 'btn-primary'} aria-pressed=${String(!isServer)} @click=${() => this._selectTarget('instance')}>数据库实例</button>
              <button class=${isServer ? 'btn-primary' : 'btn'} aria-pressed=${String(isServer)} @click=${() => this._selectTarget('server')}>服务器</button>
            </div>
            ${read === 'loading' ? html`<span role="status">正在读取${targetLabel}…</span>`
              : read === 'error' ? html`
                  <span role="alert">暂时无法读取${targetLabel}。</span>
                  <button class="btn btn-refresh" @click=${() => this.loadTargets(scope)}>重新读取目标</button>
                `
              : options.length === 0 ? html`<span role="status">暂无可选${targetLabel}。</span>`
              : html`
                <select class="field-input" aria-label=${`生成报表的${targetLabel}`}
                  @change=${(event: Event) => {
                    const id = Number((event.target as HTMLSelectElement).value) || null;
                    if (isServer) this.selectedServerId = id;
                    else this.selectedInstanceId = id;
                  }}>
                  <option value="" .selected=${selectedId === null}>${isServer ? '全量巡检（所有可巡检服务器）' : '选择数据库实例'}</option>
                  ${options.map(option => html`<option value=${option.id} .selected=${option.id === selectedId}>${option.name}</option>`)}
                </select>
                ${isServer ? html`<span>也可选择一台服务器进行单目标巡检。</span>` : ''}
              `}
          </div>
        </div>
        <div class="report-types-grid">
          ${this.reportTypes.filter(type => (type.type === 'server_health') === isServer).map(type => html`
            <div class="report-type-card">
              <div class="report-type-card__icon">${icons[type.icon as keyof typeof icons]}</div>
              <div class="report-type-card__content">
                <div class="report-type-card__title">${type.title}</div>
                <div class="report-type-card__desc">${type.desc}</div>
              </div>
              <button class="btn" aria-label=${`生成${type.title}`}
                ?disabled=${this.generating || read !== 'ready' || options.length === 0 || (!isServer && !selectedId)}
                @click=${() => this._generateReport(type.type)}>生成</button>
            </div>
          `)}
        </div>
      </app-card>
    `;
  }

  override render() {
    return html`
      <div class="page">
        ${this._renderGeneration()}

        <app-card variant="default">
          <div slot="header" style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-md);">
            <span>${icons['clock']} 定时报表</span>
            <button class="btn-primary" ?disabled=${this.configsLoading || this.configsError} @click=${this._openCreateDialog}>新建计划</button>
          </div>
          ${this.configsLoading ? html`<div class="loading"><div class="skeleton" style="width:100%;height:36px;"></div></div>` : this.configsError ? html`
            <div role="alert" style="text-align:center;padding-bottom:var(--space-lg);">
              <app-empty-state title="定时报表读取失败" description="无法确认当前配置，请重新读取核对，勿重复创建。"></app-empty-state>
              <button class="btn btn-refresh" @click=${this._refreshConfigs}>重新读取</button>
            </div>` : this.configs.length ? html`
            <div class="table-container"><table class="table"><thead><tr><th>名称</th><th>类型</th><th>目标</th><th>计划</th><th>下次运行</th><th>状态</th><th>操作</th></tr></thead><tbody>
              ${this.configs.map(cfg => html`<tr>
                <td class="report-title">${cfg.name}</td><td>${this._reportTypeLabel(cfg.type)}</td>
                <td>${cfg.server_id ? `服务器 #${cfg.server_id}` : `实例 #${cfg.instance_id}`}</td>
                <td><code>${cfg.cron}</code></td><td>${cfg.next_run ? this._formatTime(cfg.next_run) : '—'}</td>
                <td><app-badge variant=${cfg.enabled ? 'ok' : 'neutral'}>${cfg.enabled ? '已启用' : '已停用'}</app-badge></td>
                <td><div class="actions"><button class="btn-sm action-btn" @click=${() => this._toggleConfig(cfg)}>${cfg.enabled ? '停用' : '启用'}</button><button class="btn-sm action-btn" @click=${() => this._openEditDialog(cfg)}>编辑</button><button class="btn-sm action-btn" @click=${() => this._confirmDelete(cfg)}>删除</button></div></td>
              </tr>`)}
            </tbody></table></div>` : html`<app-empty-state title="暂无定时报表" description="新建计划后，系统会在到期时生成并保存报表。"><div slot="icon">${icons['clock']}</div></app-empty-state>`}
        </app-card>

        ${this._renderHistory()}
        ${this._renderConfigDialogs()}
        ${this._renderPreview()}
      </div>
    `;
  }

  private _renderHistory() {
    const servers = this.selectedTargetType === 'server';
    const scope = servers ? '服务器' : '数据库实例';
    const content = this.historyError
      ? html`<div class="list-browser">
          <span role="alert">${this.historyError.message}</span>
          <button class="btn btn-refresh" ?disabled=${this.historyLoading !== null}
            @click=${this.refreshReadData}>重试历史</button>
        </div>`
      : this.historyBatch === 0
        ? html`<div role="status" class="loading">正在读取报表历史…</div>`
        : this._renderHistoryList(servers, scope);
    return html`
      <app-card variant="default">
        <div slot="header">${icons['file-text']} 历史报告 <span>· ${scope}</span></div>
        ${content}
      </app-card>
    `;
  }

  private _renderHistoryList(servers: boolean, scope: string) {
    const scopedReports = this.reports.filter(report => isServerReport(report) === servers);
    const historyPage = this.historyBrowser.select(scopedReports, row => `${row.name || row.title || ''} ${row.instance_name || ''} ${row.server_name || ''} ${row.id}`, row => `${row.name || row.title || ''} ${row.id}`);
    const hasMore = this.historyTotal === null || this.reports.length < this.historyTotal;
    return html`
          ${renderListBrowser(this.historyBrowser, historyPage.total, scopedReports.length, "报表历史", () => this.requestUpdate(), "已载入（仅检索已载入历史）")}
          <div class="list-browser">
            <span>全部类型可见历史总数：${this.historyTotal ?? '未知'} · 已读取 ${this.historyBatch} 批</span>
            <button class="btn btn-refresh" ?disabled=${this.historyLoading !== null} @click=${this.refreshReadData}>刷新历史</button>
            ${hasMore ? html`<button class="btn" ?disabled=${this.historyLoading !== null} @click=${() => this.loadHistory(true)}>${this.historyLoading === 'append' ? '读取中...' : '读取下一批历史'}</button>` : ''}
          </div>
          ${historyPage.rows.length > 0
            ? html`
                <div class="table-container">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>标题</th>
                        <th style="width: 100px; text-align:center;">类型</th>
                        <th style="width: 70px; text-align:center;">目标类型</th>
                        <th style="width: 140px; text-align:center;">目标</th>
                        <th style="width: 90px; text-align:center;">状态</th>
                        <th style="width: 120px; text-align:center;">创建时间</th>
                        <th style="width: 140px; text-align:center;">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${repeat(historyPage.rows, report => report.id, report => html`
                        <tr>
                          <td class="report-title">${report.name || report.title}</td>
                          <td style="text-align:center;"><span class="type-badge">${this._reportTypeLabel(report.type)}</span></td>
                          <td style="text-align:center;">
                            <span class="type-badge" style="font-size:10px;background:${servers ? 'rgba(34,197,94,0.12);color:var(--ok)' : 'rgba(59,130,246,0.12);color:var(--info)'}">${servers ? '服务器' : '实例'}</span>
                          </td>
                          <td style="text-align:center;">
                            ${servers
                              ? (report.server_name
                                  ? html`<span class="instance-badge">${report.server_name}</span>`
                                  : html`<span style="color: var(--muted);">—</span>`)
                              : (report.instance_name
                                  ? html`<span class="instance-badge">${report.instance_name}</span>`
                                  : html`<span style="color: var(--muted);">—</span>`)
                            }
                          </td>
                          <td style="text-align:center;"><app-badge variant="${report.status === 'completed' ? 'ok' : report.status === 'failed' ? 'danger' : 'info'}">${this._statusLabel(report.status)}</app-badge></td>
                          <td style="text-align:center;"><span class="time-ago">${this._formatTime(report.created_at)}</span></td>
                          <td style="text-align:center;">
                            <div class="actions">
                              <button class="btn-primary" @click=${() => this._download(report)}>下载</button>
                              <button class="btn-sm action-btn" aria-disabled=${String(this.preview?.report.id === report.id && this.preview.state === 'loading')}
                                @click=${(event: MouseEvent) => this._view(report, event.currentTarget as HTMLButtonElement)}>${this._previewButtonLabel(report)}</button>
                            </div>
                            ${this._renderPreviewFeedback(report)}
                          </td>
                        </tr>
                      `)}
                    </tbody>
                  </table>
                </div>
              `
            : html`
                <app-empty-state title=${scopedReports.length ? '没有匹配的报表' : `暂无${scope}历史报告`}
                  description=${hasMore ? '可继续读取后续历史，检索仅覆盖已载入记录。' : ''}>
                  <div slot="icon">${icons['file-text']}</div>
                </app-empty-state>
              `
          }
    `;
  }

  private _reportTypeLabel(type?: string): string {
    const labels: Record<string, string> = {
      health: "健康检查",
      performance: "性能分析",
      slow_query: "慢查询",
      capacity: "容量规划",
      server_health: "服务器巡检",
    };
    return type ? labels[type] || type : '—';
  }

  private _statusLabel(status: string): string {
    const labels: Record<string, string> = { completed: "已完成", running: "生成中", pending: "生成中", failed: "失败" };
    return labels[status] || status;
  }

  private _formatTime(dateStr: string): string {
    const date = new Date(dateStr);
    if (!Number.isFinite(date.getTime())) return '—';
    const diff = Date.now() - date.getTime();
    if (diff < 0) return date.toLocaleString('zh-CN', { hour12: false });
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
      instance_id: undefined, server_id: undefined,
      format: 'html',
      notification_channel_ids: [],
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
      showToast(`Failed to toggle status: ${err.message}`, 'error');
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
      showToast(`Failed to delete: ${err.message}`, 'error');
    }
  }

  private async _saveConfig() {
    const { name, cron, type, instance_id, server_id, format, enabled, notification_channel_ids } = this.configForm;
    if (!name || !cron || !type || (!!instance_id === !!server_id)) {
      showToast('Please fill in all required fields', 'warning');
      return;
    }
    this.saving = true;
    try {
      if (this.editingConfig) {
        const res = await authFetch(`/api/reports/configs/${this.editingConfig.id}`, {
          method: 'PUT',
          headers: this.headers,
          body: JSON.stringify({ name, cron, type, instance_id, server_id, format, enabled, notification_channel_ids }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || '保存失败');
        }
      } else {
        const res = await authFetch('/api/reports/configs', {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ name, cron, type, instance_id, server_id, format, enabled, notification_channel_ids }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || '创建失败');
        }
      }
      this.showConfigDialog = false;
      this.loadConfigs();
    } catch (err: any) {
      showToast(`Failed to save: ${err.message}`, 'error');
    } finally {
      this.saving = false;
    }
  }

  private _renderConfigDialogs() {
    const set = (key: keyof ReportConfig, value: unknown) => { this.configForm = { ...this.configForm, [key]: value }; };
    return html`
      ${this.showConfigDialog ? html`<app-dialog .open=${true} size="md" .closeOnOverlay=${false} title=${this.editingConfig ? '编辑定时报表' : '新建定时报表'} @app-dialog-close=${() => this.showConfigDialog = false}>
        <app-form-field label="名称" required><input class="field-input" .value=${this.configForm.name ?? ''} @input=${(e: Event) => set('name', (e.target as HTMLInputElement).value)}></app-form-field>
        <app-form-field label="Cron 表达式" required hint="例如：0 0 9 * * *"><input class="field-input" .value=${this.configForm.cron ?? ''} @input=${(e: Event) => set('cron', (e.target as HTMLInputElement).value)}></app-form-field>
        <app-form-field label="报表类型" required><select class="field-input" .value=${this.configForm.type ?? 'health'} @change=${(e: Event) => set('type', (e.target as HTMLSelectElement).value)}>${this.reportTypes.map(t => html`<option value=${t.type}>${t.title}</option>`)}</select></app-form-field>
        <app-form-field label="目标类型" required><select class="field-input" .value=${this.configForm.server_id ? 'server' : 'instance'} @change=${(e: Event) => { const server = (e.target as HTMLSelectElement).value === 'server'; this.configForm = { ...this.configForm, instance_id: server ? undefined : this.instances[0]?.id, server_id: server ? this.servers[0]?.id : undefined, type: server ? 'server_health' : 'health' }; }}><option value="instance">数据库实例</option><option value="server">服务器</option></select></app-form-field>
        ${this.configForm.server_id ? html`<app-form-field label="服务器" required><select class="field-input" .value=${String(this.configForm.server_id)} @change=${(e: Event) => set('server_id', Number((e.target as HTMLSelectElement).value))}>${this.servers.map(s => html`<option value=${s.id}>${s.host}</option>`)}</select></app-form-field>` : html`<app-form-field label="数据库实例" required><select class="field-input" .value=${String(this.configForm.instance_id ?? '')} @change=${(e: Event) => set('instance_id', Number((e.target as HTMLSelectElement).value))}>${this.instances.map(i => html`<option value=${i.id}>${i.name}</option>`)}</select></app-form-field>`}
        ${this._renderNotificationChannels(set)}
        <div slot="footer"><button class="btn" @click=${() => this.showConfigDialog = false}>取消</button><button class="btn-primary" ?disabled=${this.saving} @click=${this._saveConfig}>保存</button></div>
      </app-dialog>` : ''}
      ${this.showDeleteConfirm ? html`<app-dialog .open=${true} size="sm" title="删除定时报表" @app-dialog-close=${() => this.showDeleteConfirm = false}><p>删除 “${this.deletingConfig?.name}” 后无法恢复。</p><div slot="footer"><button class="btn" @click=${() => this.showDeleteConfirm = false}>取消</button><button class="btn-primary" @click=${this._deleteConfig}>删除</button></div></app-dialog>` : ''}
    `;
  }

  private _renderNotificationChannels(set: (key: keyof ReportConfig, value: unknown) => void) {
    const read = this.notificationChannelsRead;
    if (read === 'loading') return html`<p role="status">正在读取可选通知通道…</p>`;
    if (read === 'error' || this.notificationChannels.length === 0) {
      const message = read === 'error' ? '暂时无法读取通知通道。' : '暂无可用的通知通道。';
      return html`<p role="status">${message}通知通道可不选，可到「设置 → 平台设置 → 通知通道」配置。</p>`;
    }
    return html`
      <app-form-field label="通知通道" hint="可选，报告完成后投递">
        <select class="field-input" multiple
          @change=${(event: Event) => set('notification_channel_ids', Array.from((event.target as HTMLSelectElement).selectedOptions, option => Number(option.value)))}>
          ${this.notificationChannels.map(channel => html`
            <option value=${channel.id} .selected=${(this.configForm.notification_channel_ids ?? []).includes(channel.id)}>${channel.name}</option>
          `)}
        </select>
      </app-form-field>
    `;
  }

  private async _generateReport(type: string) {
    if (this.generating) return;
    const isServer = type === 'server_health';
    const url = isServer ? '/api/servers/reports/generate' : '/api/reports/generate';
    const body = isServer ? { type, server_id: this.selectedServerId } : { type, instanceId: this.selectedInstanceId };
    this.generating = true;
    try {
      const response = await authFetch(url, { method: 'POST', headers: this.headers, body: JSON.stringify(body) });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        const message = typeof result?.error === 'string' ? `：${result.error}` : '，请稍后重试。';
        showToast(`生成报表失败${message}`, 'error');
        return;
      }
      showToast('报表已生成。', 'success');
      await this.refreshReadData();
    } catch {
      showToast('暂时无法确认生成结果，请先查看历史报告。', 'error');
    } finally {
      this.generating = false;
    }
  }

  private async _download(report: Report) {
    try {
      const token = localStorage.getItem("token");
      const res = await authFetch(`/api/reports/${report.id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 404) {
        showToast(previewMessages['not-found'], 'error');
        return;
      }
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = reportDownloadFilename(res.headers, report.name || report.title || 'report', report.format);
      document.body.append(link);
      link.click();
      link.remove();
      // Allow the browser to consume the Blob before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      showToast('无法下载这份报表，请稍后重试。', 'error');
    }
  }

  private _previewButtonLabel(report: Report): string {
    if (this.preview?.report.id === report.id) {
      if (this.preview.state === 'loading') return '读取中…';
      if (this.preview.state === 'empty-response' || this.preview.state === 'unavailable') return '重试查看';
    }
    return '查看';
  }

  private _renderPreviewFeedback(report: Report) {
    const preview = this.preview;
    if (preview?.report.id !== report.id || preview.state === 'ready') return '';
    if (preview.state === 'loading') return html`<span role="status" class="report-view-message">正在读取正文…</span>`;
    return html`<p class="report-view-message" role=${preview.state === 'no-content' ? 'status' : 'alert'}>
      ${previewMessages[preview.state]}
    </p>`;
  }

  private async _view(report: Report, trigger: HTMLButtonElement) {
    if (this.preview?.report.id === report.id && this.preview.state === 'loading') return;
    const pending = { report, trigger, state: 'loading' } as const;
    this.preview = pending;
    const result = await readReportDetail(report.id);
    if (this.isConnected && this.preview === pending && trigger.isConnected) {
      this.preview = { report, trigger, ...result };
    }
  }

  private async _closePreview() {
    const trigger = this.preview?.trigger;
    this.preview = null;
    await this.updateComplete;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  private _renderPreview() {
    const preview = this.preview;
    if (!preview || preview.state !== 'ready') return '';
    const { report, content } = preview;
    // The stored export format can be PDF or JSON even when the saved preview is HTML.
    const looksLikeHtml = /^\s*<(?:!doctype html\b|!--|[a-z][\w-]*(?:\s|\/?>))/i.test(content);
    const body = looksLikeHtml
      ? html`<iframe class="report-preview-frame" title="报表正文" sandbox="" tabindex="0" .srcdoc=${previewHtml(content)}></iframe>`
      : /^(?:%PDF-|JVBERi0)/.test(content.trimStart())
        ? html`<p>此报表可下载后查看。</p>`
        : html`<pre class="report-preview-text">${content}</pre>`;
    return html`
      <app-dialog .open=${true} size="wide" title=${report.name || report.title || '报表预览'}
        @app-dialog-close=${this._closePreview}>
        ${body}
        <div slot="footer">
          <button class="btn" @click=${() => this._download(report)}>下载</button>
          <button class="btn-primary" @click=${this._closePreview}>关闭</button>
        </div>
      </app-dialog>
    `;
  }
}

if (!customElements.get("reports-page")) {
  customElements.define("reports-page", ReportsPage);
}
