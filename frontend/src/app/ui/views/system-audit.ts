import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { showToast } from '../components/app-toast-container.js';
import '../components/app-badge.js';
import '../components/app-card.js';
import '../components/app-data-table.js';
import '../components/app-dialog.js';
import '../components/app-form-field.js';

interface SystemAuditRecord {
  id: string;
  eventType: string;
  level: 'info' | 'warning' | 'error' | 'critical';
  userId?: string;
  username?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  clientIp?: string;
  userAgent?: string;
  result: 'success' | 'failure' | 'pending';
  errorMessage?: string;
  timestamp: number;
}

const EVENT_TYPES = [
  ['', '全部'],
  ['system_operation', '系统操作'],
  ['login', '登录'],
  ['logout', '登出'],
  ['config_change', '配置变更'],
  ['user_change', '用户变更'],
  ['instance_change', '实例变更'],
  ['config_backup_access', '配置备份访问'],
  ['permission_denied', '权限拒绝'],
  ['approval_request', '审批申请'],
  ['approval_approved', '审批通过'],
  ['approval_rejected', '审批拒绝'],
  ['approval_expired', '审批过期'],
] as const;

const EVENT_LABELS = new Map<string, string>(EVENT_TYPES.filter(([value]) => value));

@customElement('system-audit-page')
export class SystemAuditPage extends LitElement {
  @state() private records: SystemAuditRecord[] = [];
  @state() private loading = true;
  @state() private selected: SystemAuditRecord | null = null;
  @state() private total = 0;
  @state() private offset = 0;
  @state() private keyword = '';
  @state() private eventType = '';
  @state() private startTime = '';
  @state() private endTime = '';
  private readonly limit = 25;

