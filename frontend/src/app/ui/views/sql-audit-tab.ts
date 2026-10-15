import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css, type PropertyValues } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, property, state } from "lit/decorators.js";
import { authFetch } from '../../../api/index.js';
import '../components/app-badge.js';

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

// History is an ai_analysis list, not a joined sql_audit_records list.
interface AuditHistoryItem {
  id: number;
  analysis_id?: number;
  sql_text?: string | null;
  risk_level?: string | null;
  status?: string | null;
  audit_level?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
  recovery_reason?: string | null;
  legacy_status?: string | null;
  result?: unknown;
  audit_record?: {
    sql_text?: string | null;
    risk_level?: string | null;
    audit_level?: string | null;
  } | null;
}

const HISTORY_STATUS: Record<string, string> = {
  pending: '等待审核', running: '审核中', completed: '审核完成',
  failed: '审核失败', unknown: '状态待确认', reviewed: '已复核',
};
const HISTORY_RISK: Record<string, string> = {
  P0: '高风险（P0）', P1: '中风险（P1）', P2: '低风险（P2）', none: '未发现风险',
};
const savedText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const statusLabel = (value: unknown) => savedText(value) ? (Object.hasOwn(HISTORY_STATUS, value) ? HISTORY_STATUS[value] : '未知状态') : '状态未记录';
const riskLabel = (value: unknown) => savedText(value) ? (Object.hasOwn(HISTORY_RISK, value) ? HISTORY_RISK[value] : '未知风险等级') : '风险未记录';

