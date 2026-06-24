import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { customElement, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import { icons, renderIcon } from "../../../icons.js";
import { authFetch } from "../../../api/index.js";
import { showToast } from "../components/app-toast-container.js";

const API_BASE = "/api";

interface AlertEvent {
  id: string;
  title: string;
  status: "open" | "investigating" | "handled" | "resolved" | "closed";
  severity: string;
  instance_id: number | null;
  instance_name?: string;
  alert_count: number;
  root_cause?: string;
  assignee?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
}

interface EventStats {
  total: number;
  open: number;
  investigating: number;
  handled: number;
  resolved: number;
  closed: number;
  avg_resolution_time?: number;
}

interface MTTREntry {
  avg_mttr_minutes?: number;
  total_resolved?: number;
}

interface AlertMember {
  id: number;
  title: string;
  level: string;
  metric_name: string;
  metric_value: string;
  created_at: string;
}

interface EventLog {
  id: number;
  action: string;
  actor?: string;
  note?: string;
  created_at: string;
}

@customElement("event-management-page")
export class EventManagementPage extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      animation: fade-in 0.25s var(--ease-out);
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .page {
      padding: 0;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }

    .page-top {
      flex-shrink: 0;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-lg);
    }

    .header h2 {
      font-size: var(--text-xl);
      font-weight: 600;
      color: var(--text-strong);
      margin: 0;
    }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: var(--space-md);
      margin-bottom: var(--space-lg);
    }

    .stat-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-md) var(--space-lg);
      text-align: center;
    }

    .stat-card .stat-value {
      font-size: var(--text-2xl);
      font-weight: 700;
      color: var(--text-strong);
    }

    .stat-card .stat-label {
      font-size: var(--text-xs);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.03em;
      margin-top: var(--space-xs);
    }

    .stat-card.stat-open { border-left: 3px solid var(--danger, #ef4444); }
    .stat-card.stat-investigating { border-left: 3px solid var(--warn, #f59e0b); }
    .stat-card.stat-resolved { border-left: 3px solid var(--success, #22c55e); }
    .stat-card.stat-closed { border-left: 3px solid var(--muted); }

    .filter-bar {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      margin-bottom: var(--space-lg);
      flex-wrap: wrap;
    }

    .filter-bar label {
      font-size: var(--text-base);
      color: var(--muted);
    }

    .filter-bar select, .filter-bar input {
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--card);
      color: var(--text);
      font-size: var(--text-base);
      outline: none;
    }

    .filter-bar select:focus, .filter-bar input:focus {
      border-color: var(--border-strong);
    }

    .search-bar {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      margin-bottom: var(--space-lg);
    }

    .search-bar input {
      flex: 1;
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--card);
      color: var(--text);
      font-size: var(--text-base);
      outline: none;
    }

    .search-bar input:focus {
      border-color: var(--border-strong);
    }

    .tab.active {
      color: var(--accent) !important;
      border-bottom-color: var(--accent) !important;
    }

    .tab:hover {
      color: var(--text) !important;
    }

    .empty-state {
      text-align: center;
      padding: 60px var(--space-xl);
      color: var(--muted);
      font-size: var(--text-md);
    }

    .empty-state .empty-icon {
      width: 48px;
      height: 48px;
      margin: 0 auto var(--space-md) auto;
      opacity: 0.5;
      color: var(--muted);
    }
    .empty-state .empty-icon svg {
      width: 100%;
      height: 100%;
    }

    .postmortem-section {
      margin-top: var(--space-md);
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }

    .postmortem-item {
      padding: var(--space-md) var(--space-md);
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
      margin-bottom: var(--space-sm);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .postmortem-item .postmortem-time {
      font-size: var(--text-xs);
      color: var(--muted);
      margin-bottom: var(--space-xs);
    }

    .main-layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-lg);
      flex: 1;
      min-height: 0;
      padding-bottom: 8px;
    }

    @media (max-width: 900px) {
      .main-layout { grid-template-columns: 1fr; }
    }

    .panel {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: clip;
      display: flex;
      flex-direction: column;
    }

    .panel-header {
      padding: var(--space-md) var(--space-lg);
      background: var(--bg-tertiary);
      font-size: var(--text-base);
      font-weight: 600;
      color: var(--text-strong);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .event-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }

    .event-item {
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background 0.15s;
    }

    .event-item:last-child { border-bottom: none; }
    .event-item:hover { background: var(--bg-secondary); }
    .event-item.selected { background: var(--bg-secondary); border-left: 3px solid var(--primary, #3b82f6); }

    .event-item .event-title {
      font-size: var(--text-base);
      font-weight: 500;
      color: var(--text);
      margin-bottom: var(--space-xs);
    }

    .event-item .event-meta {
      display: flex;
      gap: var(--space-sm);
      font-size: var(--text-xs);
      color: var(--muted);
    }

    .badge {
      display: inline-block;
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      font-weight: 500;
    }

    .detail-panel {
      padding: var(--space-lg);
    }

    .detail-empty {
      text-align: center;
      padding: var(--space-xl);
      color: var(--muted);
      font-size: var(--text-base);
    }

    .detail-section {
      margin-bottom: var(--space-lg);
    }

    .detail-section h4 {
      font-size: var(--text-sm);
      font-weight: 600;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0 0 8px 0;
      letter-spacing: 0.03em;
    }

    .detail-row {
      display: flex;
      justify-content: space-between;
      padding: var(--space-xs) 0;
      font-size: var(--text-base);
    }

    .detail-row .label { color: var(--muted); }
    .detail-row .value { color: var(--text); font-weight: 500; }

    .alert-member-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }

    .alert-member-item {
      padding: var(--space-sm) var(--space-md);
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
    }

    .alert-member-item .alert-title { font-weight: 500; }
    .alert-member-item .alert-meta { color: var(--muted); margin-top: var(--space-xs); }

    .timeline {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }

    .timeline-item {
      display: flex;
      gap: var(--space-md);
      font-size: var(--text-sm);
    }

    .timeline-time {
      color: var(--muted);
      min-width: 140px;
      flex-shrink: 0;
    }

    .timeline-action {
      color: var(--text);
    }

    .timeline-note {
      color: var(--muted);
      font-style: italic;
    }

    .action-bar {
      display: flex;
      gap: var(--space-sm);
      flex-wrap: wrap;
      margin-top: var(--space-lg);
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }

    .pagination {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-md);
      padding: var(--space-sm) 0;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    .pagination-info {
      font-size: var(--text-sm);
      color: var(--muted);
    }

    .loading {
      text-align: center;
      padding: var(--space-xl);
      color: var(--muted);
    }

    .error {
      text-align: center;
      padding: var(--space-xl);
      color: var(--danger);
    }

    .note-input {
      width: 100%;
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--card);
      color: var(--text);
      font-size: var(--text-base);
      resize: vertical;
      min-height: 60px;
      margin-top: var(--space-sm);
      box-sizing: border-box;
    }

    .note-input:focus {
      border-color: var(--border-strong);
      outline: none;
    }
  `];

  @state() private events: AlertEvent[] = [];
  @state() private stats: EventStats | null = null;
  @state() private mttr: MTTREntry | null = null;
  @state() private selectedEvent: AlertEvent | null = null;
  @state() private eventMembers: AlertMember[] = [];
  @state() private eventLogs: EventLog[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private activeListTab: 'active' | 'resolved' = 'active';
  @state() private filterSeverity = "all";
  @state() private filterSearch = "";
  @state() private noteText = "";
  @state() private actionLoading = false;
  @state() private showPostmortemForm = false;
  @state() private postmortemText = "";
  @state() private rcaLoading = false;
  @state() private rcaResult: { analysisIds: number[]; sessionKeys: string[]; eventId: number } | null = null;
  @state() private eventsPage = 0;
  @state() private eventsTotal = 0;
  private readonly eventsPageSize = 50;

  override connectedCallback() {
    super.connectedCallback();
    this._loadEvents();
    // Restore persisted RCA result
    try {
      const saved = localStorage.getItem('event_rca_result');
      if (saved) this.rcaResult = JSON.parse(saved);
    } catch {}
  }

  private _saveRCAResult() {
    if (this.rcaResult) {
      localStorage.setItem('event_rca_result', JSON.stringify(this.rcaResult));
    }
  }

  private _clearRCAResult() {
    this.rcaResult = null;
    localStorage.removeItem('event_rca_result');
  }

  private async _loadEvents() {
    try {
      const offset = this.eventsPage * this.eventsPageSize;
      const statusFilter = this.activeListTab === 'active'
        ? 'open,investigating,handled'
        : 'resolved,closed';
      const [eventsRes, statsRes, mttrRes] = await Promise.all([
        authFetch(`${API_BASE}/alerts/events?limit=${this.eventsPageSize}&offset=${offset}&status=${statusFilter}`),
        authFetch(`${API_BASE}/alerts/events/stats`),
        authFetch(`${API_BASE}/alerts/events/mttr`),
      ]);
      if (!eventsRes.ok) throw new Error(`Failed to load events: ${eventsRes.status}`);
      if (!statsRes.ok) throw new Error(`Failed to load stats: ${statsRes.status}`);
      const data = await eventsRes.json();
      this.events = data.items ?? data;
      this.eventsTotal = data.total ?? 0;
      this.stats = await statsRes.json();
      if (mttrRes.ok) {
        this.mttr = await mttrRes.json();
      }
    } catch (e: any) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  }

  private async _selectEvent(event: AlertEvent) {
    this.selectedEvent = event;
    try {
      const [detailRes, logsRes] = await Promise.all([
        authFetch(`${API_BASE}/alerts/events/${event.id}`),
        authFetch(`${API_BASE}/alerts/events/${event.id}/logs`),
      ]);
      if (detailRes.ok) {
        const detail = await detailRes.json();
        this.eventMembers = detail.alerts || [];
        this.selectedEvent = { ...this.selectedEvent, ...detail };
      }
      this.eventLogs = logsRes.ok ? await logsRes.json() : [];
    } catch (e: any) {
      showToast('Failed to load event details', 'error');
    }
  }

  private async _action(action: () => Promise<void>) {
    this.actionLoading = true;
    try {
      await action();
      await this._loadEvents();
      if (this.selectedEvent) {
        await this._selectEvent(this.selectedEvent);
      }
    } catch (e: any) {
      this.error = e.message;
    } finally {
      this.actionLoading = false;
    }
  }

  private async _startInvestigation() {
    const eventId = this.selectedEvent?.id;
    if (!eventId) { this.error = "未选择事件"; return; }
    await this._action(async () => {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/investigate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "开始调查" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
  }

  private async _addNote() {
    const eventId = this.selectedEvent?.id;
    if (!eventId || !this.noteText.trim()) return;
    const note = this.noteText.trim();
    this.noteText = "";
    await this._action(async () => {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
  }

  private _navigateToChat(sessionKey: string) {
    window.dispatchEvent(new CustomEvent("slide-navigate", {
      detail: { tab: "chat", session: sessionKey },
    }));
  }

  private async _triggerRCA() {
    const eventId = this.selectedEvent?.id;
    if (!eventId) { this.error = "未选择事件"; return; }
    this.rcaLoading = true;
    this.rcaResult = null;
    this.error = null;
    try {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/rca`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.rcaResult = { ...data, eventId: Number(eventId) };
      this._saveRCAResult();
    } catch (e: any) {
      this.error = e.message;
    } finally {
      this.rcaLoading = false;
    }
  }

  private async _resolveEvent() {
    const eventId = this.selectedEvent?.id;
    if (!eventId) { this.error = "未选择事件"; return; }
    await this._action(async () => {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution_notes: "已解决" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
  }

  private async _closeEvent() {
    const eventId = this.selectedEvent?.id;
    if (!eventId) { this.error = "未选择事件"; return; }
    await this._action(async () => {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/close`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
  }

  private async _addPostmortem() {
    const eventId = this.selectedEvent?.id;
    if (!eventId || !this.postmortemText.trim()) return;
    const content = this.postmortemText.trim();
    this.postmortemText = "";
    this.showPostmortemForm = false;
    await this._action(async () => {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/postmortem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
  }

  private _getFilteredEvents(): AlertEvent[] {
    let result = this.events;
    if (this.filterSeverity !== "all") {
      result = result.filter((e) => e.severity === this.filterSeverity);
    }
    if (this.filterSearch.trim()) {
      const q = this.filterSearch.trim().toLowerCase();
      result = result.filter((e) =>
        e.title.toLowerCase().includes(q) ||
        (e.root_cause && e.root_cause.toLowerCase().includes(q)) ||
        (e.instance_name && e.instance_name.toLowerCase().includes(q))
      );
    }
    return result;
  }

  private _statusBadge(status: string) {
    const variantMap: Record<string, string> = {
      open: "warn",
      investigating: "info",
      handled: "muted",
      resolved: "ok",
      closed: "muted",
    };
    const labelMap: Record<string, string> = {
      open: "开放",
      investigating: "调查中",
      handled: "已处理",
      resolved: "已解决",
      closed: "已关闭",
    };
    return html`<app-badge variant=${variantMap[status] || "muted"}>${labelMap[status] || status}</app-badge>`;
  }

  private _severityColor(severity: string): string {
    const colors: Record<string, string> = {
      info: "var(--info, #3b82f6)",
      warning: "var(--warn, #f59e0b)",
      error: "var(--danger, #ef4444)",
      critical: "var(--danger)",
    };
    return colors[severity] || "var(--muted)";
  }

  private _renderPagination() {
    const totalPages = Math.max(1, Math.ceil(this.eventsTotal / this.eventsPageSize));
    if (totalPages <= 1) return html``;
    return html`
      <div class="pagination">
        <button class="btn" ?disabled=${this.eventsPage === 0} @click=${() => { this.eventsPage--; this._loadEvents(); }}>← 上一页</button>
        <span class="pagination-info">第 ${this.eventsPage + 1}/${totalPages} 页，共 ${this.eventsTotal} 条</span>
        <button class="btn" ?disabled=${this.eventsPage >= totalPages - 1} @click=${() => { this.eventsPage++; this._loadEvents(); }}>下一页 →</button>
      </div>`;
  }

  private _formatTime(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleString("zh-CN");
    } catch {
      return dateStr;
    }
  }

  override render() {
    if (this.loading) {
      return html`<div class="page"><div class="loading" style="flex-direction:column;gap:16px;">
          <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:var(--space-md);width:100%;">
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-md);width:100%;">
            <div class="skeleton-block" style="height:300px;"></div>
            <div class="skeleton-block" style="height:300px;"></div>
          </div>
        </div></div>`;
    }
    if (this.error) {
      return html`<div class="page"><div class="error">加载失败: ${this.error}</div></div>`;
    }

    const filtered = this._getFilteredEvents();

    return html`
      <div class="page">
        <div class="page-top">
        <div class="header"></div>

        ${this.stats ? this._renderStats() : nothing}

        <div class="search-bar">
          <input
            type="text"
            placeholder="搜索事件标题、实例或根因..."
            .value=${this.filterSearch}
            @input=${(e: Event) => { this.filterSearch = (e.target as HTMLInputElement).value; }}
          />
        </div>

        <!-- 活跃/已解决 Tab -->
        <div style="display:flex;gap:var(--space-md);margin-bottom:var(--space-lg);">
          <button class="tab ${this.activeListTab === 'active' ? 'active' : ''}"
            @click=${() => { this.activeListTab = 'active'; this.eventsPage = 0; this._loadEvents(); }}
            style="padding:var(--space-sm) var(--space-lg);font-size:var(--text-base);font-weight:500;background:transparent;border:none;border-bottom:2px solid transparent;cursor:pointer;color:var(--muted);position:relative;">
            活跃事件
            ${this.stats ? html`<span style="position:absolute;top:2px;right:-4px;min-width:16px;height:16px;padding:0 var(--space-xs);background:var(--accent);color:var(--accent-foreground);border-radius:var(--radius-full);font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;">${this.stats.open + this.stats.investigating + this.stats.handled}</span>` : nothing}
          </button>
          <button class="tab ${this.activeListTab === 'resolved' ? 'active' : ''}"
            @click=${() => { this.activeListTab = 'resolved'; this.eventsPage = 0; this._loadEvents(); }}
            style="padding:var(--space-sm) var(--space-lg);font-size:var(--text-base);font-weight:500;background:transparent;border:none;border-bottom:2px solid transparent;cursor:pointer;color:var(--muted);position:relative;">
            已解决
            ${this.stats ? html`<span style="position:absolute;top:2px;right:-4px;min-width:16px;height:16px;padding:0 var(--space-xs);background:var(--ok-subtle, #dcfce7);color:var(--ok, #22c55e);border-radius:var(--radius-full);font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;">${this.stats.resolved + this.stats.closed}</span>` : nothing}
          </button>
        </div>

        <div class="filter-bar">
          <label>严重度:</label>
          <select @change=${(e: Event) => { this.filterSeverity = (e.target as HTMLSelectElement).value; }}>
            <option value="all">全部</option>
            <option value="critical" ?selected=${this.filterSeverity === 'critical'}>严重</option>
            <option value="error" ?selected=${this.filterSeverity === 'error'}>错误</option>
            <option value="warning" ?selected=${this.filterSeverity === 'warning'}>警告</option>
            <option value="info" ?selected=${this.filterSeverity === 'info'}>提示</option>
          </select>
        </div>
        </div>

        ${this.events.length === 0
          ? html`
              <div class="empty-state">
                <div class="empty-icon">${this.activeListTab === 'resolved' ? renderIcon('check-circle') : renderIcon('triangle-alert')}</div>
                <div>${this.activeListTab === 'resolved' ? '没有已解决事件' : '暂无活跃事件'}</div>
                <div style="font-size:var(--text-sm);margin-top:var(--space-sm);">${this.activeListTab === 'resolved' ? '已解决的事件会出现在这里' : '系统运行正常'}</div>
              </div>
            `
          : html`
              <div class="main-layout">
                <div class="panel">
                  <div class="panel-header">事件列表</div>
                  <div class="event-list">
                    ${filtered.length === 0
                      ? html`<div class="detail-empty">暂无匹配的事件</div>`
                      : filtered.map((event) => html`
                          <div
                            class="event-item ${this.selectedEvent?.id === event.id ? "selected" : ""}"
                            @click=${() => this._selectEvent(event)}
                          >
                            <div class="event-title">${event.title}</div>
                            <div class="event-meta">
                              ${this._statusBadge(event.status)}
                              <span style="color: ${this._severityColor(event.severity)}">${event.severity.toUpperCase()}</span>
                              <span>${event.alert_count} 条告警</span>
                              <span>${event.instance_name || "N/A"}</span>
                              <span>${this._formatTime(event.created_at)}</span>
                            </div>
                          </div>
                        `)}
                  </div>
                  ${this._renderPagination()}
                </div>

                <div class="panel">
                  <div class="panel-header">事件详情</div>
                  ${this.selectedEvent ? this._renderDetail() : html`<div class="detail-empty">选择左侧事件查看详情</div>`}
                </div>
              </div>
            `}
      </div>
    </div>
    `;
  }

  private _renderStats() {
    const s = this.stats!;
    const avgMttr = this.mttr?.avg_mttr_minutes ?? s.avg_resolution_time ?? null;
    return html`
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-value">${s.total}</div>
          <div class="stat-label">总计</div>
        </div>
        <div class="stat-card stat-open">
          <div class="stat-value">${s.open}</div>
          <div class="stat-label">开放</div>
        </div>
        <div class="stat-card stat-investigating">
          <div class="stat-value">${s.investigating}</div>
          <div class="stat-label">调查中</div>
        </div>
        <div class="stat-card stat-resolved">
          <div class="stat-value">${s.resolved}</div>
          <div class="stat-label">已解决</div>
        </div>
        <div class="stat-card stat-closed">
          <div class="stat-value">${s.closed}</div>
          <div class="stat-label">已关闭</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${avgMttr !== null ? `${Math.round(avgMttr)}` : "—"}</div>
          <div class="stat-label">平均 MTTR (分钟)</div>
        </div>
      </div>
    `;
  }

  private _renderDetail() {
    const e = this.selectedEvent!;
    return html`
      <div class="detail-panel">
        <div class="detail-section">
          <h4>基本信息</h4>
          <div class="detail-row"><span class="label">标题</span><span class="value">${e.title}</span></div>
          <div class="detail-row"><span class="label">状态</span><span class="value">${this._statusBadge(e.status)}</span></div>
          <div class="detail-row"><span class="label">严重度</span><span class="value" style="color: ${this._severityColor(e.severity)}">${e.severity.toUpperCase()}</span></div>
          <div class="detail-row"><span class="label">告警数</span><span class="value">${e.alert_count}</span></div>
          <div class="detail-row"><span class="label">实例</span><span class="value">${e.instance_name || "N/A"}</span></div>
          <div class="detail-row"><span class="label">负责人</span><span class="value">${e.assignee || "未分配"}</span></div>
          <div class="detail-row"><span class="label">创建时间</span><span class="value">${this._formatTime(e.created_at)}</span></div>
          ${e.root_cause ? html`<div class="detail-row"><span class="label">根因</span><span class="value">${e.root_cause}</span></div>` : nothing}
        </div>

        ${this.eventMembers.length > 0 ? html`
          <div class="detail-section">
            <h4>关联告警 (${this.eventMembers.length})</h4>
            <div class="alert-member-list">
              ${this.eventMembers.map((m) => html`
                <div class="alert-member-item">
                  <div class="alert-title">${m.title}</div>
                  <div class="alert-meta">
                    ${m.level.toUpperCase()} · ${m.metric_name} = ${m.metric_value} · ${this._formatTime(m.created_at)}
                  </div>
                </div>
              `)}
            </div>
          </div>
        ` : nothing}

        ${this.eventLogs.length > 0 ? html`
          <div class="detail-section">
            <h4>操作记录</h4>
            <div class="timeline">
              ${this.eventLogs.map((log) => html`
                <div class="timeline-item">
                  <span class="timeline-time">${this._formatTime(log.created_at)}</span>
                  <span class="timeline-action">${log.action}</span>
                  ${log.note ? html`<span class="timeline-note">${log.note}</span>` : nothing}
                </div>
              `)}
            </div>
          </div>
        ` : nothing}

        ${e.status !== "closed" ? html`
          <div class="action-bar">
            ${e.status === "open" ? html`<button class="btn btn-primary" @click=${this._startInvestigation} ?disabled=${this.actionLoading}>开始调查</button>` : nothing}
            <button class="btn" @click=${this._triggerRCA} ?disabled=${this.rcaLoading} style="border-color:var(--accent);color:var(--accent);">${this.rcaLoading ? "分析中..." : "AI 根因分析"}</button>
            ${this.rcaResult && this.rcaResult.eventId === Number(this.selectedEvent?.id) ? html`
              <span style="font-size:12px;color:var(--ok);margin-left:8px;">已触发 ${this.rcaResult.analysisIds.length} 个分析</span>
              ${this.rcaResult.sessionKeys.map((sk: string) => html`
                <a href="#" @click=${(e: Event) => { e.preventDefault(); this._navigateToChat(sk); }} style="font-size:11px;color:var(--accent);margin-left:4px;">查看 →</a>
              `)}
              <button class="btn" style="font-size:var(--text-xs);margin-left:var(--space-sm);padding:var(--space-xs) var(--space-sm);" @click=${this._clearRCAResult}>清除</button>
            ` : nothing}
            <button class="btn" @click=${() => { this.showPostmortemForm = !this.showPostmortemForm; }} ?disabled=${this.actionLoading}>添加复盘</button>
            ${["open", "investigating", "handled"].includes(e.status) ? html`<button class="btn btn-primary" @click=${this._resolveEvent} ?disabled=${this.actionLoading}>标记解决</button>` : nothing}
            ${["open", "investigating", "handled", "resolved"].includes(e.status as string) ? html`<button class="btn-primary btn-danger" @click=${this._closeEvent} ?disabled=${this.actionLoading}>关闭事件</button>` : nothing}
          </div>
          <div class="action-bar" style="border-top: none; padding-top: 0; margin-top: var(--space-sm);">
            <textarea
              class="note-input"
              placeholder="添加备注..."
              .value=${this.noteText}
              @input=${(e: Event) => { this.noteText = (e.target as HTMLTextAreaElement).value; }}
            ></textarea>
            <button class="btn" @click=${this._addNote} ?disabled=${this.actionLoading || !this.noteText.trim()}>添加备注</button>
          </div>

          ${this.showPostmortemForm ? html`
            <div class="postmortem-section">
              <textarea
                class="note-input"
                placeholder="输入复盘内容（支持 Markdown）..."
                style="min-height: 120px;"
                .value=${this.postmortemText}
                @input=${(e: Event) => { this.postmortemText = (e.target as HTMLTextAreaElement).value; }}
              ></textarea>
              <div style="margin-top: var(--space-sm); display: flex; gap: var(--space-sm);">
                <button class="btn btn-primary" @click=${this._addPostmortem} ?disabled=${this.actionLoading || !this.postmortemText.trim()}>提交复盘</button>
                <button class="btn" @click=${() => { this.showPostmortemForm = false; this.postmortemText = ""; }}>取消</button>
              </div>
            </div>
          ` : nothing}
        ` : nothing}
      </div>
    `;
  }
}

if (!customElements.get("event-management-page")) {
  customElements.define("event-management-page", EventManagementPage);
}
