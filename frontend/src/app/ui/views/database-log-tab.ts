import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import "./ai-analysis-result.js";

const API_BASE = "";

function getToken(): string | null {
  return localStorage.getItem("token");
}

interface LogEntry {
  id: number;
  instance_id: number;
  log_level: "info" | "warning" | "error" | "critical";
  source: "mysql_slow" | "mysql_error" | "pg_log" | "other";
  message: string;
  raw_content: string | null;
  detected_patterns: Array<{ pattern: string; severity: string; message: string }> | null;
  collected_at: string;
  created_at: string;
}

interface LogStats {
  total: number;
  by_level: { info: number; warning: number; error: number; critical: number };
  by_pattern: Array<{ pattern: string; count: number }>;
  trend: Array<{ time: string; count: number }>;
}

@customElement("database-log-tab")
export class DatabaseLogTab extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host {
      display: block;
    }

    .page {
      padding: 0 0 24px 0;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .header h2 {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-strong);
      margin: 0;
    }

    .header-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }

    .stat-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 12px 16px;
      text-align: center;
    }

    .stat-card .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: var(--text-strong);
    }

    .stat-card .stat-label {
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.03em;
      margin-top: 2px;
    }

    .stat-card.stat-error { border-left: 3px solid var(--danger, #ef4444); }
    .stat-card.stat-warning { border-left: 3px solid var(--warn, #f59e0b); }
    .stat-card.stat-critical { border-left: 3px solid #991b1b; }

    .filter-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }

    .filter-bar label {
      font-size: 13px;
      color: var(--muted);
    }

    .filter-bar select, .filter-bar input {
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--card);
      color: var(--text);
      font-size: 13px;
      outline: none;
    }

    .filter-bar select:focus, .filter-bar input:focus {
      border-color: var(--border-strong);
    }

    .btn {
      padding: 6px 14px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }

    .btn:hover:not(:disabled) { background: var(--bg-secondary); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .btn.primary {
      background: var(--accent);
      color: var(--accent-foreground, #fff);
      border-color: var(--accent);
    }

    .btn.primary:hover:not(:disabled) { background: var(--accent-hover, #2563eb); }

    .table-container {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--card);
    }

    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .table th {
      padding: 8px 12px;
      text-align: left;
      font-size: 12px;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      background: var(--bg-tertiary);
      font-weight: 600;
      white-space: nowrap;
    }

    .table td {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }

    .table tbody tr {
      transition: background 0.15s;
    }

    .table tbody tr:hover {
      background: var(--bg-secondary);
    }

    .table tbody tr.selected {
      background: var(--bg-secondary);
    }

    .level-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
    }

    .level-info { background: #eff6ff; color: #3b82f6; }
    .level-warning { background: #fffbeb; color: #f59e0b; }
    .level-error { background: #fef2f2; color: #ef4444; }
    .level-critical { background: #fef2f2; color: #991b1b; font-weight: 700; }

    .pattern-tag {
      display: inline-block;
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      font-size: 10px;
      background: var(--bg-tertiary);
      color: var(--muted);
      margin-right: 4px;
      white-space: nowrap;
    }

    .source-label {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
    }

    .message-cell {
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }

    .message-cell:hover {
      color: var(--text-strong);
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--muted);
      font-size: 14px;
    }

    .empty-state .empty-icon {
      font-size: 36px;
      margin-bottom: 12px;
      opacity: 0.5;
    }

    .loading {
      text-align: center;
      padding: 40px;
      color: var(--muted);
    }

    .error {
      text-align: center;
      padding: 40px;
      color: var(--destructive);
    }

    .loading-state {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 24px;
      color: var(--muted);
      font-size: 14px;
    }

    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .expanded-row td {
      padding: 12px 16px;
      background: var(--bg-elevated);
    }

    .raw-content {
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 300px;
      overflow-y: auto;
      color: var(--text);
      background: var(--card);
      padding: 12px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
    }

    .pagination {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-top: 16px;
      padding: 12px;
    }

    .pagination-info {
      font-size: 13px;
      color: var(--muted);
    }
  `];

  @property({ type: Number }) instanceId!: number;

  @state() private logs: LogEntry[] = [];
  @state() private stats: LogStats | null = null;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private selectedIds: Set<number> = new Set();
  @state() private expandedId: number | null = null;

  // Filter state
  @state() private filterLevel = "all";
  @state() private filterTimeRange = "24h";
  @state() private filterKeyword = "";

  // Pagination
  @state() private offset = 0;
  @state() private total = 0;
  private readonly limit = 50;

  // AI analysis state
  @state() private analysisLoading = false;
  @state() private analysisId: number | null = null;
  @state() private analysisStatus: "pending" | "running" | "completed" | "failed" = "pending";
  @state() private analysisResult: any = null;
  @state() private analysisError: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    if (this.instanceId) {
      this.loadLogs();
      this.loadStats();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._stopPolling();
  }

  override willUpdate(changedProperties: Map<string, unknown>) {
    if (changedProperties.has("instanceId") && this.instanceId) {
      this.loadLogs();
      this.loadStats();
    }
  }

  private _authHeaders(): Record<string, string> {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async loadLogs() {
    if (!this.instanceId) return;
    this.loading = true;
    this.error = null;
    this.offset = 0;
    try {
      const params = new URLSearchParams({
        instanceId: String(this.instanceId),
        limit: String(this.limit),
        offset: String(this.offset),
      });
      if (this.filterLevel !== "all") {
        params.set("level", this.filterLevel);
      }
      const timeRange = this._getTimeRange(this.filterTimeRange);
      if (timeRange.startTime) {
        params.set("startTime", timeRange.startTime);
        params.set("endTime", timeRange.endTime);
      }
      const res = await fetch(`${API_BASE}/api/logs?${params.toString()}`, {
        headers: this._authHeaders(),
      });
      if (!res.ok) throw new Error(`Failed to load logs: HTTP ${res.status}`);
      const data = await res.json();
      this.logs = data.logs || [];
      this.total = data.total || 0;
    } catch (e: any) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  }

  async loadStats() {
    if (!this.instanceId) return;
    try {
      const hours = this._getTimeRangeHours(this.filterTimeRange);
      const res = await fetch(`${API_BASE}/api/logs/stats?instanceId=${this.instanceId}&hours=${hours}`, {
        headers: this._authHeaders(),
      });
      if (res.ok) {
        this.stats = await res.json();
      }
    } catch {
      // Stats are optional, don't fail if unavailable
    }
  }

  private _getTimeRange(range: string): { startTime: string; endTime: string } {
    const now = new Date();
    let startTime: Date;
    switch (range) {
      case "1h":
        startTime = new Date(now.getTime() - 1 * 60 * 60 * 1000);
        break;
      case "6h":
        startTime = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        break;
      case "24h":
        startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case "7d":
        startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      default:
        startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }
    return {
      startTime: startTime.toISOString(),
      endTime: now.toISOString(),
    };
  }

  private _getTimeRangeHours(range: string): number {
    switch (range) {
      case "1h": return 1;
      case "6h": return 6;
      case "24h": return 24;
      case "7d": return 168;
      default: return 24;
    }
  }

  private _handleFilterChange() {
    this.loadLogs();
    this.loadStats();
  }

  private _handleSearch() {
    // Keyword filtering is done client-side on the loaded logs
    this.loadLogs();
  }

  private _getFilteredLogs(): LogEntry[] {
    let result = this.logs;
    if (this.filterKeyword.trim()) {
      const keyword = this.filterKeyword.trim().toLowerCase();
      result = result.filter(
        (log) =>
          log.message.toLowerCase().includes(keyword) ||
          (log.raw_content && log.raw_content.toLowerCase().includes(keyword))
      );
    }
    return result;
  }

  private _toggleSelect(id: number) {
    const newSelected = new Set(this.selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    this.selectedIds = newSelected;
  }

  private _toggleExpand(id: number) {
    this.expandedId = this.expandedId === id ? null : id;
  }

  private async _triggerAnalysis() {
    if (this.selectedIds.size === 0 || !this.instanceId) return;

    this.analysisLoading = true;
    this.analysisError = null;
    this.analysisResult = null;
    this.analysisId = null;
    this.analysisStatus = "pending";

    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/logs/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          logIds: Array.from(this.selectedIds),
          instanceId: this.instanceId,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error || "AI 分析触发失败");
      }

      const data = await res.json();
      this.analysisId = data.analysisId;
      this._startPolling(data.analysisId);
    } catch (err: any) {
      this.analysisError = err.message || "AI 分析触发失败";
      this.analysisLoading = false;
    }
  }

  private _startPolling(id: number) {
    this._stopPolling();
    this.pollTimer = setInterval(async () => {
      try {
        const token = getToken();
        const res = await fetch(`${API_BASE}/api/logs/analysis/${id}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const data = await res.json();
        this.analysisStatus = data.status;

        if (data.status === "completed") {
          this._stopPolling();
          this.analysisLoading = false;
          this.analysisResult = data.result || data;
        } else if (data.status === "failed") {
          this._stopPolling();
          this.analysisLoading = false;
          this.analysisError = data.error_message || "分析失败";
        }
      } catch {
        // Ignore polling errors, next poll will retry
      }
    }, 3000);
  }

  private _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private _closeAnalysisResult() {
    this._stopPolling();
    this.analysisId = null;
    this.analysisStatus = "pending";
    this.analysisResult = null;
    this.analysisError = null;
    this.analysisLoading = false;
  }

  private _formatTime(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleString("zh-CN");
    } catch {
      return dateStr;
    }
  }

  private _formatTimeAgo(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "刚刚";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} 小时前`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay} 天前`;
  }

  private _truncateMessage(msg: string, maxLen: number = 100): string {
    if (msg.length <= maxLen) return msg;
    return msg.substring(0, maxLen) + "...";
  }

  private _levelLabel(level: string): string {
    const labels: Record<string, string> = {
      info: "INFO",
      warning: "WARNING",
      error: "ERROR",
      critical: "CRITICAL",
    };
    return labels[level] || level;
  }

  private _sourceLabel(source: string): string {
    const labels: Record<string, string> = {
      mysql_slow: "慢查询",
      mysql_error: "错误日志",
      pg_log: "PG 日志",
      other: "其他",
    };
    return labels[source] || source;
  }

  private _renderStats() {
    if (!this.stats) return html``;
    const s = this.stats;
    return html`
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-value">${s.total}</div>
          <div class="stat-label">总日志数</div>
        </div>
        <div class="stat-card stat-error">
          <div class="stat-value">${s.by_level?.error ?? 0}</div>
          <div class="stat-label">ERROR</div>
        </div>
        <div class="stat-card stat-warning">
          <div class="stat-value">${s.by_level?.warning ?? 0}</div>
          <div class="stat-label">WARNING</div>
        </div>
        <div class="stat-card stat-critical">
          <div class="stat-value">${s.by_level?.critical ?? 0}</div>
          <div class="stat-label">CRITICAL</div>
        </div>
      </div>
    `;
  }

  private _renderAnalysisSection() {
    if (!this.analysisId) return html``;

    if (this.analysisStatus === "pending" || this.analysisStatus === "running") {
      return html`
        <div style="margin-top: 16px;">
          <div class="loading-state">
            <div class="spinner"></div>
            <span>AI 日志分析进行中...</span>
          </div>
        </div>
      `;
    }

    if (this.analysisStatus === "failed") {
      return html`
        <div style="margin-top: 16px; padding: 12px; background: var(--danger-subtle); border: 1px solid var(--destructive); border-radius: var(--radius-md); color: var(--destructive); font-size: 14px; display: flex; align-items: center; justify-content: space-between;">
          <span>AI 分析失败: ${this.analysisError || "未知错误"}</span>
          <button class="btn" @click=${this._closeAnalysisResult}>关闭</button>
        </div>
      `;
    }

    // completed - render result inline
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const result = this.analysisResult;
    if (!result) return html``;

    const sections: any[] = [];

    if (result.summary) {
      sections.push(
        html`<div style="margin-bottom:16px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);border:1px solid var(--border);">
          <strong style="color:var(--text-strong);">摘要</strong>
          <p style="margin:8px 0 0;font-size:14px;color:var(--text);line-height:1.6;">${esc(result.summary)}</p>
        </div>`
      );
    }

    for (const [key, value] of Object.entries(result)) {
      if (key === "summary") continue;
      if (Array.isArray(value)) {
        sections.push(
          html`<div style="margin-bottom:12px;">
            <strong style="color:var(--text-strong);font-size:13px;">${esc(key)}</strong>
            <ul style="margin:6px 0 0 20px;font-size:13px;color:var(--text);line-height:1.8;">
              ${value.map(
                (item: any) =>
                  typeof item === "string"
                    ? html`<li>${esc(item)}</li>`
                    : typeof item === "object" && item !== null
                    ? html`<li>${Object.entries(item)
                        .map(([k, v]) => `${esc(k)}: ${esc(String(v))}`)
                        .join("; ")}</li>`
                    : html`<li>${esc(String(item))}</li>`
              )}
            </ul>
          </div>`
        );
      } else if (typeof value === "object" && value !== null) {
        sections.push(
          html`<div style="margin-bottom:12px;">
            <strong style="color:var(--text-strong);font-size:13px;">${esc(key)}</strong>
            <pre style="margin:6px 0 0;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-sm);font-size:12px;color:var(--text);white-space:pre-wrap;overflow-x:auto;">${esc(JSON.stringify(value, null, 2))}</pre>
          </div>`
        );
      } else {
        sections.push(
          html`<div style="margin-bottom:8px;font-size:13px;">
            <strong style="color:var(--text-strong);">${esc(key)}:</strong>
            <span style="color:var(--text);">${esc(String(value))}</span>
          </div>`
        );
      }
    }

    return html`
      <div style="margin-top: 16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-size:14px;font-weight:600;color:var(--text-strong);">AI 分析结果</span>
          <button class="btn" @click=${this._closeAnalysisResult}>关闭</button>
        </div>
        <div style="padding:16px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);">
          ${sections}
        </div>
      </div>
    `;
  }

  override render() {
    if (!this.instanceId) {
      return html`<div class="page"><div class="empty-state">请选择一个数据库实例</div></div>`;
    }

    if (this.loading) {
      return html`<div class="page"><div class="loading">加载日志数据...</div></div>`;
    }

    if (this.error) {
      return html`<div class="page"><div class="error">加载失败: ${this.error}</div></div>`;
    }

    const filteredLogs = this._getFilteredLogs();

    return html`
      <div class="page">
        <div class="header">
          <h2>数据库日志</h2>
          <div class="header-actions">
            <button class="btn" @click=${() => { this.loadLogs(); this.loadStats(); }}>刷新</button>
            <button
              class="btn primary"
              ?disabled=${this.selectedIds.size === 0 || this.analysisLoading}
              @click=${this._triggerAnalysis}
            >
              AI 分析 (${this.selectedIds.size})
            </button>
          </div>
        </div>

        ${this._renderStats()}

        <div class="filter-bar">
          <label>级别:</label>
          <select @change=${(e: Event) => { this.filterLevel = (e.target as HTMLSelectElement).value; this._handleFilterChange(); }}>
            <option value="all" ?selected=${this.filterLevel === "all"}>全部</option>
            <option value="info" ?selected=${this.filterLevel === "info"}>INFO</option>
            <option value="warning" ?selected=${this.filterLevel === "warning"}>WARNING</option>
            <option value="error" ?selected=${this.filterLevel === "error"}>ERROR</option>
            <option value="critical" ?selected=${this.filterLevel === "critical"}>CRITICAL</option>
          </select>
          <label>时间范围:</label>
          <select @change=${(e: Event) => { this.filterTimeRange = (e.target as HTMLSelectElement).value; this._handleFilterChange(); }}>
            <option value="1h" ?selected=${this.filterTimeRange === "1h"}>最近 1 小时</option>
            <option value="6h" ?selected=${this.filterTimeRange === "6h"}>最近 6 小时</option>
            <option value="24h" ?selected=${this.filterTimeRange === "24h"}>最近 24 小时</option>
            <option value="7d" ?selected=${this.filterTimeRange === "7d"}>最近 7 天</option>
          </select>
          <input
            type="text"
            placeholder="关键字搜索..."
            style="min-width: 180px;"
            .value=${this.filterKeyword}
            @input=${(e: Event) => { this.filterKeyword = (e.target as HTMLInputElement).value; }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") this._handleSearch(); }}
          />
          <button class="btn" @click=${this._handleSearch}>搜索</button>
        </div>

        ${this.logs.length === 0
          ? html`
              <div class="empty-state">
                <div class="empty-icon">&#x1F4C4;</div>
                <div>暂无日志数据，日志采集每 5 分钟执行一次</div>
              </div>
            `
          : filteredLogs.length === 0
          ? html`
              <div class="empty-state">
                <div>未找到符合条件的日志</div>
              </div>
            `
          : html`
              <div class="table-container">
                <table class="table">
                  <thead>
                    <tr>
                      <th style="width:40px;text-align:center">
                        <input type="checkbox" @change=${(e: Event) => {
                          const checked = (e.target as HTMLInputElement).checked;
                          if (checked) {
                            this.selectedIds = new Set(filteredLogs.map((l) => l.id));
                          } else {
                            this.selectedIds = new Set();
                          }
                        }} ?checked=${this.selectedIds.size === filteredLogs.length && filteredLogs.length > 0}>
                      </th>
                      <th style="width:160px;text-align:center">时间</th>
                      <th style="width:80px;text-align:center">级别</th>
                      <th style="width:80px;text-align:center">来源</th>
                      <th>消息</th>
                      <th style="width:120px;text-align:center">模式</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${filteredLogs.map(
                      (log) => html`
                        <tr class=${this.selectedIds.has(log.id) ? "selected" : ""}>
                          <td style="text-align:center">
                            <input
                              type="checkbox"
                              ?checked=${this.selectedIds.has(log.id)}
                              @change=${() => this._toggleSelect(log.id)}
                            >
                          </td>
                          <td style="white-space:nowrap;font-size:12px;color:var(--muted);text-align:center">
                            ${this._formatTimeAgo(log.collected_at)}
                          </td>
                          <td style="text-align:center">
                            <span class="level-badge level-${log.log_level}">
                              ${this._levelLabel(log.log_level)}
                            </span>
                          </td>
                          <td style="text-align:center">
                            <span class="source-label">${this._sourceLabel(log.source)}</span>
                          </td>
                          <td>
                            <div class="message-cell" @click=${() => this._toggleExpand(log.id)} title=${log.message}>
                              ${this._truncateMessage(log.message)}
                            </div>
                          </td>
                          <td style="text-align:center">
                            ${log.detected_patterns && log.detected_patterns.length > 0
                              ? log.detected_patterns.map(
                                  (p) => html`<span class="pattern-tag">${p.pattern}</span>`
                                )
                              : html`<span style="color:var(--muted);font-size:11px;">-</span>`}
                          </td>
                        </tr>
                        ${this.expandedId === log.id
                          ? html`
                              <tr class="expanded-row">
                                <td colspan="6">
                                  <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">完整内容</div>
                                  <div class="raw-content">${log.raw_content || log.message}</div>
                                </td>
                              </tr>
                            `
                          : nothing}
                      `
                    )}
                  </tbody>
                </table>
              </div>

              ${this.total > this.limit
                ? html`
                    <div class="pagination">
                      <button class="btn" ?disabled=${this.offset === 0} @click=${() => { this.offset = Math.max(0, this.offset - this.limit); this.loadLogs(); }}>上一页</button>
                      <span class="pagination-info">${this.offset + 1} - ${Math.min(this.offset + this.limit, this.total)} / ${this.total}</span>
                      <button class="btn" ?disabled=${this.offset + this.limit >= this.total} @click=${() => { this.offset += this.limit; this.loadLogs(); }}>下一页</button>
                    </div>
                  `
                : nothing}
            `}

        ${this._renderAnalysisSection()}
      </div>
    `;
  }
}

if (!customElements.get("database-log-tab")) {
  customElements.define("database-log-tab", DatabaseLogTab);
}
