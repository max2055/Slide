/**
 * Alert list table with filtering, pagination, severity/status/app-badge rendering.
 *
 * Properties:
 *   .alerts=${Alert[]} .loading=${boolean} .stats=${{}} .activeListTab=${'active'|'recovered'}
 *   .filterSeverity=${string} .searchText=${string} .analyzedStatuses=${Map}
 *   .activeRCAAnalysis=${object|null} .diagnosisStatus=${string} .diagnosisResult=${any}
 *   .page=${number} .total=${number} .pageSize=${number} .statsActiveTotal=${number} .statsResolved=${number}
 *
 * Events:
 *   alert-select, alert-acknowledge, alert-rca, alert-create, alert-delete,
 *   alert-navigate-instance, alert-navigate-chat, alert-refresh,
 *   alert-filter-severity, alert-search, alert-page-change, alert-list-tab-change
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { icons } from "../../../icons.js";
import "./app-badge.js";
import "../../../components/stat-card.js";

interface Alert {
  id: number;
  instance_id: number;
  instance_name?: string;
  alert_type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  status: 'unread' | 'read' | 'acknowledged' | 'resolved' | 'closed';
  acknowledged: boolean;
  acknowledged_by?: string;
  acknowledged_at?: string;
  resolved_at?: string;
  resolved_by?: string;
  created_at: string;
}

@customElement("alert-list")
export class AlertList extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host { display: block; }
    .toolbar { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-md) var(--space-lg); border-bottom: 1px solid var(--border); background: var(--bg-elevated); flex-wrap: wrap; }
    .filter-btn { display: inline-flex; align-items: center; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--text-sm); font-weight: 500; color: var(--text); background: var(--secondary); cursor: pointer; transition: all var(--duration-normal) var(--ease-out); }
    .filter-btn:hover { border-color: var(--border-strong); background: var(--bg-hover); }
    .table-wrap { overflow: auto; max-height: calc(100vh - 420px); min-height: 200px; border: 1px solid var(--border); border-radius: var(--radius-lg); }
    .table { width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0; font-size: var(--text-base); }
    .table th { position: sticky; top: 0; z-index: 3; padding: var(--space-md); text-align: left; font-weight: 600; font-size: var(--text-xs); color: var(--muted); background: var(--bg-elevated); border-bottom: 2px solid var(--border); white-space: nowrap; text-transform: uppercase; letter-spacing: 0.04em; }
    .table td { padding: var(--space-md); border-bottom: 1px solid var(--border); color: var(--text); vertical-align: middle; }
    .table tbody tr { transition: background var(--duration-fast) ease; }
    .table tbody tr:hover { background: var(--bg-hover); }
    .table tbody tr:last-child td { border-bottom: none; }
    .table tbody tr.critical { background: var(--danger-subtle); }
    .table tbody tr.critical:hover { background: rgba(239,68,68,0.12); }
    .alert-title { font-weight: 600; color: var(--text-strong); font-size: var(--text-md); }
    .alert-message { font-size: var(--text-sm); color: var(--muted); line-height: 1.5; max-width: 500px; }
    .instance-badge { display: inline-flex; align-items: center; padding: var(--space-xs) var(--space-md); background: var(--secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--text-xs); color: var(--text); text-decoration: none; cursor: pointer; }
    .type-badge { display: inline-flex; align-items: center; padding: var(--space-xs) var(--space-sm); background: rgba(59,130,246,0.12); color: var(--info); border-radius: var(--radius-sm); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .time-ago { font-size: var(--text-sm); color: var(--muted); }
    .actions { display: flex; gap: var(--space-sm); }
    .action-btn { display: inline-flex; align-items: center; padding: 3px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 11px; font-weight: 500; cursor: pointer; background: var(--card); color: var(--text); white-space: nowrap; }
    .action-btn:hover { background: var(--accent); color: var(--accent-foreground,#fff); border-color: var(--accent); }
    .action-btn.primary { background: var(--accent); color: var(--accent-foreground,#fff); border-color: var(--accent); }
    .action-btn.primary:hover { background: var(--accent-hover); }
    .loading, .empty { display: flex; align-items: center; justify-content: center; min-height: 300px; color: var(--muted); }
    .empty__content { text-align: center; }
    .empty__icon { width: 48px; height: 48px; margin-bottom: var(--space-md); opacity: 0.6; color: var(--muted); }
    .empty__icon svg { width: 16px; height: 16px; }
    .empty__title { font-size: var(--text-lg); color: var(--text-strong); margin-bottom: var(--space-xs); }
    .empty__desc { font-size: var(--text-base); color: var(--muted); }
    .pagination { display: flex; align-items: center; justify-content: center; gap: var(--space-md); padding: var(--space-sm) 0; border-top: 1px solid var(--border); margin-top: var(--space-sm); }
    .pagination-info { font-size: var(--text-sm); color: var(--muted); }
    .pagination-jump { font-size: var(--text-xs); color: var(--muted); }
    .pagination-jump-input { padding: 2px 4px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); color: var(--text); }
    .tab { padding: var(--space-md) var(--space-xl); font-size: var(--text-md); font-weight: 500; color: var(--muted); background: transparent; border: none; border-bottom: 2px solid transparent; cursor: pointer; transition: all .15s ease; position: relative; }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .tab-badge { position: absolute; top: 8px; right: 4px; min-width: 16px; height: 16px; padding: 0 var(--space-xs); background: var(--accent); color: var(--accent-foreground); border-radius: var(--radius-full); font-size: 10px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
    .form-input { padding: var(--space-sm) var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: var(--text-base); color: var(--text); background: var(--card); box-sizing: border-box; }
  `];

  @property({ type: Array }) alerts: Alert[] = [];
  @property({ type: Boolean }) loading = false;
  @property() error: string | null = null;
  @property() activeListTab: 'active' | 'recovered' = 'active';
  @property() filterSeverity = '';
  @property() searchText = '';
  @property({ type: Object }) stats: Record<string, number> = {};
  @property({ type: Number }) statsActiveTotal = 0;
  @property({ type: Number }) statsResolved = 0;
  @property({ type: Object }) analyzedStatuses = new Map<number, any>();
  @property({ type: Object }) activeRCAAnalysis: Record<string, any> | null = null;
  @property() diagnosisStatus = 'idle';
  @property({ type: Object }) diagnosisResult: any = null;
  @property() diagnosisError: string | null = null;
  @property({ type: Number }) page = 0;
  @property({ type: Number }) total = 0;
  @property({ type: Number }) pageSize = 50;

  private _emit(name: string, detail?: any) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  override render() {
    if (this.loading) return html`<div class="loading">加载中...</div>`;
    if (this.error) return html`<div class="loading" style="color:var(--destructive);">${this.error}</div>`;

    const filtered = this.alerts;
    const totalPages = Math.max(1, Math.ceil(this.total / this.pageSize));

    return html`
      <div style="display:grid;gap:var(--space-md);grid-template-columns:repeat(5,1fr);margin-bottom:var(--space-xl)">
        <stat-card label="总告警数" .value="${this.stats.total ?? 0}" hint="活跃 + 已恢复"></stat-card>
        <stat-card label="未处理" .value="${this.stats.unread ?? 0}" variant="warn" .hint=${html`<span class="dot warn"></span>待确认`}></stat-card>
        <stat-card label="已恢复" .value="${this.stats.resolved ?? 0}" variant="ok" .hint=${html`<span class="dot ok"></span>自动/手动`}></stat-card>
        <stat-card label="严重告警" .value="${this.stats.critical ?? 0}" variant="danger" .hint=${html`<span class="dot danger"></span>需立即处理`}></stat-card>
        <stat-card label="警告告警" .value="${this.stats.warning ?? 0}" variant="warn" .hint=${html`<span class="dot warn"></span>需关注`}></stat-card>
      </div>

      <div style="display:flex;gap:var(--space-md);margin-bottom:var(--space-lg);">
        <button class="tab ${this.activeListTab === 'active' ? 'active' : ''}" @click=${() => this._emit('alert-list-tab-change', { tab: 'active' })}>活跃告警<span class="tab-badge">${this.statsActiveTotal}</span></button>
        <button class="tab ${this.activeListTab === 'recovered' ? 'active' : ''}" @click=${() => this._emit('alert-list-tab-change', { tab: 'recovered' })}>已恢复<span class="tab-badge" style="background:var(--ok-subtle);color:var(--ok);">${this.statsResolved}</span></button>
      </div>

      <div class="card" style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;">
        <div class="toolbar">
          <select class="filter-btn" style="font-size:var(--text-sm);" @change=${(e: any) => this._emit('alert-filter-severity', { value: e.target.value })}>
            <option value="">全部级别</option>
            <option value="critical" ?selected=${this.filterSeverity==='critical'}>严重</option>
            <option value="warning" ?selected=${this.filterSeverity==='warning'}>警告</option>
            <option value="info" ?selected=${this.filterSeverity==='info'}>提示</option>
          </select>
          <input class="form-input" type="text" placeholder="搜索编号/标题/实例..." style="flex:1;max-width:240px;padding:var(--space-sm) var(--space-md);font-size:var(--text-sm);" .value=${this.searchText} @input=${(e: any) => this._emit('alert-search', { value: e.target.value })} />
          <button class="btn" @click=${() => this._emit('alert-refresh')}>刷新</button>
        </div>

        ${filtered.length > 0 ? html`
          <div class="table-wrap">
            <table class="table">
              <thead><tr>
                <th style="width:45px;text-align:center;">编号</th>
                <th style="width:55px;text-align:center;">级别</th>
                <th>告警内容</th>
                <th style="width:100px;text-align:center;">实例</th>
                <th style="width:70px;text-align:center;">类型</th>
                <th style="width:70px;text-align:center;">状态</th>
                <th style="width:90px;text-align:center;">分析状态</th>
                <th style="width:110px;text-align:center;">时间</th>
                <th style="width:100px;text-align:center;">操作</th>
              </tr></thead>
              <tbody>${filtered.map(a => this._renderRow(a))}</tbody>
            </table>
          </div>
          ${this._renderPagination(totalPages)}
        ` : html`
          <div class="empty" style="min-height:200px;">
            <div class="empty__content">
              <div class="empty__icon">${this.activeListTab === 'recovered' ? icons['check-circle'] : icons['party-popper']}</div>
              <div class="empty__title">${this.activeListTab === 'recovered' ? '没有已恢复告警' : '暂无活跃告警'}</div>
              <div class="empty__desc">${this.activeListTab === 'recovered' ? '已恢复的告警会出现在这里' : '系统运行正常'}</div>
            </div>
          </div>
        `}
      </div>
    `;
  }

  private _renderRow(alert: Alert) {
    const isActive = alert.status === 'unread' || alert.status === 'read' || alert.status === 'acknowledged';
    return html`
      <tr class="${alert.severity}" style="white-space:nowrap;">
        <td style="font-size:var(--text-xs);color:var(--muted);text-align:center;">${alert.id}</td>
        <td style="text-align:center;">
          <app-badge variant=${alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warn' : 'info'}>${this._severityLabel(alert.severity)}</app-badge>
        </td>
        <td style="overflow:hidden;" title="${this._cleanTitle(alert.title)} — ${alert.message}">
          <div style="display:flex;align-items:center;gap:var(--space-sm);overflow:hidden;">
            <span class="alert-title" style="white-space:nowrap;flex-shrink:0;">${this._cleanTitle(alert.title)}</span>
            <span class="alert-message" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:var(--text-sm);">${alert.message}</span>
          </div>
        </td>
        <td style="text-align:center;">
          ${alert.instance_name ? html`<a href="#" class="instance-badge" @click=${(e: Event) => { e.preventDefault(); this._emit('alert-navigate-instance', { id: alert.instance_id }); }}>${alert.instance_name}</a>` : html`<span style="color:var(--muted);">—</span>`}
        </td>
        <td style="text-align:center;"><span class="type-badge" style="font-size:10px;">${this._typeLabel(alert.alert_type)}</span></td>
        <td style="text-align:center;">${this._renderStatusBadge(alert)}</td>
        <td style="text-align:center;font-size:var(--text-sm);">${this._renderAnalysisBadge(alert.id)}</td>
        <td style="text-align:center;"><span class="time-ago" style="font-size:var(--text-xs);">${this._formatTime(alert.created_at)}</span></td>
        <td style="text-align:center;">
          <div class="actions" style="flex-wrap:wrap;gap:3px;">
            ${alert.status === 'unread' || alert.status === 'read'
              ? html`<button class="action-btn primary" @click=${() => this._emit('alert-acknowledge', { id: alert.id })}>确认</button>`
              : html`<button class="action-btn" @click=${() => this._emit('alert-select', { id: alert.id })}>详情</button>`
            }
            ${isActive && alert.severity !== 'info' ? html`<button class="action-btn" @click=${() => this._emit('alert-rca', { id: alert.id })}>AI</button>` : ''}
          </div>
        </td>
      </tr>
    `;
  }

  private _renderStatusBadge(alert: Alert) {
    const labels: Record<string, string> = { unread: '未读', read: '已读', acknowledged: '已确认', resolved: alert.resolved_by === 'auto' ? '自动恢复' : '已恢复', closed: '已关闭' };
    const variantMap: Record<string, string> = { unread: 'danger', read: 'muted', acknowledged: 'info', resolved: 'ok', closed: 'muted' };
    const variant = variantMap[alert.status] || 'muted';
    return html`<app-badge variant="${variant}">${labels[alert.status] || alert.status}</app-badge>`;
  }

  private _renderAnalysisBadge(alertId: number) {
    const isAnalyzing = this.activeRCAAnalysis?.alertId === alertId;
    if (isAnalyzing) {
      if (this.diagnosisStatus === 'running') return html`<span class="analysis-badge analysis-badge--running" clickable @click=${() => this.activeRCAAnalysis?.sessionKey && this._emit('alert-navigate-chat', { sessionKey: this.activeRCAAnalysis.sessionKey })}>分析中 →</span>`;
      if (this.diagnosisStatus === 'completed') return html`<span class="analysis-badge analysis-badge--completed" @click=${() => this._emit('alert-select', { id: alertId })}>已分析</span>`;
      if (this.diagnosisStatus === 'failed') return html`<span class="analysis-badge analysis-badge--failed" @click=${() => this._emit('alert-select', { id: alertId })}>分析失败</span>`;
    }
    const record = this.analyzedStatuses.get(alertId);
    if (record) {
      if (record.status === 'completed') return html`<span class="analysis-badge analysis-badge--completed" @click=${() => this._emit('alert-select', { id: alertId })}>已分析</span>`;
      if (record.status === 'running' || record.status === 'pending') {
        const nav = record.sessionKey ? () => this._emit('alert-navigate-chat', { sessionKey: record.sessionKey }) : null;
        return nav ? html`<span class="analysis-badge analysis-badge--running" clickable @click=${nav}>分析中 →</span>` : html`<span class="analysis-badge analysis-badge--running">分析中</span>`;
      }
      if (record.status === 'failed') return html`<span class="analysis-badge analysis-badge--failed" @click=${() => this._emit('alert-select', { id: alertId })}>分析失败</span>`;
    }
    return html`<span style="color:var(--muted);font-size:var(--text-xs);">—</span>`;
  }

  private _renderPagination(totalPages: number) {
    if (totalPages <= 1) return html``;
    return html`
      <div class="pagination">
        <button class="btn" ?disabled=${this.page === 0} @click=${() => this._emit('alert-page-change', { page: this.page - 1 })}>← 上一页</button>
        <span class="pagination-info">第 ${this.page + 1}/${totalPages} 页，共 ${this.total} 条</span>
        <button class="btn" ?disabled=${this.page >= totalPages - 1} @click=${() => this._emit('alert-page-change', { page: this.page + 1 })}>下一页 →</button>
        <span class="pagination-jump">跳转 <input class="pagination-jump-input" type="number" min="1" max=${totalPages}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') { const v = parseInt((e.target as HTMLInputElement).value); if (v >= 1 && v <= totalPages) this._emit('alert-page-change', { page: v - 1 }); }}}
          style="width:50px;text-align:center;" placeholder=${this.page + 1} /> 页</span>
      </div>`;
  }

  private _severityLabel(s: string): string { return ({ critical: '严重', warning: '警告', info: '提示' } as Record<string, string>)[s] || s; }
  private _cleanTitle(t: string): string { return t.replace(/^\[(CRITICAL|WARNING|INFO|ERROR)\]\s*/i, ''); }
  private _typeLabel(t: string): string {
    return ({ health_check_failed: '健康检查', slow_query: '慢查询', connection_pool_exhausted: '连接池', replication_lag: '复制延迟', disk_space_low: '磁盘空间', cpu_high: 'CPU', memory_high: '内存' } as Record<string, string>)[t] || t;
  }
  private _formatTime(d: string): string { return new Date(d).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }); }
}

try { customElements.define("alert-list", AlertList); } catch (e: any) { if (!(e instanceof DOMException)) throw e; }
