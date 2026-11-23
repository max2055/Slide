import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import { icons } from "../../../icons.js";
import "../components/metric-chart.js";
import { authFetch } from "../../../api/index.js";
import { resolveHealthScoreState, observationTimeState, evidenceTime, evidenceTimeState, type HealthScoreInstanceState } from "./health-score-state.js";

import type { OverviewItem } from './dashboard-model.js';

interface HealthHistory {
  status?: string;
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
  created_at?: string;
  checks: HealthCheck[];
  status: string;
}

interface HealthScoreInstance extends HealthScoreInstanceState {
  last_health_check_at?: string;
  health_score?: number | null;
}

function isHealthScoreInstance(value: unknown): value is HealthScoreInstance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const instance = value as Record<string, unknown>;
  return typeof instance.health_status === "string"
    && typeof instance.hasCredential === "boolean"
    && (typeof instance.health_score === "number" || instance.health_score === null);
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
  @state() private latestChecksAt: string | null = null;
  @state() private latestChecksStatus = "unknown";
  @state() private healthStatus: string = "unknown";
  @state() private instanceState: HealthScoreInstance | null = null;
  @state() private collectionEnabled: boolean | null = null;
  @state() private overview: OverviewItem | null = null;
  @state() private capabilities: CollectionCapability[] = [];
  @state() private loading = true;
  @state() private evidenceError: string | null = null;
  @state() private historyError = '';
  @state() private capabilitiesError = '';
  @state() private checksRead = false;
  @state() private historyLoading = false;
  @state() private capabilitiesLoading = false;
  @state() private accessError = '';
  @state() private timeRange: string = "7d";
  @state() private expandedChecks = false;
  private loadRequestVersion = 0;
  private historyRequest = 0;

  static override styles = [sharedBtnStyles, css`
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
      color: var(--accent-text);
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
    .check-status-icon.danger svg { color: var(--danger); }

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
      color: var(--danger);
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
      color: var(--accent-text);
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
      color: var(--danger);
    }
  `];

  private ageTimer?: ReturnType<typeof setInterval>;
  private readonly accessChanged = () => {
    this.loadRequestVersion++;
    this.resetData();
    this.loading = this.historyLoading = this.capabilitiesLoading = false;
    this.accessError = '健康评分不可访问，请确认登录和查看权限';
  };

  override disconnectedCallback() {
    clearInterval(this.ageTimer);
    this.loadRequestVersion++;
    window.removeEventListener('slide-permissions-loaded', this.accessChanged);
    window.removeEventListener('slide-session-expired', this.accessChanged);
    super.disconnectedCallback();
  }
  override willUpdate(changes: Map<string, unknown>) {
    if (changes.has('instanceId')) void this._loadData();
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.accessChanged);
    window.addEventListener('slide-session-expired', this.accessChanged);
    this.ageTimer = setInterval(() => this.requestUpdate(), 30_000);
    if (this.hasUpdated) void this._loadData();
  }

  private resetData() {
    this.healthHistory = null;
    this.latestChecks = [];
    this.latestChecksAt = null;
    this.latestChecksStatus = "unknown";
    this.healthStatus = "unknown";
    this.instanceState = null;
    this.overview = null;
    this.collectionEnabled = null;
    this.capabilities = [];
    this.evidenceError = null;
    this.historyError = this.capabilitiesError = '';
    this.checksRead = false;
  }

  private async _loadData() {
    this.loadRequestVersion++;
    this.accessError = '';
    this.resetData();
    if (!this.instanceId) { this.loading = false; return; }
    await Promise.all([this.loadHistory(), this.loadEvidence(), this.loadCapabilities()]);
  }

  private async read<T>(path: string, current: () => boolean, instanceScoped = true): Promise<T> {
    const res = await authFetch(path, { signal: AbortSignal.timeout(15000) });
    if (current() && (res.status === 401 || (instanceScoped && [403, 404].includes(res.status)))) this.accessChanged();
    if (!res.ok) throw new Error();
    return res.json();
  }

  private async loadHistory() {
    const id = this.instanceId, version = this.loadRequestVersion;
    if (!id || this.accessError) return;
    const days = this._timeRangeToDays(this.timeRange), request = ++this.historyRequest;
    const current = () => request === this.historyRequest && version === this.loadRequestVersion && id === this.instanceId;
    this.historyLoading = true;
    this.healthHistory = null;
    this.historyError = '';
    try {
      const history = await this.read<HealthHistory[]>(`/api/database/instances/${id}/health-history?days=${days}`, current);
      if (!Array.isArray(history)) throw new Error();
      if (current()) this.healthHistory = history;
    } catch {
      if (current()) this.historyError = '评分历史读取失败';
    } finally { if (current()) this.historyLoading = false; }
  }

  private async loadEvidence() {
    const id = this.instanceId, version = this.loadRequestVersion;
    if (!id || this.accessError) return;
    const current = () => version === this.loadRequestVersion && id === this.instanceId;
    this.loading = true;
    this.evidenceError = null;
    const path = `/api/database/instances/${id}`;
    const [checks, instance, overview, collection] = await Promise.allSettled([
      this.read<HealthChecksResponse>(`${path}/health-checks`, current),
      this.read<unknown>(path, current),
      this.read<{ items: OverviewItem[] }>('/api/resources/overview', current, false),
      this.read<{ effective_enabled?: { enabled?: boolean } }>(`/api/metrics/config/resources/instance/${id}/status`, current, false),
    ] as const);
    if (!current()) return;
    const validChecks = checks.status === 'fulfilled' && Array.isArray(checks.value?.checks);
    const validInstance = instance.status === 'fulfilled' && isHealthScoreInstance(instance.value);
    const validOverview = overview.status === 'fulfilled' && Array.isArray(overview.value?.items);
    const enabled = collection.status === 'fulfilled' ? collection.value?.effective_enabled?.enabled : undefined;

    this.checksRead = validChecks;
    this.latestChecks = validChecks ? checks.value.checks : [];
    this.latestChecksAt = validChecks ? checks.value.created_at ?? null : null;
    this.latestChecksStatus = validChecks ? checks.value.status : 'unknown';
    this.instanceState = validInstance ? instance.value as HealthScoreInstance : null;
    this.healthStatus = this.instanceState?.health_status ?? 'unknown';
    this.overview = validOverview ? overview.value.items.find(item => item?.resource?.type === 'instance' && item.resource.id === id) ?? null : null;
    this.collectionEnabled = typeof enabled === 'boolean' ? enabled : null;
    if (!validChecks || !validInstance || !validOverview || this.collectionEnabled === null) {
      this.evidenceError = '当前评分证据读取失败或无权查看';
    }
    this.loading = false;
  }

  private async loadCapabilities() {
    const id = this.instanceId, version = this.loadRequestVersion;
    if (!id || this.accessError) return;
    const current = () => version === this.loadRequestVersion && id === this.instanceId;
    this.capabilitiesLoading = true;
    this.capabilitiesError = '';
    this.capabilities = [];
    try {
      const capabilities = await this.read<CollectionCapability[]>(`/api/database/instances/${id}/collection-capabilities`, current);
      if (!Array.isArray(capabilities)) throw new Error();
      if (current()) this.capabilities = capabilities;
    } catch {
      if (current()) this.capabilitiesError = '采集能力读取失败';
    } finally { if (current()) this.capabilitiesLoading = false; }
  }

  private _onTimeRangeChange(range: string) {
    if (range === this.timeRange) return;
    this.timeRange = range;
    void this.loadHistory();
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
    return "var(--danger)";
  }

  private _getStatusIcon(status: string) {
    switch (status) {
      case "ok":
        return html`<span style="color: var(--ok);">${icons['check-circle']}</span>`;
      case "warning":
        return html`<span style="color: var(--warn);">${icons['triangle-alert']}</span>`;
      case "critical":
        return html`<span style="color: var(--danger);">${icons['circle-x']}</span>`;
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

  private _getLatestScore(): number | null {
    if (this.collectionEnabled !== true) return null;
    const at = Date.parse(this.latestChecksAt ?? '');
    const instanceAt = Date.parse(this.instanceState?.last_health_check_at ?? '');
    if (!this.latestChecks.length || !['healthy', 'warning', 'critical'].includes(this.latestChecksStatus)
      || this.latestChecksStatus !== this.instanceState?.health_status
      || this.latestChecks.some(check => !['ok', 'warning', 'critical'].includes(check.status) || !Number.isFinite(check.score) || check.score < 0 || check.score > 100)
      || !Number.isFinite(at) || Math.abs(at - instanceAt) > 2000) return null;
    return resolveHealthScoreState(this.instanceState, this.instanceState?.health_score, this.overview).score;
  }

  override render() {
    if (!this.instanceId) return nothing;
    if (this.accessError) {
      return html`${this._renderTimeRangeSelector()}<p role="alert" class="error">${this.accessError} <button class="btn btn-refresh" @click=${this._loadData}>重试健康评分</button></p>`;
    }

    const score = this._getLatestScore();
    const scoreColor = score === null ? "var(--muted)" : this._getScoreColor(score);

    return html`
      ${this._renderTimeRangeSelector()}

      <div class="card-section">
        ${this._renderTrendChart()}
      </div>

      <div class="card-section">
        <div class="score-card">
          <div class="score-number" style="color: ${scoreColor};">${this.loading ? "读取中" : score ?? "未知"}</div>
          <div class="score-label">当前健康评分</div>
          <div class="score-label">采集：${this.collectionEnabled === true ? '已启用' : this.collectionEnabled === false ? '已暂停' : '状态未知'}</div>
          <div class="score-label">正式观测：${evidenceTime(this.overview?.observedAt)} · ${evidenceTimeState(this.overview?.observedAt)}</div>
          <div class="score-label">健康检查：${evidenceTime(this.latestChecksAt)} · ${evidenceTimeState(this.latestChecksAt)}</div>
          ${this.loading ? html`<div class="score-label" role="status">正在读取当前评分证据…</div>`
            : this.evidenceError ? html`<div class="score-label" role="alert">${this.evidenceError} <button class="btn btn-refresh" @click=${this.loadEvidence}>重试当前评分</button></div>`
            : score === null ? html`<div class="score-label">当前证据不足、检查不完整或采集暂停；历史评分仅供回溯</div>` : nothing}
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
    if (this.historyLoading) return html`<p class="loading" role="status">正在读取评分历史…</p>`;
    if (this.historyError) return html`<p class="error" role="alert">${this.historyError} <button class="btn btn-refresh" @click=${this.loadHistory}>重试评分历史</button></p>`;
    if (!this.healthHistory) return nothing;
    if (this.healthHistory.length === 0) {
      return html`<div class="empty">所选时间范围内没有历史评分记录</div>`;
    }

    const timeData = this.healthHistory.map((h) => {
      const d = new Date(h.created_at);
      return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    });

    const totalScores = this.healthHistory.map((h) => ["unknown", "error"].includes(h.status ?? "") || !Number.isFinite(h.health_score) ? null : h.health_score);

    return html`
      <metric-chart
        title="历史健康评分（不代表当前健康）"
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
    const scoreAvailable = this._getLatestScore() !== null;
    const checksAt = Date.parse(this.latestChecksAt ?? '');
    const instanceAt = Date.parse(this.instanceState?.last_health_check_at ?? '');
    const freshIncomplete = this.instanceState?.hasCredential === true
      && this.latestChecksStatus === 'unknown' && this.healthStatus === 'unknown'
      && observationTimeState(this.latestChecksAt) === 'fresh'
      && Number.isFinite(checksAt) && Number.isFinite(instanceAt) && Math.abs(checksAt - instanceAt) <= 2000;
    return html`
      <button
        class="collapsible-toggle ${this.expandedChecks ? "expanded" : ""}"
        aria-expanded=${String(this.expandedChecks)}
        @click=${() => { this.expandedChecks = !this.expandedChecks; }}
      >
        ${icons['chevron-right']} 最近健康检查详情
        ${this.latestChecks.length > 0 ? html`<span style="font-weight: 400; color: var(--muted); font-size: var(--text-sm);">(${this.latestChecks.length} 项)</span>` : nothing}
      </button>

      ${this.expandedChecks ? html`
        <div class="collapsible-content">
          ${!this.checksRead ? html`<p>${this.loading ? '正在读取最近健康检查…' : '最近健康检查读取失败，请重试当前评分'}</p>`
            : (!scoreAvailable && !freshIncomplete) || this.latestChecks.length === 0 ? html`
            <div style="padding: var(--space-xl); text-align: center; color: var(--muted);">
              ${this.latestChecks.length ? "当前证据不足以展示检查评分" : "没有已保存的健康检查记录"}
            </div>
          ` : this.latestChecks.map((check) => html`
            <div class="check-item">
              <div class="check-status-icon ${this._getCheckIconClass(check.status)}">
                ${this._getStatusIcon(check.status)}
              </div>
              <span class="check-name">${check.name}</span>
              <span class="check-score ${check.status === 'unknown' ? '' : this._getScoreBadgeClass(check.score)}">${check.status === 'unknown' ? '未知' : check.score}</span>
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
        ${this.capabilitiesLoading ? html`<p role="status">正在读取采集能力…</p>`
          : this.capabilitiesError ? html`<p role="alert">${this.capabilitiesError} <button class="btn btn-refresh" @click=${this.loadCapabilities}>重试采集能力</button></p>`
          : this.capabilities.length === 0 ? html`
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
