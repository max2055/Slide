import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { icons } from "../../../icons.js";
import "../components/metric-chart.js";
import "../components/app-badge.js";
import "../components/app-card.js";
import "../components/instance-overview-tab.js";
import "../components/instance-metrics-tab.js";
import "../components/instance-diagnosis-modal.js";
import "../components/instance-trend-chart.js";
import "./ai-analysis-result.js";
import "./schema-management.ts";
import "./index-management.ts";
import "./sql-audit-tab.js";
import "./database-log-tab.js";
import "./query-analysis-tab.js";
import "./health-score-tab.js";
import { authFetch } from "../../../api/index.js";

interface InstanceDetail { id: number; name: string; db_type: string; host: string; port: number; database_name: string; username: string; environment: string; description: string; health_status: "healthy"|"warning"|"critical"|"unknown"; health_score: number; status: string; created_at: string; updated_at: string; }
interface MetricsData { cpu_usage: number; memory_usage: number; disk_usage: number; connections: number; max_connections?: number; qps: number; tps: number; active_transactions: number; slow_queries: number; version?: string; uptime_seconds?: number; innodb_buffer_pool_hit_rate?: number; replication_lag?: number; sga_size_mb?: number; pga_size_mb?: number; tablespace_usage_percent?: number; library_cache_hit_rate?: number; active_sessions?: number; enqueue_deadlocks?: number; metrics_data?: Record<string, number>; }
interface SlowQuery { id: string; sql_text: string; avg_time_ms: number; max_time_ms: number; execution_count: number; first_seen: string; last_seen: string; }
interface Session { id: number; user: string; host: string; database: string; command: string; time_seconds: number; state: string; query: string | null; }
interface CapacityInfo { total_size_gb: number; databases?: Array<{ name: string; size_gb: number; table_count?: number }>; tablespaces?: Array<{ name: string; size_gb: number; max_size_gb?: number; usage_percent?: number }>; top_tables: Array<{ name: string; size_gb: number; row_count?: number }>; }
interface MetricDef { id: string; name: string; description: string; unit: string; db_types?: string[]; threshold_template?: Record<string, number|string>; higher_is_worse?: boolean; is_collected: boolean; category?: string; value_type?: string; }