  static styles = [sharedBtnStyles, css`
    :host { display: block; min-width: 0; color: var(--text); }
    .page-header, .filters, .pagination, .dialog-grid { display: flex; }
    .page-header { align-items: center; justify-content: space-between; gap: var(--space-lg); margin-bottom: var(--space-xl); }
    .page-header h1 { margin: 0; font-size: var(--text-xl); color: var(--text-strong); }
    .filters { align-items: end; flex-wrap: wrap; gap: var(--space-md); }
    .filters app-form-field { flex: 1 1 11rem; margin-bottom: 0; }
    input, select { box-sizing: border-box; width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--card); color: var(--text); padding: var(--space-sm) var(--space-md); font: inherit; }
    input:focus, select:focus { outline: 2px solid var(--accent-subtle); border-color: var(--accent); }
    button svg { width: 1rem; height: 1rem; }
    .table-wrap { overflow-x: auto; margin-top: var(--space-lg); }
    .table-wrap app-data-table { min-width: 68rem; }
    .mono { font-family: var(--font-mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
    .resource { color: var(--muted); }
    .pagination { align-items: center; justify-content: flex-end; gap: var(--space-sm); margin-top: var(--space-md); }
    .pagination-info { margin-right: auto; color: var(--muted); font-size: var(--text-sm); }
    .dialog-grid { flex-direction: column; gap: var(--space-lg); }
    .detail-row { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: var(--space-md); font-size: var(--text-sm); }
    .detail-row > span:first-child { color: var(--muted); }
    pre { box-sizing: border-box; max-height: 20rem; overflow: auto; margin: var(--space-xs) 0 0; padding: var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text); font-family: var(--font-mono); font-size: var(--text-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (max-width: 760px) {
      .filters { align-items: stretch; flex-direction: column; }
      .filters app-form-field { flex: 0 0 auto; width: 100%; }
      .detail-row { grid-template-columns: 1fr; gap: var(--space-xs); }
    }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load(true);
  }

  private async load(reset = false): Promise<void> {
    if (reset) this.offset = 0;
    this.loading = true;
    try {
      const response = await apiClient.get<{ items: SystemAuditRecord[]; total: number }>('/audit/logs', {
        params: {
          limit: this.limit,
          offset: this.offset,
          keyword: this.keyword.trim() || undefined,
          eventType: this.eventType || undefined,
          startTime: this.startTime ? new Date(this.startTime).toISOString() : undefined,
          endTime: this.endTime ? new Date(this.endTime).toISOString() : undefined,
        },
      });
      this.records = response.items;
      this.total = response.total;
    } catch {
      showToast('加载系统审计记录失败', 'error');
    } finally {
      this.loading = false;
    }
  }

  private resetFilters(): void {
    this.keyword = '';
    this.eventType = '';
    this.startTime = '';
    this.endTime = '';
    void this.load(true);
  }

  private formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
  }

  private resultBadge(record: SystemAuditRecord) {
    const variant = record.result === 'success' ? 'ok' : record.result === 'failure' ? 'danger' : 'warn';
    const label = record.result === 'success' ? '成功' : record.result === 'failure' ? '失败' : '处理中';
    return html`<app-badge variant=${variant}>${label}</app-badge>`;
  }

  private rows(): Record<string, unknown>[] {
    return this.records.map(record => ({
      timestamp: this.formatTime(record.timestamp),
      eventType: html`<app-badge variant="info">${EVENT_LABELS.get(record.eventType) ?? record.eventType}</app-badge>`,
      action: html`<span class="mono">${record.action}</span>`,
      actor: record.username || (record.userId ? `用户 #${record.userId}` : '-'),
      resource: html`<span class="resource">${record.resourceType ?? '-'}${record.resourceId ? ` · ${record.resourceId}` : ''}</span>`,
      result: this.resultBadge(record),
      clientIp: html`<span class="mono">${record.clientIp ?? '-'}</span>`,
      actions: html`<button class="btn-icon" title="查看详情" aria-label="查看详情" @click=${() => { this.selected = record; }}>${icons.eye}</button>`,
    }));
  }

  override render() {
    const pageStart = this.total === 0 ? 0 : this.offset + 1;
    const pageEnd = Math.min(this.offset + this.limit, this.total);
    return html`
      <div class="page-header">
        <h1>系统审计</h1>
        <button class="btn-icon" title="刷新" aria-label="刷新" @click=${() => this.load()} .disabled=${this.loading}>${icons.refresh}</button>
      </div>
      <app-card>
        <span slot="header">筛选</span>
        <div class="filters">
          <app-form-field label="关键字"><input type="search" placeholder="操作者、操作、资源或 IP" .value=${this.keyword} @input=${(event: Event) => { this.keyword = (event.target as HTMLInputElement).value; }} @keydown=${(event: KeyboardEvent) => { if (event.key === 'Enter') void this.load(true); }}></app-form-field>
          <app-form-field label="操作类型"><select .value=${this.eventType} @change=${(event: Event) => { this.eventType = (event.target as HTMLSelectElement).value; }}>${EVENT_TYPES.map(([value, label]) => html`<option value=${value}>${label}</option>`)}</select></app-form-field>
          <app-form-field label="开始时间"><input type="datetime-local" .value=${this.startTime} @input=${(event: Event) => { this.startTime = (event.target as HTMLInputElement).value; }}></app-form-field>
          <app-form-field label="结束时间"><input type="datetime-local" .value=${this.endTime} @input=${(event: Event) => { this.endTime = (event.target as HTMLInputElement).value; }}></app-form-field>
          <button class="btn" type="button" @click=${this.resetFilters}>重置</button>
          <button class="btn-primary" type="button" @click=${() => this.load(true)}>${icons.search} 查询</button>
        </div>
        <div class="table-wrap"><app-data-table .columns=${[
          { key: 'timestamp', label: '时间' },
          { key: 'eventType', label: '操作类型' },
          { key: 'action', label: '操作' },
          { key: 'actor', label: '操作者' },
          { key: 'resource', label: '资源' },
          { key: 'result', label: '结果' },
          { key: 'clientIp', label: '客户端 IP' },
          { key: 'actions', label: '' },
        ]} .rows=${this.rows()} .loading=${this.loading} .dense=${true} emptyMessage="暂无系统审计记录"></app-data-table></div>
        <div class="pagination">
          <span class="pagination-info">${pageStart}-${pageEnd} / ${this.total}</span>
          <button class="btn" type="button" @click=${() => { this.offset = Math.max(0, this.offset - this.limit); void this.load(); }} .disabled=${this.offset === 0 || this.loading}>上一页</button>
          <button class="btn" type="button" @click=${() => { this.offset += this.limit; void this.load(); }} .disabled=${this.offset + this.limit >= this.total || this.loading}>下一页</button>
        </div>
      </app-card>
      <app-dialog size="lg" title="系统审计详情" .open=${this.selected !== null} @app-dialog-close=${() => { this.selected = null; }}>
        ${this.selected ? html`<div class="dialog-grid">
          <div class="detail-row"><span>记录 ID</span><span class="mono">${this.selected.id}</span></div>
          <div class="detail-row"><span>时间</span><span>${this.formatTime(this.selected.timestamp)}</span></div>
          <div class="detail-row"><span>操作者</span><span>${this.selected.username ?? '-'}${this.selected.userId ? ` (#${this.selected.userId})` : ''}</span></div>
          <div class="detail-row"><span>操作</span><span class="mono">${this.selected.action}</span></div>
          <div class="detail-row"><span>结果</span><span>${this.resultBadge(this.selected)} ${this.selected.errorMessage ?? ''}</span></div>
          <div class="detail-row"><span>客户端</span><span class="mono">${this.selected.clientIp ?? '-'} · ${this.selected.userAgent ?? '-'}</span></div>
          <div><strong>操作详情</strong><pre>${JSON.stringify(this.selected.details ?? {}, null, 2)}</pre></div>
        </div>` : ''}
      </app-dialog>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'system-audit-page': SystemAuditPage } }
