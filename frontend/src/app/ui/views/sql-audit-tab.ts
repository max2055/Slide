import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, property, state } from "lit/decorators.js";

const API_BASE = "";

const MAX_SQL_LENGTH = 50 * 1024; // 50KB

function getToken(): string | null {
  return localStorage.getItem("token");
}

interface PreAuditRisk {
  level: "warning" | "error";
  code: string;
  message: string;
  suggestion: string;
}

interface AuditHistoryItem {
  id: number;
  analysis_id: number;
  sql_text: string;
  risk_level: "P0" | "P1" | "P2" | "none";
  status: "pending" | "running" | "completed" | "failed";
  audit_level: "basic" | "full";
  created_at: string;
  completed_at: string | null;
}

@customElement("sql-audit-tab")
export class SqlAuditTab extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host {
      display: block;
    }

    .section {
      margin-bottom: 16px;
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-elevated);
    }

    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-strong);
    }

    .card-body {
      padding: 16px;
    }

    .sql-textarea {
      width: 100%;
      min-height: 120px;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-elevated);
      color: var(--text);
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 13px;
      line-height: 1.5;
      resize: vertical;
      box-sizing: border-box;
    }

    .sql-textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
    }

    .sql-textarea::placeholder {
      color: var(--muted);
    }

    .char-counter {
      text-align: right;
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
    }

    .char-counter.over-limit {
      color: var(--destructive);
    }

    .submit-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
    }

    .btn.primary {
      padding: 8px 20px;
      border-radius: var(--radius-md);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--accent);
      background: var(--accent);
      color: white;
      transition: all var(--duration-normal) var(--ease-out);
    }

    .btn.primary:hover:not(:disabled) {
      opacity: 0.9;
    }

    .btn.primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .error-msg {
      padding: 10px 14px;
      background: var(--danger-subtle);
      border: 1px solid var(--destructive);
      border-radius: var(--radius-md);
      color: var(--destructive);
      font-size: 13px;
      margin-top: 12px;
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

    .pre-audit-section {
      margin-top: 16px;
    }

    .risk-list {
      list-style: none;
      padding: 0;
      margin: 8px 0 0;
    }

    .risk-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 12px;
      margin-bottom: 6px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      line-height: 1.5;
    }

    .risk-item.warning {
      background: rgba(234, 179, 8, 0.1);
      border: 1px solid rgba(234, 179, 8, 0.3);
      color: var(--warn);
    }

    .risk-item.error {
      background: var(--danger-subtle);
      border: 1px solid var(--destructive);
      color: var(--destructive);
    }

    .risk-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .risk-badge.warning {
      background: rgba(234, 179, 8, 0.2);
      color: var(--warn);
    }

    .risk-badge.error {
      background: var(--destructive);
      color: white;
    }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }

    .badge-risk-p0 {
      background: #7c3aed;
      color: white;
    }

    .badge-risk-p1 {
      background: #ea580c;
      color: white;
    }

    .badge-risk-p2 {
      background: #2563eb;
      color: white;
    }

    .badge-risk-none {
      background: var(--ok);
      color: white;
    }

    .badge-status-pending {
      background: var(--muted);
      color: var(--text);
    }

    .badge-status-running {
      background: #2563eb;
      color: white;
    }

    .badge-status-completed {
      background: var(--ok);
      color: white;
    }

    .badge-status-failed {
      background: var(--destructive);
      color: white;
    }

    .history-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .history-table th {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 2px solid var(--border);
      font-weight: 600;
      color: var(--text-strong);
      font-size: 12px;
      white-space: nowrap;
    }

    .history-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }

    .history-table tbody tr {
      cursor: pointer;
      transition: background var(--duration-normal) var(--ease-out);
    }

    .history-table tbody tr:hover {
      background: var(--bg-hover);
    }

    .history-sql-preview {
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 12px;
      color: var(--text);
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .history-expanded {
      background: var(--bg-elevated);
    }

    .history-expanded td {
      padding: 16px;
    }

    .result-card {
      margin-top: 8px;
      padding: 12px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
    }

    .empty-state {
      text-align: center;
      padding: 32px;
      color: var(--muted);
      font-size: 14px;
    }

    .analysis-result-content {
      font-size: 14px;
      line-height: 1.6;
      color: var(--text);
    }

    .analysis-result-content p {
      margin: 8px 0;
    }

    .analysis-result-content ul {
      margin: 6px 0 0 20px;
    }

    .analysis-result-content li {
      margin-bottom: 4px;
    }

    .analysis-result-content pre {
      margin: 8px 0;
      padding: 10px;
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
      font-size: 12px;
      white-space: pre-wrap;
      overflow-x: auto;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--secondary);
      color: var(--text);
      transition: all var(--duration-normal) var(--ease-out);
    }

    .btn:hover {
      background: var(--bg-hover);
    }
  `];

  @property({ type: Number }) instanceId!: number;

  @state() private sqlText = "";
  @state() private loading = false;
  @state() private submitError: string | null = null;
  @state() private currentAnalysisId: number | null = null;
  @state() private currentPreAudit: PreAuditRisk[] = [];
  @state() private currentResult: any = null;
  @state() private currentStatus: "pending" | "running" | "completed" | "failed" = "pending";
  @state() private history: AuditHistoryItem[] = [];
  @state() private historyLoading = true;
  @state() private expandedHistoryId: number | null = null;
  @state() private expandedHistoryResult: any = null;
  @state() private expandedHistoryStatus: string = "pending";

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private historyPollTimers: Map<number, ReturnType<typeof setInterval>> = new Map();

  override connectedCallback() {
    super.connectedCallback();
    if (this.instanceId) {
      this._loadHistory();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._stopPolling();
    for (const timer of this.historyPollTimers.values()) {
      clearInterval(timer);
    }
    this.historyPollTimers.clear();
  }

  private _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async _loadHistory() {
    if (!this.instanceId) return;
    this.historyLoading = true;
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/sql/audit/instance/${this.instanceId}?limit=20`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        this.history = await res.json();
      }
    } catch (err) {
      console.error("Failed to load audit history:", err);
    } finally {
      this.historyLoading = false;
    }
  }

  async _submitAudit() {
    if (!this.sqlText.trim() || this.loading) return;

    this.loading = true;
    this.submitError = null;
    this.currentPreAudit = [];
    this.currentResult = null;
    this.currentAnalysisId = null;

    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/sql/audit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          sql_text: this.sqlText.trim(),
          instance_id: this.instanceId,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error || "提交审核失败");
      }

      const data = await res.json();
      this.currentAnalysisId = data.analysis_id;
      this.currentPreAudit = data.pre_audit_results || [];
      this.currentStatus = "pending";

      // Start polling for LLM result
      this._startPolling(data.analysis_id);

      // Reload history
      this._loadHistory();
    } catch (err: any) {
      this.submitError = err.message || "提交审核失败";
      this.loading = false;
    }
  }

  async submitAuditForSlowQuery(sqlText: string, _slowQueryId: number) {
    this.sqlText = sqlText;
    await this._submitAudit();
  }

  private _startPolling(analysisId: number) {
    this._stopPolling();
    this.pollTimer = setInterval(async () => {
      try {
        const token = getToken();
        const res = await fetch(`${API_BASE}/api/sql/audit/${analysisId}/status`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const data = await res.json();
        this.currentStatus = data.status;

        if (data.status === "completed") {
          this._stopPolling();
          this.loading = false;
          // Fetch full result
          const fullRes = await fetch(`${API_BASE}/api/sql/audit/${analysisId}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (fullRes.ok) {
            const fullData = await fullRes.json();
            this.currentResult = fullData.result || fullData;
          }
          // Reload history to show completed status
          this._loadHistory();
        } else if (data.status === "failed") {
          this._stopPolling();
          this.loading = false;
          this.submitError = data.error_message || "审核失败";
        }
      } catch {
        // Ignore polling errors, next poll will retry
      }
    }, 3000);
  }

  private _startHistoryPolling(analysisId: number) {
    // Clear existing timer for this analysis
    if (this.historyPollTimers.has(analysisId)) {
      clearInterval(this.historyPollTimers.get(analysisId)!);
    }

    const timer = setInterval(async () => {
      try {
        const token = getToken();
        const res = await fetch(`${API_BASE}/api/sql/audit/${analysisId}/status`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const data = await res.json();

        if (data.status === "completed") {
          clearInterval(timer);
          this.historyPollTimers.delete(analysisId);
          this.expandedHistoryStatus = "completed";
          // Fetch full result
          const fullRes = await fetch(`${API_BASE}/api/sql/audit/${analysisId}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (fullRes.ok) {
            const fullData = await fullRes.json();
            this.expandedHistoryResult = fullData.result || fullData;
          }
        } else if (data.status === "failed") {
          clearInterval(timer);
          this.historyPollTimers.delete(analysisId);
          this.expandedHistoryStatus = "failed";
        } else {
          this.expandedHistoryStatus = data.status;
        }
      } catch {
        // Ignore polling errors
      }
    }, 3000);
    this.historyPollTimers.set(analysisId, timer);
  }

  private _toggleHistoryExpand(item: AuditHistoryItem) {
    if (this.expandedHistoryId === item.id) {
      // Collapse
      this.expandedHistoryId = null;
      this.expandedHistoryResult = null;
      const timer = this.historyPollTimers.get((item.analysis_id || item.id));
      if (timer) {
        clearInterval(timer);
        this.historyPollTimers.delete((item.analysis_id || item.id));
      }
      return;
    }

    this.expandedHistoryId = item.id;
    this.expandedHistoryResult = null;
    this.expandedHistoryStatus = item.status;

    if (item.status === "completed") {
      // Fetch result directly
      this._fetchHistoryResult((item.analysis_id || item.id));
    } else if (item.status === "pending" || item.status === "running") {
      this._startHistoryPolling((item.analysis_id || item.id));
    }
  }

  private async _fetchHistoryResult(analysisId: number) {
    const token = getToken();
    const res = await fetch(`${API_BASE}/api/sql/audit/${analysisId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = await res.json();
      this.expandedHistoryResult = data.result || data;
    }
  }

  private _getRiskBadgeClass(riskLevel: string): string {
    switch (riskLevel) {
      case "P0": return "badge-risk-p0";
      case "P1": return "badge-risk-p1";
      case "P2": return "badge-risk-p2";
      default: return "badge-risk-none";
    }
  }

  private _getStatusBadgeClass(status: string): string {
    return `badge-status-${status}`;
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

  private _truncateSql(sql: string, maxLen: number = 60): string {
    if (!sql) return "";
    if (sql.length <= maxLen) return sql;
    return sql.substring(0, maxLen) + "...";
  }

  private _renderAnalysisResult() {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    if (!this.currentResult) return html``;

    const result = this.currentResult;
    const sections: any[] = [];

    if (result.summary) {
      sections.push(html`<div style="margin-bottom:16px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);border:1px solid var(--border);"><strong style="color:var(--text-strong);">摘要</strong><p style="margin:8px 0 0;font-size:14px;color:var(--text);line-height:1.6;">${esc(result.summary)}</p></div>`);
    }

    for (const [key, value] of Object.entries(result)) {
      if (key === "summary") continue;
      if (Array.isArray(value)) {
        sections.push(html`<div style="margin-bottom:12px;"><strong style="color:var(--text-strong);font-size:13px;">${esc(key)}</strong><ul style="margin:6px 0 0 20px;font-size:13px;color:var(--text);line-height:1.8;">${value.map((item: any) => {
          if (typeof item === "string") return html`<li>${esc(item)}</li>`;
          if (typeof item === "object" && item !== null) {
            const entries = Object.entries(item).map(([k, v]) => `${esc(k)}: ${esc(String(v))}`).join("; ");
            return html`<li>${entries}</li>`;
          }
          return html`<li>${esc(String(item))}</li>`;
        })}</ul></div>`);
      } else if (typeof value === "object" && value !== null) {
        sections.push(html`<div style="margin-bottom:12px;"><strong style="color:var(--text-strong);font-size:13px;">${esc(key)}</strong><pre style="margin:6px 0 0;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-sm);font-size:12px;color:var(--text);white-space:pre-wrap;overflow-x:auto;">${esc(JSON.stringify(value, null, 2))}</pre></div>`);
      } else {
        sections.push(html`<div style="margin-bottom:8px;font-size:13px;"><strong style="color:var(--text-strong);">${esc(key)}:</strong> <span style="color:var(--text);">${esc(String(value))}</span></div>`);
      }
    }

    return html`<div class="result-card">${sections}</div>`;
  }

  private _renderHistoryResult(item: AuditHistoryItem) {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    if (this.expandedHistoryStatus === "pending" || this.expandedHistoryStatus === "running") {
      return html`
        <div class="loading-state">
          <div class="spinner"></div>
          <span>审核中，请稍候...</span>
        </div>
      `;
    }

    if (this.expandedHistoryStatus === "failed") {
      return html`<div class="error-msg">审核失败</div>`;
    }

    if (!this.expandedHistoryResult) {
      return html`
        <div class="loading-state">
          <div class="spinner"></div>
          <span>加载结果中...</span>
        </div>
      `;
    }

    const result = this.expandedHistoryResult;
    const sections: any[] = [];

    if (result.summary) {
      sections.push(html`<div style="margin-bottom:16px;padding:12px;background:var(--bg-elevated);border-radius:var(--radius-md);border:1px solid var(--border);"><strong style="color:var(--text-strong);">摘要</strong><p style="margin:8px 0 0;font-size:14px;color:var(--text);line-height:1.6;">${esc(result.summary)}</p></div>`);
    }

    for (const [key, value] of Object.entries(result)) {
      if (key === "summary") continue;
      if (Array.isArray(value)) {
        sections.push(html`<div style="margin-bottom:12px;"><strong style="color:var(--text-strong);font-size:13px;">${esc(key)}</strong><ul style="margin:6px 0 0 20px;font-size:13px;color:var(--text);line-height:1.8;">${value.map((item: any) => {
          if (typeof item === "string") return html`<li>${esc(item)}</li>`;
          if (typeof item === "object" && item !== null) {
            const entries = Object.entries(item).map(([k, v]) => `${esc(k)}: ${esc(String(v))}`).join("; ");
            return html`<li>${entries}</li>`;
          }
          return html`<li>${esc(String(item))}</li>`;
        })}</ul></div>`);
      } else if (typeof value === "object" && value !== null) {
        sections.push(html`<div style="margin-bottom:12px;"><strong style="color:var(--text-strong);font-size:13px;">${esc(key)}</strong><pre style="margin:6px 0 0;padding:10px;background:var(--bg-elevated);border-radius:var(--radius-sm);font-size:12px;color:var(--text);white-space:pre-wrap;overflow-x:auto;">${esc(JSON.stringify(value, null, 2))}</pre></div>`);
      } else {
        sections.push(html`<div style="margin-bottom:8px;font-size:13px;"><strong style="color:var(--text-strong);">${esc(key)}:</strong> <span style="color:var(--text);">${esc(String(value))}</span></div>`);
      }
    }

    return html`<div class="result-card">${sections}</div>`;
  }

  override render() {
    return html`
      <!-- SQL Input Section -->
      <div class="section">
        <div class="card">
          <div class="card-header">
            <span class="card-title">SQL 审核</span>
          </div>
          <div class="card-body">
            <textarea
              class="sql-textarea"
              placeholder="请输入待审核的 SQL 语句..."
              .value=${this.sqlText}
              @input=${(e: Event) => {
                this.sqlText = (e.target as HTMLTextAreaElement).value;
              }}
              maxlength="${MAX_SQL_LENGTH}"
            ></textarea>
            <div class="char-counter ${this.sqlText.length > MAX_SQL_LENGTH ? "over-limit" : ""}">
              ${this.sqlText.length.toLocaleString()} / ${MAX_SQL_LENGTH.toLocaleString()} 字符
            </div>
            <div class="submit-row">
              <button
                class="btn primary"
                ?disabled=${!this.sqlText.trim() || this.loading}
                @click=${() => this._submitAudit()}
              >
                提交审核
              </button>
              ${this.loading ? html`<div class="spinner"></div><span style="font-size:13px;color:var(--muted);">提交中...</span>` : ""}
            </div>
            ${this.submitError ? html`<div class="error-msg">${this.submitError}</div>` : ""}

            <!-- Pre-audit results -->
            ${this.currentPreAudit.length > 0 ? html`
              <div class="pre-audit-section">
                <div style="font-size:13px;font-weight:600;color:var(--text-strong);margin-bottom:8px;">预审核结果（风险检测）</div>
                <ul class="risk-list">
                  ${this.currentPreAudit.map((risk) => html`
                    <li class="risk-item ${risk.level}">
                      <span class="risk-badge ${risk.level}">${risk.level === "error" ? "错误" : "警告"}</span>
                      <span><strong>${risk.code}:</strong> ${risk.message}</span>
                    </li>
                  `)}
                </ul>
              </div>
            ` : ""}

            <!-- LLM analysis result -->
            ${this.currentAnalysisId && (this.currentStatus === "pending" || this.currentStatus === "running") ? html`
              <div class="pre-audit-section">
                <div class="loading-state">
                  <div class="spinner"></div>
                  <span>LLM 深度分析进行中...</span>
                </div>
              </div>
            ` : ""}

            ${this.currentResult ? html`
              <div class="pre-audit-section">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                  <span style="font-size:13px;font-weight:600;color:var(--text-strong);">LLM 审核结果</span>
                  <button class="btn" @click=${() => {
                    this.currentAnalysisId = null;
                    this.currentResult = null;
                    this.currentPreAudit = [];
                    this.currentStatus = "pending";
                  }}>关闭</button>
                </div>
                ${this._renderAnalysisResult()}
              </div>
            ` : ""}
          </div>
        </div>
      </div>

      <!-- Audit History Section -->
      <div class="section">
        <div class="card">
          <div class="card-header">
            <span class="card-title">审核历史</span>
          </div>
          <div class="card-body">
            ${this.historyLoading ? html`
              <div class="loading-state">
                <div class="spinner"></div>
                <span>加载审核历史...</span>
              </div>
            ` : this.history.length === 0 ? html`
              <div class="empty-state">暂无审核记录</div>
            ` : html`
              <div class="table-container" style="overflow-x:auto;">
                <table class="history-table">
                  <thead>
                    <tr>
                      <th style="width:50px; text-align:center;">ID</th>
                      <th>SQL</th>
                      <th style="width:80px; text-align:center;">风险等级</th>
                      <th style="width:80px; text-align:center;">状态</th>
                      <th style="width:100px; text-align:center;">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.history.map((item) => html`
                      <tr @click=${() => this._toggleHistoryExpand(item)}>
                        <td style="text-align:center;">#${item.id}</td>
                        <td>
                          <div class="history-sql-preview" title="${item.sql_text}">
                            ${this._truncateSql(item.sql_text)}
                          </div>
                        </td>
                        <td style="text-align:center;">
                          <span class="badge ${this._getRiskBadgeClass(item.risk_level)}">${item.risk_level}</span>
                        </td>
                        <td style="text-align:center;">
                          <span class="badge ${this._getStatusBadgeClass(item.status)}">${item.status}</span>
                        </td>
                        <td style="text-align:center;">${this._formatTimeAgo(item.created_at)}</td>
                      </tr>
                      ${this.expandedHistoryId === item.id ? html`
                        <tr class="history-expanded">
                          <td colspan="5">
                            ${this._renderHistoryResult(item)}
                          </td>
                        </tr>
                      ` : ""}
                    `)}
                  </tbody>
                </table>
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("sql-audit-tab")) {
  customElements.define("sql-audit-tab", SqlAuditTab);
}