@customElement("instance-detail-page")
export class InstanceDetailPage extends LitElement {
  static override styles = css`
    :host { display: block; animation: fade-in 0.3s ease-out; }
    @keyframes fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
    @keyframes spin { to { transform: rotate(360deg); } }
    .page { padding: 0 0 24px 0; }
    .loading,.empty { display:flex;align-items:center;justify-content:center;min-height:300px;color:var(--muted); }
    .empty-state { text-align:center;padding:60px var(--space-xl); }
    .empty-icon svg { width:48px;height:48px;opacity:0.5; }
    .empty-title { font-size:var(--text-lg);font-weight:600;color:var(--text-strong);margin-bottom:var(--space-sm); }
    .empty-desc { font-size:var(--text-md);color:var(--muted); }
    .loading-pulse { animation:pulse 1.5s ease-in-out infinite; }
    .spinner { width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite; }
    .header { display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-xl);padding-bottom:16px;border-bottom:1px solid var(--border); }
    .header-left { display:flex;align-items:center;gap:var(--space-lg); }
    .back-btn { display:inline-flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm) var(--space-md);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--text-base);font-weight:500;color:var(--text);background:var(--secondary);cursor:pointer; }
    .back-btn:hover { background:var(--bg-hover);border-color:var(--border-strong); }
    .instance-title { font-size:var(--text-2xl);font-weight:600;color:var(--text-strong); }
    .header-right { display:flex;align-items:center;gap:var(--space-md); }
    .last-updated { font-size:var(--text-sm);color:var(--muted); }
    .refresh-btn { display:inline-flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm) var(--space-md);border:1px solid var(--accent);border-radius:var(--radius-sm);font-size:var(--text-sm);font-weight:500;color:var(--accent);background:transparent;cursor:pointer; }
    .refresh-btn:hover { background:var(--accent);color:var(--accent-foreground); }
    .refresh-btn:disabled { opacity:0.6;cursor:not-allowed; }
    .tabs { display:flex;gap:var(--space-xs);margin-bottom:var(--space-xl);border-bottom:1px solid var(--border);overflow-x:auto; }
    .tab { padding:var(--space-md) var(--space-xl);font-size:var(--text-md);font-weight:500;color:var(--muted);background:transparent;border:none;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap; }
    .tab:hover { color:var(--text); }
    .tab.active { color:var(--accent);border-bottom-color:var(--accent); }
    .tab-badge { position:absolute;top:8px;right:4px;min-width:16px;height:16px;padding:0 4px;background:var(--accent);color:var(--accent-foreground);border-radius:var(--radius-full);font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center; }
    .tab { position:relative; }
    .diagnosis-history-list { display:flex;flex-direction:column;gap:var(--space-xs); }
    .diagnosis-history-item { display:flex;align-items:center;gap:var(--space-md);padding:var(--space-sm) var(--space-md);border-radius:var(--radius-md);cursor:pointer; }
    .diagnosis-history-item:hover { background:var(--bg-hover); }
    .diagnosis-summary-text { flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:var(--text-sm);color:var(--text); }
    .diagnosis-time { font-size:var(--text-xs);color:var(--muted);white-space:nowrap;flex-shrink:0; }
    .diagnosis-chevron svg { width:14px;height:14px;color:var(--muted);flex-shrink:0; }
    .table-container { overflow-x:auto;border-radius:var(--radius-md);border:1px solid var(--border); }
    .table { width:100%;border-collapse:separate;border-spacing:0;font-size:var(--text-base); }
    .table th { position:sticky;top:0;z-index:3;padding:var(--space-md) var(--space-lg);text-align:left;font-weight:600;font-size:var(--text-xs);color:var(--muted);background:var(--bg-elevated);border-bottom:1px solid var(--border);white-space:nowrap;text-transform:uppercase;letter-spacing:0.04em; }
    .table td { padding:var(--space-md) var(--space-lg);border-bottom:1px solid var(--border);color:var(--text);vertical-align:middle; }
    .table tbody tr { transition:background 0.15s ease; }
    .table tbody tr:hover { background:var(--bg-hover); }
    .table tbody tr:last-child td { border-bottom:none; }
    .sql-code { font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:var(--text-sm);background:var(--bg-elevated);padding:var(--space-md);border-radius:var(--radius-sm);color:var(--text);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--border); }
    .sql-code:hover { white-space:normal;word-break:break-all; }
    .capacity-list { display:flex;flex-direction:column;gap:var(--space-md); }
    .capacity-item { display:flex;align-items:center;gap:var(--space-lg);padding:var(--space-md) var(--space-lg);background:var(--bg-elevated);border-radius:var(--radius-md);border:1px solid var(--border); }
    .capacity-icon { width:40px;height:40px;border-radius:var(--radius-md);background:var(--accent-subtle);display:flex;align-items:center;justify-content:center;color:var(--accent); }
    .capacity-icon svg { width:18px;height:18px; }
    .capacity-info { flex:1;min-width:0; }
    .capacity-name { font-size:var(--text-md);font-weight:500;color:var(--text-strong);margin-bottom:var(--space-xs); }
    .capacity-meta { font-size:var(--text-sm);color:var(--muted); }
    .capacity-bar-wrap { width:150px; }
    .capacity-percent { font-size:var(--text-sm);font-weight:600;color:var(--text-strong);text-align:right;margin-bottom:var(--space-xs); }
    .progress-bar { height:8px;background:var(--bg-muted);border-radius:var(--radius-full);overflow:hidden; }
    .progress-fill { height:100%;border-radius:var(--radius-full); }
    .progress-fill.ok { background:linear-gradient(90deg,var(--ok),#22c55e); }
    .progress-fill.warn { background:linear-gradient(90deg,var(--warn),#f59e0b); }
    .progress-fill.danger { background:linear-gradient(90deg,var(--destructive),#ef4444); }
  `;