@customElement("sql-audit-tab")
export class SqlAuditTab extends LitElement {
  static styles = [sharedFieldStyles, sharedBtnStyles, css`
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
      color: var(--danger);
    }

    .submit-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
    }

    .error-msg {
      padding: 10px 14px;
      background: var(--danger-subtle);
      border: 1px solid var(--danger);
      border-radius: var(--radius-md);
      color: var(--danger);
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
      border: 1px solid var(--danger);
      color: var(--danger);
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
      background: var(--danger);
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

    .history-toggle:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .table-container { container-type: inline-size; }
    .history-time, .history-toggle { white-space: nowrap; }
    .history-detail {
      position: sticky;
      left: var(--space-md);
      width: calc(100cqw - 2 * var(--space-md));
      max-width: 100%;
      box-sizing: border-box;
      overflow-wrap: anywhere;
    }
    .history-detail pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .history-note { color: var(--muted); }

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
  @state() private historyError: string | null = null;
  @state() private expandedHistoryId: number | null = null;
  @state() private expandedHistoryData: AuditHistoryItem | null = null;
  @state() private historyDetailLoading = false;
  @state() private historyDetailError: string | null = null;
  private historyRequest = 0;
  private detailRequest = 0;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private historyPollTimer: ReturnType<typeof setTimeout> | null = null;

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has('instanceId')) void this._loadHistory();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._stopPolling();
    this.historyRequest++;
    this._clearHistoryDetail();
  }

  private _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async _loadHistory() {
    const request = ++this.historyRequest;
    this._clearHistoryDetail();
    if (!this.instanceId) {
      this.history = [];
      this.historyLoading = false;
      this.historyError = '未指定实例，无法查看审核历史';
      return;
    }
    this.historyLoading = true;
    this.historyError = null;
    this.history = [];
    let failure = '审核历史加载失败，请重试';
    try {
      const token = getToken();
      const res = await authFetch(`${API_BASE}/api/sql/audit/instance/${this.instanceId}?limit=20`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        failure = this._historyReadError(res.status, false);
        throw new Error(failure);
      }
      const data = await res.json();
      if (!Array.isArray(data) || data.some(item => !item || !Number.isSafeInteger(item.id) || item.id <= 0)) {
        failure = '审核历史数据格式异常，请重试';
        throw new Error(failure);
      }
      if (request === this.historyRequest) this.history = data;
    } catch {
      if (request === this.historyRequest) this.historyError = failure;
    } finally {
      if (request === this.historyRequest) this.historyLoading = false;
    }
  }

  private _historyReadError(status: number, detail: boolean) {
    if (status === 401) return '登录已失效，请重新登录后查看审核历史';
    if (status === 403) return detail ? '无权限查看此审核详情' : '无权限查看审核历史';
    if (status === 404) return detail ? '审核记录不存在或已不可访问' : '实例不存在或已不可访问';
    return detail ? '审核详情加载失败，请重试' : '审核历史加载失败，请重试';
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
      const res = await authFetch(`${API_BASE}/api/sql/audit`, {
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
        const res = await authFetch(`${API_BASE}/api/sql/audit/${analysisId}/status`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const data = await res.json();
        this.currentStatus = data.status;

        if (data.status === "completed") {
          this._stopPolling();
          this.loading = false;
          // Fetch full result
          const fullRes = await authFetch(`${API_BASE}/api/sql/audit/${analysisId}`, {
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

  private _clearHistoryDetail() {
    this.detailRequest++;
    if (this.historyPollTimer) clearTimeout(this.historyPollTimer);
    this.historyPollTimer = null;
    this.expandedHistoryId = null;
    this.expandedHistoryData = null;
    this.historyDetailLoading = false;
    this.historyDetailError = null;
  }

  private _toggleHistoryExpand(item: AuditHistoryItem) {
    const collapse = this.expandedHistoryId === item.id;
    this._clearHistoryDetail();
    if (collapse) return;
    this.expandedHistoryId = item.id;
    void this._fetchHistoryResult(item);
  }

  private async _fetchHistoryResult(item: AuditHistoryItem) {
    const request = ++this.detailRequest;
    this.historyDetailLoading = true;
    this.historyDetailError = null;
    let failure = '审核详情加载失败，请重试';
    try {
      const token = getToken();
      const res = await authFetch(`${API_BASE}/api/sql/audit/${item.analysis_id || item.id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        failure = this._historyReadError(res.status, true);
        throw new Error(failure);
      }
      const data = await res.json();
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.id !== (item.analysis_id || item.id)) {
        failure = '审核详情数据格式异常，请重试';
        throw new Error(failure);
      }
      if (request !== this.detailRequest) return;
      this.expandedHistoryData = data;
      this.history = this.history.map(row => row.id === item.id ? {
        ...row, status: data.status,
        sql_text: data.audit_record?.sql_text ?? row.sql_text,
        risk_level: data.audit_record?.risk_level ?? row.risk_level,
      } : row);
      // Poll only active analyses; an unknown state must stay unknown.
      if (data.status === 'pending' || data.status === 'running') {
        this.historyPollTimer = setTimeout(() => {
          this.historyPollTimer = null;
          void this._fetchHistoryResult(item);
        }, 3000);
      }
    } catch {
      if (request === this.detailRequest) {
        this.expandedHistoryData = null;
        this.historyDetailError = failure;
      }
    } finally {
      if (request === this.detailRequest) this.historyDetailLoading = false;
    }
  }

  private _getRiskBadgeVariant(riskLevel: unknown): string {
    switch (riskLevel) {
      case "P0": return "danger";
      case "P1": return "warn";
      case "P2": return "info";
      default: return "muted";
    }
  }

  private _getStatusBadgeVariant(status: unknown): string {
    switch (status) {
      case "completed": return "ok";
      case "failed": return "danger";
      case "running": return "info";
      default: return "muted";
    }
  }

  private _formatTimeAgo(dateStr?: string | null): string {
    if (!savedText(dateStr)) return '时间未记录';
    const date = new Date(dateStr);
    if (!Number.isFinite(date.getTime())) return '时间无效';
    if (date.getTime() > Date.now()) return date.toLocaleString('zh-CN');
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
    if (this.historyDetailLoading && !this.expandedHistoryData) {
      return html`<div class="history-detail loading-state" role="status">加载审核详情...</div>`;
    }
    if (this.historyDetailError) {
      return html`<div class="history-detail error-msg" role="alert">${this.historyDetailError}
        <button class="btn" @click=${() => this._fetchHistoryResult(item)}>重试详情</button></div>`;
    }
    const data = this.expandedHistoryData;
    const record = data?.audit_record ?? item.audit_record;
    const sql = record?.sql_text ?? item.sql_text;
    const risk = record?.risk_level ?? item.risk_level;
    const status = data ? data.status : item.status;
    const result = data?.result;
    const hasResult = typeof result === 'string' ? savedText(result)
      : result && typeof result === 'object' && Object.keys(result).length > 0;
    const labels: Record<string, string> = {
      summary: '摘要', raw_content: '审核分析', pre_audit_results: '预审核结果',
      explain_plan: '执行计划', index_info: '索引信息', table_stats: '表统计信息', duration_ms: '分析耗时（毫秒）',
    };
    return html`<div class="history-detail">
      <p>审核状态：<app-badge variant=${this._getStatusBadgeVariant(status)}>${statusLabel(status)}</app-badge></p>
      <p>风险等级：<app-badge variant=${this._getRiskBadgeVariant(risk)}>${riskLabel(risk)}</app-badge></p>
      <p class="history-note">审核状态表示处理进度，完成审核不代表 SQL 无风险。</p>
      <strong>完整 SQL</strong>
      <pre>${savedText(sql) ? sql : '此历史记录未保存 SQL，无法还原原始语句。'}</pre>
      ${!savedText(risk) ? html`<p class="history-note">此历史记录未保存风险等级，不能据此判断 SQL 安全性。</p>` : ''}
      ${data && (status === 'pending' || status === 'running') ? html`<p role="status">审核中，请稍候...</p>` : ''}
      ${data && status === 'failed' ? html`<p role="status">审核失败，未获得完整审核结果。</p>` : ''}
      ${data && (!savedText(status) || !Object.hasOwn(HISTORY_STATUS, status) || status === 'unknown') ? html`<p role="status">无法确认审核是否完成，请核实记录状态。</p>` : ''}
      ${savedText(data?.error_message) ? html`<p>失败说明：${data.error_message}</p>` : ''}
      ${data && hasResult ? html`<div class="result-card">${typeof result === 'string' ? html`<pre>${result}</pre>`
        : Object.entries(result as object).map(([key, value]) => html`<div><strong>${labels[key] ?? key}</strong>
          <pre>${typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '未记录'}</pre></div>`)}</div>` :
        data && status !== 'pending' && status !== 'running' ? html`<p class="history-note">此历史记录未保存分析结果。</p>` : ''}
      <details><summary>记录信息</summary>
        <p>原始状态：${savedText(status) ? status : '未记录'}</p>
        <p>原始风险等级：${savedText(risk) ? risk : '未记录'}</p>
        <p>原始审核级别：${record?.audit_level ?? item.audit_level ?? '未记录'}</p>
        <p>创建时间：${item.created_at ?? '未记录'}</p>
        <p>完成时间：${data?.completed_at ?? item.completed_at ?? '未记录'}</p>
        ${savedText(data?.recovery_reason) ? html`<p>状态说明：${data.recovery_reason}</p>` : ''}
        ${savedText(data?.legacy_status) ? html`<p>历史原始状态：${data.legacy_status}</p>` : ''}
      </details>
    </div>`;
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
                class="btn-primary"
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
            ` : this.historyError ? html`
              <div class="error-msg" role="alert">${this.historyError}
                <button class="btn" @click=${() => this._loadHistory()}>重试历史</button>
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
                      <th>详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.history.map((item) => html`
                      <tr @click=${() => this._toggleHistoryExpand(item)}>
                        <td style="text-align:center;">#${item.id}</td>
                        <td>
                          <div class="history-sql-preview" title="${item.sql_text ?? '列表未提供 SQL，请查看详情'}">
                            ${savedText(item.sql_text) ? this._truncateSql(item.sql_text) : '列表未提供 SQL，请查看详情'}
                          </div>
                        </td>
                        <td style="text-align:center;">
                          <app-badge variant=${this._getRiskBadgeVariant(item.risk_level)}>${savedText(item.risk_level) ? riskLabel(item.risk_level) : '风险未提供'}</app-badge>
                        </td>
                        <td style="text-align:center;">
                          <app-badge variant=${this._getStatusBadgeVariant(item.status)}>${statusLabel(item.status)}</app-badge>
                        </td>
                        <td class="history-time" style="text-align:center;">${this._formatTimeAgo(item.created_at)}</td>
                        <td><button class="btn history-toggle" aria-label=${`审核记录 #${item.id} 详情`}
                          aria-expanded=${this.expandedHistoryId === item.id ? 'true' : 'false'}
                          aria-controls=${`audit-history-detail-${item.id}`}
                          @click=${(event: Event) => { event.stopPropagation(); this._toggleHistoryExpand(item); }}>
                          ${this.expandedHistoryId === item.id ? '收起详情' : '查看详情'}
                        </button></td>
                      </tr>
                      ${this.expandedHistoryId === item.id ? html`
                        <tr class="history-expanded">
                          <td colspan="6" id=${`audit-history-detail-${item.id}`}>
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
