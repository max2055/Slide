import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../../../icons.js";
import "../components/metric-chart.js";
import { authFetch } from "../../../api/index.js";

interface HealthHistory {
  health_score: number;
  created_at: string;
}

interface HealthCheck {
  name: string;
  status: string;
  score: number;
  message?: string;
  dimension?: string;
}

interface HealthChecksResponse {
  checks: HealthCheck[];
  status: string;
}

interface CollectionCapability {
  metricId: string;
  name: string;
  available: boolean;
  lastAttempt?: string;
}

@customElement("health-score-tab")
export class HealthScoreTab extends LitElement {
  @property({ type: Number }) instanceId: number | null = null;

  @state() private healthHistory: HealthHistory[] | null = null;
  @state() private latestChecks: HealthCheck[] = [];
  @state() private healthStatus: string = "unknown";
  @state() private capabilities: CollectionCapability[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private timeRange: string = "7d";
  @state() private expandedChecks = false;

  static override styles = css`
    :host {
      display: block;
    }

    .section-title {
      font-size: var(--text-md);
      font-weight: 600;
      color: var(--text-strong);
      margin-bottom: var(--space-md);
    }

    .time-range-btns {
      display: flex;
      gap: var(--space-xs);
      margin-bottom: var(--space-lg);
    }

    .time-range-btn {
      padding: var(--space-xs) var(--space-md);
      font-size: var(--text-sm);
      font-weight: 500;
      color: var(--muted);
      background: var(--secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .time-range-btn:hover {
      color: var(--text);
      border-color: var(--border-strong);
    }

    .time-range-btn.active {
      color: var(--accent);
      border-color: var(--accent);
      background: var(--accent-subtle);
    }

    .score-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--space-xl);
      border-radius: var(--radius-lg);
      border: 1px solid var(--border);
      background: var(--card);
      margin-bottom: var(--space-lg);
    }

    .score-number {
      font-size: 48px;
      font-weight: 700;
      line-height: 1;
    }

    .score-label {
      font-size: var(--text-sm);
      color: var(--muted);
      margin-top: var(--space-sm);
    }

    .check-item {
      display: flex;
      align-items: center;
      padding: var(--space-md);
      border-bottom: 1px solid var(--border);
      gap: var(--space-md);
    }

    .check-item:last-child {
      border-bottom: none;
    }

    .check-status-icon {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
    }

    .check-status-icon svg {
      width: 18px;
      height: 18px;
    }

    .check-status-icon.ok svg { color: var(--ok); }
    .check-status-icon.warn svg { color: var(--warn); }
    .check-status-icon.danger svg { color: var(--destructive); }

    .check-name {
      flex: 1;
      font-size: var(--text-md);
      color: var(--text);
      min-width: 0;
    }

    .check-score {
      display: inline-flex;
      align-items: center;
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      font-weight: 600;
      flex-shrink: 0;
    }

    .check-score.green {
      background: var(--ok-subtle);
      color: var(--ok);
    }

    .check-score.yellow {
      background: var(--warn-subtle);
      color: var(--warn);
    }

    .check-score.red {
      background: var(--danger-subtle);
      color: var(--destructive);
    }

    .check-dimension {
      display: inline-flex;
      align-items: center;
      padding: 2px var(--space-sm);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      background: var(--bg-elevated);
      color: var(--muted);
      flex-shrink: 0;
    }

    .check-message {
      font-size: var(--text-sm);
      color: var(--muted);
      margin-top: var(--space-xs);
    }

    .check-extra {
      margin-top: var(--space-xs);
      margin-left: 36px;
    }

    .capability-grid {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-md);
    }

    .capability-badge {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      background: var(--card);
    }

    .badge-green {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--ok);
      flex-shrink: 0;
    }

    .badge-grey {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--muted);
      opacity: 0.5;
      flex-shrink: 0;
    }

    .badge-icon {
      display: flex;
      align-items: center;
    }

    .badge-icon svg {
      width: 14px;
      height: 14px;
    }

    .badge-name {
      font-size: var(--text-sm);
      color: var(--text);
    }

    .badge-time {
      font-size: var(--text-xs);
      color: var(--muted);
    }

    .collapsible-toggle {
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-md) 0;
      font-size: var(--text-md);
      font-weight: 600;
      color: var(--text-strong);
      border: none;
      background: none;
    }

    .collapsible-toggle:hover {
      color: var(--accent);
    }

    .collapsible-toggle svg {
      width: 16px;
      height: 16px;
      transition: transform 0.2s ease;
    }

    .collapsible-toggle.expanded svg {
      transform: rotate(90deg);
    }

    .collapsible-content {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--card);
      overflow: hidden;
      margin-bottom: var(--space-lg);
    }

    .card-section {
      margin-bottom: var(--space-lg);
    }

    .loading, .error, .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 200px;
      color: var(--muted);
      font-size: var(--text-md);
    }

    .error {
      color: var(--destructive);
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this._loadData();
  }

  private async _loadData() {
    if (!this.instanceId) return;
    this.loading = true;
    this.error = null;

    try {
      const days = this._timeRangeToDays(this.timeRange);
      const [historyRes, checksRes, capsRes] = await Promise.all([
        authFetch(`/api/database/instances/${this.instanceId}/health-history?days=${days}`),
        authFetch(`/api/database/instances/${this.instanceId}/health-checks`),
        authFetch(`/api/database/instances/${this.instanceId}/collection-capabilities`),
      ]);

      if (historyRes.ok) {
        this.healthHistory = await historyRes.json();
      }
      if (checksRes.ok) {
        const data: HealthChecksResponse = await checksRes.json();
        this.latestChecks = data.checks || [];
        this.healthStatus = data.status || "unknown";
      }
      if (capsRes.ok) {
        this.capabilities = await capsRes.json();
      }
    } catch (err: any) {
      this.error = err.message || "加载健康评分数据失败";
    } finally {
      this.loading = false;
    }
  }

  private _onTimeRangeChange(range: string) {
    this.timeRange = range;
    this._loadData();
  }

  private _timeRangeToDays(range: string): number {
    switch (range) {
      case "24h": return 1;
      case "30d": return 30;
      case "7d":
      default: return 7;
    }
  }

  private _getScoreColor(score: number): string {
    if (score >= 80) return "var(--ok)";
    if (score >= 60) return "var(--warn)";
    return "var(--destructive)";
  }

  private _getStatusIcon(status: string) {
    switch (status) {
      case "ok":
        return html`<span style="color: var(--ok);">${icons['check-circle']}</span>`;
      case "warning":
        return html`<span style="color: var(--warn);">${icons['triangle-alert']}</span>`;
      case "critical":
        return html`<span style="color: var(--destructive);">${icons['circle-x']}</span>`;
      default:
        return html`<span style="color: var(--muted);">${icons['circle']}</span>`;
    }
  }

  private _getDimensionLabel(dim?: string): string {
    switch (dim) {
      case "availability": return "可用性";
      case "performance": return "性能";
      case "capacity": return "容量";
      case "security": return "安全性";
      default: return dim || "通用";
    }
  }

  private _getScoreBadgeClass(score: number): string {
    if (score >= 80) return "green";
    if (score >= 60) return "yellow";
    return "red";
  }

  private _getCheckIconClass(status: string): string {
    switch (status) {
      case "ok": return "ok";
      case "warning": return "warn";
      case "critical": return "danger";
      default: return "warn";
    }
  }

  private _getLatestScore(): number {
    if (!this.healthHistory || this.healthHistory.length === 0) return 0;
    return this.healthHistory[this.healthHistory.length - 1].health_score;
  }

  override render() {
    if (this.loading) {
      return html`<div class="loading">加载中...</div>`;
    }

    if (this.error) {
      return html`<div class="error">${this.error}</div>`;
    }

    const score = this._getLatestScore();
    const scoreColor = this._getScoreColor(score);

    return html`
      ${this._renderTimeRangeSelector()}

      <div class="card-section">
        ${this._renderTrendChart()}
      </div>

      <div class="card-section">
        <div class="score-card">
          <div class="score-number" style="color: ${scoreColor};">${score}</div>
          <div class="score-label">当前健康评分</div>
        </div>
      </div>

      <div class="card-section">
        ${this._renderCheckDetails()}
      </div>

      <div class="card-section">
        ${this._renderCapabilities()}
      </div>
    `;
  }

  private _renderTimeRangeSelector() {
    const ranges = [
      { key: "24h", label: "24小时" },
      { key: "7d", label: "7天" },
      { key: "30d", label: "30天" },
    ];

    return html`
      <div class="time-range-btns">
        ${ranges.map(
          (r) => html`
            <button
              class="time-range-btn ${this.timeRange === r.key ? "active" : ""}"
              @click=${() => this._onTimeRangeChange(r.key)}
            >
              ${r.label}
            </button>
          `
        )}
      </div>
    `;
  }

  private _renderTrendChart() {
    if (!this.healthHistory || this.healthHistory.length === 0) {
      return html`<div class="empty">暂无评分数据</div>`;
    }

    const timeData = this.healthHistory.map((h) => {
      const d = new Date(h.created_at);
      return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    });

    const totalScores = this.healthHistory.map((h) => h.health_score);

    return html`
      <metric-chart
        title="健康评分趋势"
        .timeData=${timeData}
        .series=${[
          { name: "总分", data: totalScores, color: "var(--accent)" },
        ]}
        percentage
        height="320px"
      ></metric-chart>
    `;
  }

  private _renderCheckDetails() {
    return html`
      <button
        class="collapsible-toggle ${this.expandedChecks ? "expanded" : ""}"
        @click=${() => { this.expandedChecks = !this.expandedChecks; }}
      >
        ${icons['chevron-right']} 最近健康检查详情
        ${this.latestChecks.length > 0 ? html`<span style="font-weight: 400; color: var(--muted); font-size: var(--text-sm);">(${this.latestChecks.length} 项)</span>` : nothing}
      </button>

      ${this.expandedChecks ? html`
        <div class="collapsible-content">
          ${this.latestChecks.length === 0 ? html`
            <div style="padding: var(--space-xl); text-align: center; color: var(--muted);">
              暂无健康检查数据
            </div>
          ` : this.latestChecks.map((check) => html`
            <div class="check-item">
              <div class="check-status-icon ${this._getCheckIconClass(check.status)}">
                ${this._getStatusIcon(check.status)}
              </div>
              <span class="check-name">${check.name}</span>
              <span class="check-score ${this._getScoreBadgeClass(check.score)}">${check.score}</span>
              <span class="check-dimension">${this._getDimensionLabel(check.dimension)}</span>
            </div>
            ${check.message ? html`
              <div class="check-extra">
                <div class="check-message">${check.message}</div>
              </div>
            ` : nothing}
          `)}
        </div>
      ` : nothing}
    `;
  }

  private _renderCapabilities() {
    return html`
      <div class="section-title">采集能力状态</div>
      <div class="capability-grid">
        ${this.capabilities.length === 0 ? html`
          <div style="color: var(--muted); font-size: var(--text-sm);">暂无采集能力数据</div>
        ` : this.capabilities.map((cap) => html`
          <div class="capability-badge">
            <div class="badge-icon">
              ${cap.available
                ? html`<span class="badge-green"></span>`
                : html`<span class="badge-grey"></span>`}
            </div>
            <span class="badge-name">${cap.name}</span>
            ${cap.lastAttempt ? html`
              <span class="badge-time">${new Date(cap.lastAttempt).toLocaleString("zh-CN")}</span>
            ` : nothing}
          </div>
        `)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "health-score-tab": HealthScoreTab;
  }
}