  @state() private instanceId: number | null = null;
  @state() private instance: InstanceDetail | null = null;
  @state() private activeTab: string = "overview";
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private metrics: MetricsData | null = null;
  @state() private slowQueries: SlowQuery[] = [];
  @state() private sessions: Session[] = [];
  @state() private capacity: CapacityInfo | null = null;
  @state() private capHistory: { time: string[]; size: number[] } = { time: [], size: [] };
  @state() private overviewHistory: { time: string[]; metrics: Record<string, number[]> } | null = null;
  @state() private lastUpdated: Date | null = null;
  @state() private autoRefresh = true;
  @state() private isRefreshing = false;
  @state() private topsqlLoading = false;
  @state() private diagnosisStatus: "idle"|"running"|"completed"|"failed" = "idle";
  @state() private diagnosisResult: any = null;
  @state() private diagnosisError: string | null = null;
  @state() private showDiagnosisResult = false;
  @state() private diagnosisHistory: any[] = [];
  @state() private diagnosisHistoryLoading = false;
  @state() private activeDiagnosisRecord: any = null;
  @state() private showDiagnosisModal = false;
  @state() private trendTab = "1h";
  @state() private trendLoading = false;
  @state() private trendData: { time: string[]; metrics: Record<string, number[]> } | null = null;
  @state() private trendLoaded = false;
  @state() private metricsHistory: Record<string, number[]> = {};
  @state() private metricRegistry: MetricDef[] = [];
  private diagnosisPollTimer: ReturnType<typeof setInterval> | null = null;
  private diagnosisPollingStart = 0;
  private refreshTimer: number | null = null;
  private readonly REFRESH_INTERVAL = 30000;

  override firstUpdated() {
    this.loadFromUrl();
    window.addEventListener("slide-navigate", (e: any) => {
      if (e.detail.tab === "instance-detail" && e.detail.id) {
        this.instanceId = e.detail.id; this.activeTab = "overview"; this.loadData();
      }
    });
    window.addEventListener("popstate", () => this.loadFromUrl());
    this.startAutoRefresh();
  }
  override disconnectedCallback() { super.disconnectedCallback(); this.stopAutoRefresh(); this._stopDiagnosisPolling(); }

  private loadFromUrl() {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) { this.instanceId = parseInt(id); this.loadData(); }
  }
  private startAutoRefresh() {
    this.stopAutoRefresh();
    if (this.autoRefresh) this.refreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") this.refreshCurrentTab();
    }, this.REFRESH_INTERVAL);
  }
  private stopAutoRefresh() { if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; } }

  private async loadData() {
    if (!this.instanceId) return;
    this.loading = true; this.error = null;
    try {
      const res = await authFetch(`/api/database/instances/${this.instanceId}`);
      if (!res.ok) throw new Error("获取实例详情失败");
      this.instance = await res.json();
      this.loadDiagnosisHistory();
      await this.loadTabData();
    } catch (err: any) { this.error = err.message; }
    finally { this.loading = false; this.lastUpdated = new Date(); }
  }

  private async refreshCurrentTab() {
    if (!this.instanceId || this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      const res = await authFetch(`/api/database/instances/${this.instanceId}`);
      if (res.ok) this.instance = await res.json();
      await this.loadTabData();
      this.lastUpdated = new Date();
    } catch { /* ignore refresh errors */ }
    finally { this.isRefreshing = false; }
  }

  private async loadTabData() {
    if (!this.instanceId) return;
    try {
      this._loadTopSqlData().catch(() => {});
      switch (this.activeTab) {
        case "overview":
        case "metrics": {
          const [mr, hr] = await Promise.all([
            authFetch(`/api/database/instances/${this.instanceId}/metrics`),
            authFetch(`/api/database/instances/${this.instanceId}/metrics/history?period=24h&interval=1h`),
          ]);
          this.loadMetricRegistry(true).catch(() => {});
          if (mr.ok) { const m = await mr.json(); this.updateMetricsHistory(m); this.metrics = m; }
          if (hr.ok) { const h = await hr.json(); this.overviewHistory = { time: h.time || [], metrics: h.metrics || {} }; }
          break;
        }
        case "topsql": {
          const tr = await authFetch(`/api/database/instances/${this.instanceId}/topsql`);
          if (tr.ok) this.slowQueries = await tr.json();
          break;
        }
        case "sessions": {
          const sr = await authFetch(`/api/database/instances/${this.instanceId}/sessions`);
          if (sr.ok) this.sessions = await sr.json();
          break;
        }
        case "capacity": {
          const [cr, chr] = await Promise.all([
            authFetch(`/api/database/instances/${this.instanceId}/capacity`),
            authFetch(`/api/database/instances/${this.instanceId}/capacity/history?hours=168`),
          ]);
          if (cr.ok) this.capacity = await cr.json();
          if (chr.ok) { const h = await chr.json(); if (h.history) { this.capHistory = { time: h.history.map((x: any) => x.recorded_at?.substring(0, 16)||""), size: h.history.map((x: any) => x.total_size_gb||0) }; } }
          break;
        }
      }
    } catch {/* ignore tab data errors */}
  }

  private async loadTrendData(period: string) {
    if (!this.instanceId) return;
    if (this.metricRegistry.length === 0) await this.loadMetricRegistry();
    this.trendLoading = true; this.trendTab = period;
    try {
      const collected = this._filteredRegistry.filter(d => d.is_collected).map(d => d.id);
      const mp = collected.length > 0 ? `&metrics=${collected.join(',')}` : '';
      const res = await authFetch(`/api/database/instances/${this.instanceId}/metrics/history?period=${period}&interval=5m${mp}`);
      if (res.ok) { const d = await res.json(); this.trendData = { time: d.time || [], metrics: d.metrics || {} }; this.trendLoaded = true; }
    } catch { /* ignore trend errors */ }
    this.trendLoading = false;
  }

  private updateMetricsHistory(m: any) {
    const MAX = 20;
    for (const def of this._filteredRegistry.filter(d => d.is_collected)) {
      const v = m[def.id] ?? m.metrics_data?.[def.id];
      if (v != null) {
        if (!this.metricsHistory[def.id]) this.metricsHistory[def.id] = [];
        this.metricsHistory[def.id] = [...this.metricsHistory[def.id].slice(-(MAX - 1)), Number(v)];
      }
    }
  }

  private get _filteredRegistry() {
    const dbType = this.instance?.db_type;
    if (!dbType) return this.metricRegistry;
    return this.metricRegistry.filter(d => !d.db_types || d.db_types.length === 0 || d.db_types.includes(dbType));
  }

  private async loadMetricRegistry(force = false) {
    if (!force && this.metricRegistry.length > 0) return;
    try {
      const res = await authFetch("/api/metrics/registry");
      if (res.ok) this.metricRegistry = await res.json();
    } catch { /* ignore */ }
  }

  private _goBack() { const u = new URL(window.location.href); u.searchParams.set("tab", "instances-db"); u.searchParams.delete("id"); window.history.pushState({}, "", u); window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab: "instances-db" } })); }
  private _setTab(tab: string) { this.activeTab = tab; this.loadTabData(); if (tab === "trend" && !this.trendLoaded) this.loadTrendData(this.trendTab); }
  private _toggleAutoRefresh() { this.autoRefresh = !this.autoRefresh; this.startAutoRefresh(); }
  private async _manualRefresh() { await this.refreshCurrentTab(); }
  private async _loadTopSqlData() {
    if (!this.instanceId) return;
    this.topsqlLoading = true;
    try { const r = await authFetch(`/api/database/instances/${this.instanceId}/topsql`); if (r.ok) this.slowQueries = await r.json(); }
    catch { /* ignore */ }
    finally { this.topsqlLoading = false; }
  }

  // ---- Diagnosis ----
  private async _startDiagnosis() {
    if (!this.instanceId || this.diagnosisStatus === "running") return;
    try {
      const res = await authFetch("/api/ai/analysis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis_type: "fault_diagnosis", instance_id: this.instanceId, trigger_type: "manual" }) });
      if (!res.ok) throw new Error("提交诊断失败");
      const data = await res.json();
      this.diagnosisStatus = "running"; this.diagnosisError = null; this.showDiagnosisResult = true; this.showDiagnosisModal = true;
      this._startDiagnosisPolling(data.id);
    } catch (err: any) { this.diagnosisStatus = "failed"; this.diagnosisError = err.message || "提交诊断失败"; this.showDiagnosisResult = true; this.showDiagnosisModal = true; }
  }
  private _startDiagnosisPolling(analysisId: number) {
    this._stopDiagnosisPolling(); this.diagnosisPollingStart = Date.now();
    this.diagnosisPollTimer = setInterval(async () => {
      try {
        if (Date.now() - this.diagnosisPollingStart > 5 * 60 * 1000) { this._stopDiagnosisPolling(); this.diagnosisStatus = "failed"; this.diagnosisError = "诊断超时"; return; }
        const res = await authFetch(`/api/ai/analysis/${analysisId}/status`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === "completed") {
          this.diagnosisStatus = "completed";
          const fr = await authFetch(`/api/ai/analysis/${analysisId}`);
          if (fr.ok) this.diagnosisResult = await fr.json();
          this._stopDiagnosisPolling(); this.loadDiagnosisHistory();
        } else if (data.status === "failed") { this.diagnosisStatus = "failed"; this.diagnosisError = data.error_message || "诊断失败"; this._stopDiagnosisPolling(); }
      } catch { /* ignore */ }
    }, 3000);
  }
  private _stopDiagnosisPolling() { if (this.diagnosisPollTimer) { clearInterval(this.diagnosisPollTimer); this.diagnosisPollTimer = null; } }
  private async loadDiagnosisHistory() {
    if (!this.instanceId) return;
    this.diagnosisHistoryLoading = true;
    try { const r = await authFetch(`/api/ai/analysis/recent?instance_id=${this.instanceId}&analysis_type=fault_diagnosis&limit=5`); if (r.ok) this.diagnosisHistory = await r.json(); }
    catch { /* ignore */ }
    finally { this.diagnosisHistoryLoading = false; }
  }
  private _formatDiagnosisTime(dateStr: string): string {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const s = Math.floor(diffMs / 1000); if (s < 60) return "刚刚";
    const m = Math.floor(s / 60); if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60); if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24); return d < 7 ? `${d} 天前` : new Date(dateStr).toLocaleDateString("zh-CN");
  }
  private _closeDiagnosisModal() { this.showDiagnosisModal = false; this.activeDiagnosisRecord = null; }
  private _onPeriodChange(e: CustomEvent) { this.loadTrendData(e.detail.period); }

  private _formatTimeAgo(date: Date | null): string {
    if (!date) return "从未更新";
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "刚刚更新";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    return `${Math.floor(seconds / 3600)} 小时前`;
  }

  private _healthBadge() {
    const s = this.instance?.health_status;
    const m: Record<string, { variant: string; label: string }> = { healthy: { variant: "ok", label: "健康" }, warning: { variant: "warn", label: "警告" }, critical: { variant: "danger", label: "异常" }, unknown: { variant: "warn", label: "未知" } };
    const b = m[s || ""] || { variant: "warn", label: s || "未知" };
    return html`<app-badge variant=${b.variant}>${b.label}</app-badge>`;
  }

  // ---- Render ----
  override render() {
    if (this.loading && !this.instance) return html`<div class="loading loading-pulse">加载中...</div>`;
    if (this.error) return html`<div class="empty"><div class="empty-state"><div class="empty-title">加载失败</div><div class="empty-desc">${this.error}</div></div></div>`;
    if (!this.instance) return html`<div class="empty"><div class="empty-state"><div class="empty-title">实例不存在</div></div></div>`;

    return html`
      <div class="page">
        <div class="header">
          <div class="header-left">
            <button class="back-btn" @click=${this._goBack}>← 返回列表</button>
            <span class="instance-title">${this.instance.name}</span>
            ${this._healthBadge()}
          </div>
          <div class="header-right">
            <span class="last-updated">${this._formatTimeAgo(this.lastUpdated)}</span>
            <button class="refresh-btn" @click=${() => { this.showDiagnosisModal = true; if (this.diagnosisStatus === "idle") this._startDiagnosis(); }}
              style="${this.diagnosisStatus === "running" ? "border-color:var(--warn);color:var(--warn);" : ""}">
              ${this.diagnosisStatus === "running" ? "诊断中..." : "一键诊断"}
            </button>
            <button class="refresh-btn" @click=${this._manualRefresh} ?disabled=${this.isRefreshing}>
              ${this.isRefreshing ? "⟳" : "↻"} 刷新
            </button>
          </div>
        </div>

        ${this._renderDiagnosisHistory()}

        <div class="tabs">
          ${["overview","metrics","topsql","trend","health","sessions","capacity","schema","indexes","sqlaudit","logs","qan"].map(t => html`
            <button class="tab ${this.activeTab === t ? "active" : ""}" @click=${() => this._setTab(t)}>
              ${({ overview:"概览", metrics:"实时监控", topsql:"慢查询", trend:"趋势", health:"健康评分", sessions:"会话", capacity:"容量", schema:"表结构", indexes:"索引", sqlaudit:"SQL 审核", logs:"日志", qan:"查询分析" } as Record<string,string>)[t]}
              ${t === "topsql" && this.slowQueries.length > 0 ? html`<span class="tab-badge">${this.slowQueries.length}</span>` : ""}
              ${t === "sessions" && this.sessions.length > 0 ? html`<span class="tab-badge">${this.sessions.length}</span>` : ""}
            </button>
          `)}
        </div>

        ${this._renderTabContent()}

        <instance-diagnosis-modal
          .instanceId=${this.instanceId}
          .open=${this.showDiagnosisModal}
          .diagnosis=${this.diagnosisResult}
          .loading=${this.diagnosisStatus === "running"}
          .error=${this.diagnosisError}
          @close=${this._closeDiagnosisModal}
          @request-diagnosis=${this._startDiagnosis}
        ></instance-diagnosis-modal>
      </div>`;
  }

  private _renderDiagnosisHistory() {
    if (this.diagnosisHistoryLoading) return html`<app-card style="margin-bottom:var(--space-lg);"><span slot="header">AI 诊断历史</span><div style="display:flex;align-items:center;justify-content:center;gap:10px;padding:40px;color:var(--muted);"><div class="spinner"></div><span>加载中...</span></div></app-card>`;

    return html`
      <app-card style="margin-bottom:var(--space-lg);">
        <span slot="header">AI 诊断历史 <span style="font-size:var(--text-xs);color:var(--muted);">最近 ${this.diagnosisHistory.length} 条</span></span>
        ${this.diagnosisHistory.length === 0 ? html`
          <div style="text-align:center;padding:40px;color:var(--muted);"><span style="font-size:var(--text-md);">暂无诊断记录</span></div>
        ` : html`
          <div class="diagnosis-history-list">
            ${this.diagnosisHistory.map((r: any) => {
              const statusStyle = r.status === "completed" ? { cls: "ok", label: "已完成" } : r.status === "failed" ? { cls: "danger", label: "分析失败" } : { cls: "info", label: "进行中" };
              const raw = typeof r.result === 'string' ? r.result : "";
              const summary = raw.replace(/^#+\s*/gm, "").trim().substring(0, 80);
              return html`<div class="diagnosis-history-item" @click=${() => { this.activeDiagnosisRecord = r; this.showDiagnosisModal = true; }}>
                <app-badge variant=${statusStyle.cls} style="font-size:var(--text-xs);padding:2px 8px;flex-shrink:0;">${statusStyle.label}</app-badge>
                <span class="diagnosis-time">${this._formatDiagnosisTime(r.updated_at || r.created_at)}</span>
                <span class="diagnosis-summary-text" title="${summary}">${summary}${raw.length > 80 ? "..." : ""}</span>
                ${icons['chevron-right']}
              </div>`;
            })}
          </div>
        `}
      </app-card>`;
  }

  private _renderTabContent() {
    switch (this.activeTab) {
      case "overview": return html`<instance-overview-tab .instance=${this.instance} .metrics=${this.metrics} .metricRegistry=${this._filteredRegistry} .overviewHistory=${this.overviewHistory} .metricsHistory=${this.metricsHistory}></instance-overview-tab>`;
      case "metrics": return html`<instance-metrics-tab .metricRegistry=${this._filteredRegistry} .metrics=${this.metrics} .metricsHistory=${this.metricsHistory}></instance-metrics-tab>`;
      case "trend": return html`<instance-trend-chart .trendData=${this.trendData} .loading=${this.trendLoading} .activePeriod=${this.trendTab} .metricRegistry=${this._filteredRegistry} @period-change=${this._onPeriodChange}></instance-trend-chart>`;
      case "health": return html`<health-score-tab .instanceId=${this.instanceId}></health-score-tab>`;
      case "topsql": return this._renderTopSQL();
      case "sessions": return this._renderSessions();
      case "capacity": return this._renderCapacity();
      case "schema": return html`<schema-management-page .instanceId=${this.instanceId}></schema-management-page>`;
      case "indexes": return html`<index-management-page .instanceId=${this.instanceId}></index-management-page>`;
      case "sqlaudit": return html`<sql-audit-tab .instanceId=${this.instanceId}></sql-audit-tab>`;
      case "logs": return html`<database-log-tab .instanceId=${this.instanceId}></database-log-tab>`;
      case "qan": return html`<query-analysis-tab .instanceId=${this.instanceId}></query-analysis-tab>`;
      default: return html`<instance-overview-tab .instance=${this.instance} .metrics=${this.metrics} .metricRegistry=${this._filteredRegistry} .overviewHistory=${this.overviewHistory} .metricsHistory=${this.metricsHistory}></instance-overview-tab>`;
    }
  }

  private _renderTopSQL() {
    if (this.topsqlLoading) return html`<app-card><div class="loading loading-pulse" style="min-height:200px;">加载慢查询数据...</div></app-card>`;
    if (this.slowQueries.length === 0) return html`<app-card><div class="empty-state"><div class="empty-title">暂无慢查询</div><div class="empty-desc">数据库运行良好，未发现慢查询</div></div></app-card>`;
    return html`
      <app-card>
        <span slot="header">慢查询列表（Top ${this.slowQueries.length}）</span>
        <div class="table-container">
          <table class="table">
            <thead><tr><th>SQL 语句</th><th style="width:100px;text-align:center;">平均耗时</th><th style="width:100px;text-align:center;">最大耗时</th><th style="width:90px;text-align:center;">执行次数</th><th style="width:140px;text-align:center;">最后出现</th></tr></thead>
            <tbody>${this.slowQueries.map(q => html`<tr>
              <td><div class="sql-code" title="${q.sql_text}">${q.sql_text.substring(0, 80)}${q.sql_text.length > 80 ? "..." : ""}</div></td>
              <td style="text-align:center;"><span style="color:${Number(q.avg_time_ms) > 1000 ? 'var(--destructive)' : Number(q.avg_time_ms) > 100 ? 'var(--warn)' : 'var(--ok)'};font-weight:600;">${Number(q.avg_time_ms).toFixed(2)} ms</span></td>
              <td style="text-align:center;">${Number(q.max_time_ms).toFixed(2)} ms</td>
              <td style="text-align:center;">${Number(q.execution_count).toLocaleString()}</td>
              <td style="text-align:center;">${new Date(q.last_seen).toLocaleString("zh-CN")}</td>
            </tr>`)}</tbody>
          </table>
        </div>
      </app-card>`;
  }

  private _renderSessions() {
    if (this.sessions.length === 0) return html`<app-card><div class="empty-state"><div class="empty-title">无活跃会话</div><div class="empty-desc">当前没有活跃的数据库会话</div></div></app-card>`;
    return html`
      <app-card>
        <span slot="header">活跃会话 (${this.sessions.length})</span>
        <div class="table-container">
          <table class="table">
            <thead><tr><th style="width:70px;text-align:center;">ID</th><th>用户</th><th>来源</th><th>数据库</th><th style="width:90px;text-align:center;">命令</th><th style="width:80px;text-align:center;">时间</th><th>当前查询</th></tr></thead>
            <tbody>${this.sessions.map(s => html`<tr>
              <td style="text-align:center;">${s.id}</td><td>${s.user}</td><td>${s.host}</td><td style="text-align:center;">${s.database || "—"}</td>
              <td style="text-align:center;"><span style="padding:2px 8px;background:var(--bg-muted);border-radius:var(--radius-sm);font-size:var(--text-xs);">${s.command}</span></td>
              <td style="text-align:center;"><span style="color:${s.time_seconds > 60 ? 'var(--destructive)' : s.time_seconds > 10 ? 'var(--warn)' : 'var(--ok)'};font-weight:600;">${s.time_seconds}s</span></td>
              <td><div class="sql-code" title="${s.query||""}">${s.query ? (s.query.substring(0, 40) + (s.query.length > 40 ? "..." : "")) : "—"}</div></td>
            </tr>`)}</tbody>
          </table>
        </div>
      </app-card>`;
  }

  private _renderCapacity() {
    if (!this.capacity) return html`<app-card><div class="empty-state"><div class="empty-title">暂无容量数据</div><div class="empty-desc">实例可能未连接或暂无数据</div></div></app-card>`;
    const cap = this.capacity;
    return html`
      ${this.capHistory.time.length > 0 ? html`<metric-chart title="存储增长趋势 (过去7天)" height="220px" yAxisLabel="GB" .timeData=${this.capHistory.time} .series=${[{ name: "容量", data: this.capHistory.size, color: "var(--accent)" }]}></metric-chart><div style="height:16px"></div>` : nothing}
      <app-card>
        <span slot="header">存储总览：${cap.total_size_gb.toFixed(2)} GB</span>
        ${cap.databases && cap.databases.length > 0 ? html`<h4 style="font-size:var(--text-md);color:var(--text-strong);margin:0 0 16px 0;">数据库</h4><div class="capacity-list">${cap.databases.map(db => html`<div class="capacity-item"><div class="capacity-icon">${icons['database']}</div><div class="capacity-info"><div class="capacity-name">${db.name}</div><div class="capacity-meta">${db.size_gb.toFixed(2)} GB${db.table_count ? ` · ${db.table_count} 张表` : ""}</div></div></div>`)}</div>` : ""}
        ${cap.tablespaces && cap.tablespaces.length > 0 ? html`<h4 style="font-size:var(--text-md);color:var(--text-strong);margin:24px 0 16px 0;">表空间</h4><div class="capacity-list">${cap.tablespaces.map(ts => html`<div class="capacity-item"><div class="capacity-icon">${icons['package']}</div><div class="capacity-info"><div class="capacity-name">${ts.name}</div><div class="capacity-meta">${ts.size_gb.toFixed(2)} GB / ${ts.max_size_gb?.toFixed(2) || "∞"} GB</div></div>${ts.usage_percent !== undefined ? html`<div class="capacity-bar-wrap"><div class="capacity-percent" style="color:${ts.usage_percent > 90 ? 'var(--destructive)' : ts.usage_percent > 70 ? 'var(--warn)' : 'var(--ok)'}">${ts.usage_percent.toFixed(1)}%</div><div class="progress-bar"><div class="progress-fill ${ts.usage_percent > 90 ? 'danger' : ts.usage_percent > 70 ? 'warn' : 'ok'}" style="width:${ts.usage_percent}%"></div></div></div>` : ""}</div>`)}</div>` : ""}
        <h4 style="font-size:var(--text-md);color:var(--text-strong);margin:24px 0 16px 0;">最大表（Top ${cap.top_tables.length}）</h4><div class="capacity-list">${cap.top_tables.map(t => html`<div class="capacity-item"><div class="capacity-icon">${icons['file-text']}</div><div class="capacity-info"><div class="capacity-name">${t.name}</div><div class="capacity-meta">${t.size_gb.toFixed(2)} GB${t.row_count ? ` · ${t.row_count.toLocaleString()} 行` : ""}</div></div></div>`)}</div>
      </app-card>`;
  }
}

if (!customElements.get("instance-detail-page")) {
  customElements.define("instance-detail-page", InstanceDetailPage);
}
