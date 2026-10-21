import "../components/investigation-operation-context.ts";
import '../components/resource-investigation-links.js';
import "../components/semantic-metrics.js";
import "../components/resource-collection-section.js";
import { returnToDashboard, freshness, type Overview, type OverviewItem } from './dashboard-model.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { icons } from "../../../icons.js";
import "../components/metric-chart.js";
import "../components/app-badge.js";
import "../components/app-card.js";
import "../components/app-empty-state.js";
import "../components/instance-diagnosis-modal.js";
import "./ai-analysis-result.js";
import "./schema-management.ts";
import "./index-management.ts";
import "./sql-audit-tab.js";
import "./database-log-tab.js";
import "./query-analysis-tab.js";
import "./health-score-tab.js";
import { authFetch } from "../../../api/index.js";

import { currentHealthStatus, evidenceTime, evidenceTimeState } from './health-score-state.js';

interface InstanceDetail { hasCredential?: boolean; id: number; name: string; db_type: string; host: string; port: number; database_name: string; username: string; environment: string; description: string; health_status: "healthy"|"warning"|"critical"|"unknown"|"error"; health_score: number; status: string; created_at: string; updated_at: string; }
interface SlowQuery { id: string; sql_text: string; avg_time_ms: number; max_time_ms: number; execution_count: number; first_seen: string; last_seen: string; }
interface Session { id: number; user: string; host: string; database: string; command: string; time_seconds: number; state: string; query: string | null; }
type ReadStatus = 'idle' | 'loading' | 'success' | 'error' | 'forbidden' | 'unavailable';
interface QueryRead { status: ReadStatus; instanceId: number | null; readAt?: number; source?: string; }
interface CapacityInfo { observed_at?: string; source?: string; scope?: string; total_size_gb: number; databases?: Array<{ name: string; size_gb: number; table_count?: number }>; tablespaces?: Array<{ name: string; size_gb: number; max_size_gb?: number; usage_percent?: number }>; top_tables: Array<{ name: string; size_gb: number; row_count?: number }>; }

@customElement("instance-detail-page")
export class InstanceDetailPage extends LitElement {
  static override styles = [sharedBtnStyles, css`
    :host { display: block; animation: fade-in 0.3s ease-out; }
    @keyframes fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
    @keyframes spin { to { transform: rotate(360deg); } }
    .page { padding:0;min-width:0;max-width:100%;overflow-x:hidden; }
    .loading,.empty { display:flex;align-items:center;justify-content:center;min-height:300px;color:var(--muted); }
    .empty-state { text-align:center;padding:60px var(--space-xl); }
    .empty-icon svg { width:48px;height:48px;opacity:0.5; }
    .empty-title { font-size:var(--text-lg);font-weight:600;color:var(--text-strong);margin-bottom:var(--space-sm); }
    .empty-desc { font-size:var(--text-md);color:var(--muted); }
    .loading-pulse { animation:pulse 1.5s ease-in-out infinite; }
    .spinner { width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite; }
    .header { display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--space-md);min-width:0;margin-bottom:var(--space-xl);padding-bottom:16px;border-bottom:1px solid var(--border); }
    .header-left { display:flex;align-items:center;gap:var(--space-lg);min-width:0;flex:1 1 auto;flex-wrap:wrap; }
    .back-btn { display:inline-flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm) var(--space-md);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--text-base);font-weight:500;color:var(--text);background:var(--secondary);cursor:pointer; }
    .back-btn:hover { background:var(--bg-hover);border-color:var(--border-strong); }
    .back-btn,.refresh-btn { flex-shrink:0;white-space:nowrap; }
    .back-btn svg, .refresh-btn svg { width:16px;height:16px;flex-shrink:0; }
    .instance-title { min-width:0;flex:1 1 12rem;font-size:var(--text-2xl);font-weight:600;color:var(--text-strong);overflow-wrap:anywhere; }
    .header-right { display:flex;align-items:center;gap:var(--space-md);min-width:0;flex-wrap:wrap; }
    .last-updated { font-size:var(--text-sm);color:var(--muted); }

    .tabs { display:flex;gap:var(--space-xs);margin-bottom:var(--space-xl);border-bottom:1px solid var(--border);overflow-x:auto; }
    .tab { padding:var(--space-md) var(--space-xl);font-size:var(--text-md);font-weight:500;color:var(--muted);background:transparent;border:none;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap; }
    .tab:hover { color:var(--text); }
    .tab.active { color:var(--accent-text);border-bottom-color:var(--accent); }
    .tab-badge { position:absolute;top:8px;right:4px;min-width:16px;height:16px;padding:0 4px;background:var(--accent-solid);color:var(--accent-solid-foreground);border-radius:var(--radius-full);font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center; }
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
    .capacity-icon { width:40px;height:40px;border-radius:var(--radius-md);background:var(--accent-subtle);display:flex;align-items:center;justify-content:center;color:var(--accent-text); }
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
    .progress-fill.danger { background:linear-gradient(90deg,var(--danger),#ef4444); }
    @media (max-width: 600px) {
      :host { max-width:100%;overflow-x:hidden; }
      .header { align-items:flex-start; }
      .header-left { width:100%;min-width:0;display:grid;grid-template-columns:minmax(0, 1fr) auto;align-items:start; }
      .header-left > .btn { grid-column:1 / -1;justify-self:start; }
      .header-left .instance-title { grid-column:1; }
      .header-left app-badge { grid-column:2;align-self:start; }
      .header-right { width:100%;min-width:0; }
      .header-right { align-items:flex-start; }
      .last-updated { width:100%; }
      .tabs { max-width:100%; }
    }
    .header { margin-bottom:var(--space-md); padding-bottom:var(--space-md); }
    .header-left { gap:var(--space-md); }
    .instance-title { font-size:24px; }
    .resource-meta { color:var(--muted); font-size:12px; margin-top:var(--space-xs); overflow-wrap:anywhere; }
    .title-copy { flex:1; min-width:0; }
    .tabs { margin-bottom:var(--space-lg); }
    .tab { padding:var(--space-sm) var(--space-md); font-size:14px; }
    .overview-grid { display:grid; grid-template-columns:minmax(0, 2fr) minmax(240px, 1fr); gap:var(--space-lg); }
    .overview-grid > * { min-width:0; }
    h2 { font-size:16px; margin:0; } h3 { font-size:14px; margin:0 0 var(--space-xs); }
    .attention { padding-block:var(--space-md); border-bottom:1px solid var(--border); }
    .attention:first-child { padding-top:0; } .attention:last-child { border-bottom:0; padding-bottom:0; }
    .attention p { margin:var(--space-xs) 0 var(--space-sm); color:var(--muted); font-size:14px; line-height:1.6; }
    .attention .btn { margin-right:var(--space-sm); }
    dl { display:grid; grid-template-columns:auto minmax(0, 1fr); gap:var(--space-sm) var(--space-md); margin:0; font-size:14px; }
    dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
    .overview-note { color:var(--muted); font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
    @media (max-width:768px) { .overview-grid { grid-template-columns:minmax(0, 1fr); } }
    @media (max-width:600px) { .instance-title { font-size:22px; } .header-left .title-copy { grid-column:1; } }
  `];

  @state() private instanceId: number | null = null;
  @state() private instance: InstanceDetail | null = null;
  @state() private activeTab: string = new URL(location.href).searchParams.get('metricResource')?.startsWith('instance:') ? 'metrics' : 'overview' ;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private slowQueries: SlowQuery[] = [];
  @state() private sessions: Session[] = [];
  @state() private capacity: CapacityInfo | null = null;
  @state() private capHistory: { time: string[]; size: number[] } = { time: [], size: [] };
  @state() private lastUpdated: Date | null = null;
  @state() private detailReadError = '';
  @state() private overview: OverviewItem | null = null;
  @state() private overviewError = '';
  @state() private overviewLoading = false;
  private overviewRequest = 0;
  private contextVersion = 0;
  private onNavigate = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail?.tab === 'instance-detail' && Number.isSafeInteger(Number(detail.id)) && Number(detail.id) > 0) {
      this.instanceId = Number(detail.id); this.activeTab = 'overview'; void this.loadData();
    }
  };
  private onPopState = () => this.loadFromUrl();
  private onPermissionsChanged = () => {
    ++this.contextVersion; ++this.overviewRequest;
    this.instance = null; this.overview = null; this.overviewLoading = false;
    this._resetQueryReads(); this._resetEvidence(); this.loading = false;
    this.error = '权限或登录状态已变更，请重新打开资源。'; this.stopAutoRefresh();
  };
  private _resetEvidence() {
    this.capacity = null; this.capHistory = { time: [], size: [] };
    this._stopDiagnosisPolling(); this.diagnosisHistory = []; this.diagnosisResult = null;
    this.diagnosisStatus = 'idle'; this.diagnosisError = null;
    this.activeDiagnosisRecord = null; this.diagnosisExecutionTrace = null; this.showDiagnosisModal = false;
  }
  private async loadOverview() {
    const request = ++this.overviewRequest, id = this.instanceId;
    this.overview = null; this.overviewError = ''; this.overviewLoading = true;
    try {
      const response = await authFetch('/api/resources/overview');
      if (request !== this.overviewRequest || id !== this.instanceId) return;
      if (!response.ok) throw new Error([401, 403].includes(response.status) ? '无权读取资源概览' : '资源概览读取失败');
      const body: Overview = await response.json();
      if (!Array.isArray(body.items)) throw new Error('资源概览返回格式异常');
      if (request !== this.overviewRequest || id !== this.instanceId) return;
      const item = body.items.find(row => row?.resource?.type === 'instance' && row.resource.id === id);
      if (item && (!Array.isArray(item.gaps) || !item.gaps.every(gap => typeof gap === 'string')
        || typeof item.status !== 'string' || typeof item.quality !== 'string'
        || !['fresh', 'stale', 'missing'].includes(item.freshness)
        || !Number.isFinite(item.unresolvedAlerts) || item.unresolvedAlerts < 0
        || (item.observedAt !== null && !Number.isFinite(Date.parse(item.observedAt))))) throw new Error('资源概览返回格式异常');
      this.overview = item ?? null;
      if (!this.overview) this.overviewError = '当前快照未包含此资源，状态无法确认。';
    } catch (error) {
      if (request === this.overviewRequest) this.overviewError = error instanceof Error ? error.message : '资源概览读取失败';
    } finally { if (request === this.overviewRequest) this.overviewLoading = false; }
  }
  @state() private autoRefresh = true;
  @state() private isRefreshing = false;
  @state() private queryReads: Record<'topsql' | 'sessions', QueryRead> = {
    topsql: { status: 'idle', instanceId: null }, sessions: { status: 'idle', instanceId: null },
  };
  private queryRequests = { topsql: 0, sessions: 0 };
  private queryExpiryTimers: Partial<Record<'topsql' | 'sessions', ReturnType<typeof setTimeout>>> = {};
  private readonly QUERY_MAX_AGE = 60_000;
  @state() private diagnosisStatus: "idle"|"running"|"completed"|"failed"|"unknown" = "idle";
  @state() private diagnosisResult: any = null;
  @state() private diagnosisError: string | null = null;
  @state() private showDiagnosisResult = false;
  @state() private diagnosisHistory: any[] = [];
  @state() private diagnosisHistoryLoading = false;
  @state() private activeDiagnosisRecord: any = null;
  @state() private showDiagnosisModal = false;
  @state() private diagnosisExecutionTrace: any = null;
  private diagnosisPollTimer: ReturnType<typeof setInterval> | null = null;
  private diagnosisPollingStart = 0;
  private refreshTimer: number | null = null;
  private ageTimer?: ReturnType<typeof setInterval>;
  private readonly REFRESH_INTERVAL = 30000;

  override connectedCallback() {
    super.connectedCallback();
    // Evidence still ages when network auto-refresh is disabled.
    this.ageTimer = setInterval(() => this.requestUpdate(), 30_000);
  }

  override firstUpdated() {
    this.loadFromUrl();
    window.addEventListener('slide-navigate', this.onNavigate);
    window.addEventListener('popstate', this.onPopState);
    window.addEventListener('slide-permissions-loaded', this.onPermissionsChanged);
    window.addEventListener('slide-session-expired', this.onPermissionsChanged);
    this.startAutoRefresh();
  }
  override disconnectedCallback() {
    clearInterval(this.ageTimer);
    ++this.contextVersion; ++this.overviewRequest;
    window.removeEventListener('slide-navigate', this.onNavigate);
    window.removeEventListener('popstate', this.onPopState);
    window.removeEventListener('slide-permissions-loaded', this.onPermissionsChanged);
    window.removeEventListener('slide-session-expired', this.onPermissionsChanged);
    super.disconnectedCallback(); this.stopAutoRefresh(); this._stopDiagnosisPolling(); this._resetQueryReads();
  }

  private loadFromUrl() {
    const raw = new URLSearchParams(window.location.search).get('id');
    if (raw && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw))) {
      this.instanceId = Number(raw); void this.loadData();
    }
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
    const version = ++this.contextVersion;
    this.instance = null; this._resetEvidence(); this.isRefreshing = false;
    this.loading = true; this.error = null;
    this.lastUpdated = null; this.detailReadError = '';
    this._resetQueryReads();
    const instanceId = this.instanceId;
    void this.loadOverview();
    try {
      const res = await authFetch(`/api/database/instances/${this.instanceId}`);
      if (instanceId !== this.instanceId || version !== this.contextVersion) return;
      if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? '无权读取实例详情' : '获取实例详情失败');
      const instance = await res.json();
      if (instanceId !== this.instanceId || version !== this.contextVersion) return;
      this.instance = instance;
      this.lastUpdated = new Date();
      this.loadDiagnosisHistory();
      await this.loadTabData();
    } catch (err: any) { if (instanceId === this.instanceId && version === this.contextVersion) this.error = err.message; }
    finally { if (instanceId === this.instanceId && version === this.contextVersion) this.loading = false; }
  }

  private async refreshCurrentTab() {
    if (!this.instanceId || this.isRefreshing) return;
    this.isRefreshing = true;
    this.detailReadError = '';
    const instanceId = this.instanceId, version = this.contextVersion;
    try {
      const res = await authFetch(`/api/database/instances/${this.instanceId}`);
      if (instanceId !== this.instanceId || version !== this.contextVersion) return;
      if (!res.ok) {
        this._invalidateQueryReads(res.status === 401 || res.status === 403 ? 'forbidden' : 'unavailable');
        this.detailReadError = res.status === 401 || res.status === 403 ? '无权读取实例详情' : '实例详情读取失败';
        if (res.status === 401 || res.status === 403) this.error = this.detailReadError;
        return;
      }
      const instance = await res.json();
      if (instanceId !== this.instanceId || version !== this.contextVersion) return;
      this.instance = instance;
      this.lastUpdated = new Date();
      await Promise.all([this.loadTabData(), this.loadOverview()]);
      if (instanceId === this.instanceId && version === this.contextVersion) await this.renderRoot.querySelector<import('../components/semantic-metrics.js').SemanticMetrics>('semantic-metrics')?.load();
    } catch { if (instanceId === this.instanceId && version === this.contextVersion) { this._invalidateQueryReads('error'); this.detailReadError = '实例详情读取失败'; } }
    finally { if (version === this.contextVersion) this.isRefreshing = false; }
  }

  private async loadTabData() {
    if (!this.instanceId) return;
    try {

      switch (this.activeTab) {
        case "overview":
        case "metrics": {
          break;
        }
        case "topsql":
        case "sessions": {
          await this._loadQueryData(this.activeTab);
          break;
        }
        case "capacity": {
          this.capacity = null; this.capHistory = { time: [], size: [] };
          const version = this.contextVersion, instanceId = this.instanceId;
          const current = () => version === this.contextVersion && instanceId === this.instanceId;
          const [cr, chr] = await Promise.all([
            authFetch(`/api/database/instances/${instanceId}/capacity`),
            authFetch(`/api/database/instances/${instanceId}/capacity/history?hours=168`),
          ]);
          if (!current()) return;
          const capacity = cr.ok ? await cr.json() : null;
          if (!current()) return;
          const history = chr.ok ? await chr.json() : null;
          if (!current()) return;
          if (cr.ok) this.capacity = capacity;
          if (history?.history) this.capHistory = {
            time: history.history.map((x: any) => x.recorded_at?.substring(0, 16) || ""),
            size: history.history.map((x: any) => x.total_size_gb || 0),
          };
          break;
        }
        case "diagnosis":
          this.loadDiagnosisHistory();
          break;
      }
    } catch {/* ignore tab data errors */}
  }

  private _goBack() { if (returnToDashboard()) return; const u = new URL(window.location.href); u.searchParams.set("tab", "instances-db"); u.searchParams.delete("id"); window.history.pushState({}, "", u); window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab: "instances-db" } })); }
  private _setTab(tab: string) {
    const configuration = this.renderRoot.querySelector('resource-collection-section') as import('../components/resource-collection-section.js').ResourceCollectionSection | null;
    if (configuration) { configuration.confirmDiscard(() => this._applyTab(tab)); return; }
    this._applyTab(tab);
  }
  private _applyTab(tab: string) { this.activeTab = tab; this.loadTabData(); }
  private _toggleAutoRefresh() { this.autoRefresh = !this.autoRefresh; this.startAutoRefresh(); }
  private async _manualRefresh() { await this.refreshCurrentTab(); }
  private _resetQueryReads() {
    for (const kind of ['topsql', 'sessions'] as const) {
      this.queryRequests[kind]++;
      clearTimeout(this.queryExpiryTimers[kind]);
    }
    this.slowQueries = []; this.sessions = [];
    this.queryReads = { topsql: { status: 'idle', instanceId: null }, sessions: { status: 'idle', instanceId: null } };
  }
  private _invalidateQueryReads(status: ReadStatus) {
    this._resetQueryReads();
    this.queryReads = { topsql: { status, instanceId: this.instanceId }, sessions: { status, instanceId: this.instanceId } };
  }
  private async _loadQueryData(kind: 'topsql' | 'sessions') {
    const instanceId = this.instanceId;
    if (!instanceId) return;
    const request = ++this.queryRequests[kind];
    clearTimeout(this.queryExpiryTimers[kind]);
    this.queryReads = { ...this.queryReads, [kind]: { status: 'loading', instanceId } };
    if (kind === 'topsql') this.slowQueries = []; else this.sessions = [];
    const current = () => this.instanceId === instanceId && this.queryRequests[kind] === request;
    try {
      const res = await authFetch(`/api/database/instances/${instanceId}/${kind}`);
      if (!current()) return;
      if (!res.ok) {
        const status = res.status === 401 || res.status === 403 ? 'forbidden' : res.status === 404 ? 'unavailable' : 'error';
        this.queryReads = { ...this.queryReads, [kind]: { status, instanceId } };
        return;
      }
      const rows: unknown = await res.json();
      if (!current()) return;
      // Keep the existing array contract; null/error envelopes and malformed rows are not empty success.
      if (!Array.isArray(rows) || !rows.every(row => row && typeof row === 'object' &&
        (kind === 'topsql' ? typeof row.sql_text === 'string' : row.id != null && (row.query == null || typeof row.query === 'string')))) throw new Error('INVALID_QUERY_RESPONSE');
      if (kind === 'topsql') this.slowQueries = rows; else this.sessions = rows;
      this.queryReads = { ...this.queryReads, [kind]: { status: 'success', instanceId, readAt: Date.now(), source: res.headers.get('x-slide-query-source') ?? 'unknown' } };
      this.queryExpiryTimers[kind] = setTimeout(() => this.requestUpdate(), this.QUERY_MAX_AGE);
    } catch {
      if (current()) this.queryReads = { ...this.queryReads, [kind]: { status: 'error', instanceId } };
    }
  }
  private _queryState(kind: 'topsql' | 'sessions') {
    const read = this.queryReads[kind];
    if (read.instanceId !== this.instanceId) return 'idle';
    if (read.status === 'success' && Date.now() - read.readAt! >= this.QUERY_MAX_AGE) return 'expired';
    return read.status;
  }
  private _renderQueryState(kind: 'topsql' | 'sessions') {
    const state = this._queryState(kind);
    if (state === 'success') return nothing;
    const label = kind === 'topsql' ? '慢查询' : '会话';
    const titles = { idle: `尚未读取${label}`, loading: `加载${label}数据…`, error: `${label}读取失败`, forbidden: `无权读取${label}`, unavailable: `${label}数据不可用`, expired: `${label}数据已过期` };
    const descriptions = {
      idle: '尚无读取结果，无法判断是否存在记录。', loading: '正在读取，请稍候。',
      error: '请求失败或返回格式异常，请刷新重试。', forbidden: '请确认当前账号的实例访问权限。',
      unavailable: '实例未连接、采集来源未就绪或数据库不支持此查询，请检查连接和采集配置。',
      expired: '距上次成功读取已超过 1 分钟，请刷新后查看。',
    };
    return html`<app-card><div role=${state === 'error' || state === 'forbidden' ? 'alert' : 'status'}>
      <app-empty-state .title=${titles[state]} .description=${descriptions[state]}></app-empty-state>
    </div></app-card>`;
  }
  private _renderQueryProvenance(kind: 'topsql' | 'sessions') {
    const read = this.queryReads[kind];
    const sources: Record<string, string> = { 'mysql-performance-schema': 'MySQL performance_schema', 'mysql-slow-log': 'MySQL mysql.slow_log', 'pg-stat-statements': 'PostgreSQL pg_stat_statements', 'oracle-sqlarea': 'Oracle V$SQLAREA', 'dameng-sql-history': '达梦 V$SQL_HISTORY' };
    const sessionSources: Record<string, string> = { mysql: 'MySQL PROCESSLIST', postgresql: 'PostgreSQL pg_stat_activity', oracle: 'Oracle V$SESSION', dameng: '达梦 V$SESSIONS' };
    const source = kind === 'topsql' ? sources[read.source!] : sessionSources[this.instance?.db_type ?? ''];
    return html`<p class="empty-desc">来源：${source ?? '实例查询接口（未提供具体采集来源）'} ·
      时间范围：${kind === 'sessions' ? '本次读取时的活跃会话快照（最多 50 条）' : '数据库当前保留的记录（统计起止时间未知，Top 10）'} ·
      读取时间：${new Date(read.readAt!).toLocaleString('zh-CN')}（非最近采集时间）</p>`;
  }

  // ---- Diagnosis ----
  private async _startDiagnosis() {
    if (!this.instanceId || this.diagnosisStatus === "running") return;
    const version = this.contextVersion;
    try {
      const res = await authFetch("/api/ai/analysis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis_type: "fault_diagnosis", instance_id: this.instanceId, trigger_type: "manual" }) });
      const data = await res.json();
      if (version !== this.contextVersion) return;
      if (!res.ok && data.status === 'unknown') {
        this.diagnosisStatus = 'unknown'; this.diagnosisResult = { id: data.analysisId, status: 'unknown' };
        this.diagnosisError = null; this.showDiagnosisModal = true; return;
      }
      if (!res.ok) throw new Error("提交诊断失败");
      this.diagnosisStatus = "running"; this.diagnosisError = null; this.showDiagnosisResult = true; this.showDiagnosisModal = true;
      this._startDiagnosisPolling(data.id);
    } catch (err: any) { if (version !== this.contextVersion) return; this.diagnosisStatus = "failed"; this.diagnosisError = err.message || "提交诊断失败"; this.showDiagnosisResult = true; this.showDiagnosisModal = true; }
  }
  private _startDiagnosisPolling(analysisId: number) {
    const version = this.contextVersion;
    this._stopDiagnosisPolling(); this.diagnosisPollingStart = Date.now();
    this.diagnosisPollTimer = setInterval(async () => {
      try {
        if (Date.now() - this.diagnosisPollingStart > 3 * 60 * 1000) { this._stopDiagnosisPolling(); this.diagnosisStatus = "failed"; this.diagnosisError = "诊断超时"; this.requestUpdate(); return; }
        const res = await authFetch(`/api/ai/analysis/status/${analysisId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (version !== this.contextVersion || !data.ok || !data.record) return;
        const record = data.record;
        if (record.status === "completed") {
          this.diagnosisStatus = "completed";
          this.diagnosisResult = record;
          this.diagnosisExecutionTrace = record.execution_trace || null;
          this._stopDiagnosisPolling(); this.loadDiagnosisHistory();
        } else if (record.status === "running") {
          // Update execution trace during running for live progress display
          this.diagnosisExecutionTrace = record.execution_trace || null;
          this.requestUpdate();
        } else if (record.status === "unknown") {
          this.diagnosisStatus = 'unknown'; this.diagnosisResult = record; this.diagnosisError = null;
          this._stopDiagnosisPolling(); this.loadDiagnosisHistory();
        } else if (record.status === "failed") { this.diagnosisStatus = "failed"; this.diagnosisError = record.error_message || "诊断失败"; this._stopDiagnosisPolling(); }
        this.requestUpdate();
      } catch { /* ignore */ }
    }, 2000);
  }
  private _stopDiagnosisPolling() { if (this.diagnosisPollTimer) { clearInterval(this.diagnosisPollTimer); this.diagnosisPollTimer = null; } }
  private async loadDiagnosisHistory() {
    if (!this.instanceId) return;
    const version = this.contextVersion;
    this.diagnosisHistoryLoading = true;
    try { const r = await authFetch(`/api/ai/analysis/history?instance_id=${this.instanceId}&analysis_type=fault_diagnosis&limit=10`); if (r.ok) { const data = await r.json(); if (version === this.contextVersion) this.diagnosisHistory = data.records || []; } }
    catch { /* ignore */ }
    finally { if (version === this.contextVersion) this.diagnosisHistoryLoading = false; }
  }
  private _formatDiagnosisTime(dateStr: string): string {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const s = Math.floor(diffMs / 1000); if (s < 60) return "刚刚";
    const m = Math.floor(s / 60); if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60); if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24); return d < 7 ? `${d} 天前` : new Date(dateStr).toLocaleDateString("zh-CN");
  }
  private _closeDiagnosisModal() { this.showDiagnosisModal = false; this.activeDiagnosisRecord = null; }
  private _continueInChat(e: CustomEvent) {
    const { analysisId, diagnosisSummary } = e.detail || {};
    const diagnosisText = typeof diagnosisSummary === 'string' ? diagnosisSummary : '';
    if (analysisId && diagnosisText) {
      // Store pending message for chat page to pick up
      (window as any).__pendingChatMessage = {
        text: `我有关于实例 ${this.instance?.name || `#${this.instanceId}`} 的 AI 诊断结果，想深入分析。\n\n诊断详情：\n${diagnosisText}`,
      };
    }
    window.dispatchEvent(new CustomEvent('slide-navigate', {
      detail: { tab: 'chat' },
    }));
  }
  private _formatTimeAgo(date: Date | null): string {
    return date ? date.toLocaleString('zh-CN') : '尚未成功读取';
  }

  private _healthBadge() {
    const status = currentHealthStatus(this.instance, this.overview);
    const labels: Record<string, string> = { healthy:'当前观测健康', warning:'当前观测异常', critical:'当前不可用', error:'连接错误', unknown:'当前健康待确认' };
    return html`<app-badge variant=${status === 'healthy' ? 'ok' : status === 'unknown' ? 'muted' : 'warn'}>${labels[status]}</app-badge>`;
  }
  private _renderOverview() {
    const item = this.overview;
    const status = currentHealthStatus(this.instance, item);
    const state = ({ healthy: 'normal', warning: 'abnormal', critical: 'abnormal', error: 'unavailable', unknown: 'unknown' } as const)[status];
    const fresh = item ? freshness(item) : 'missing';
    const gaps: Record<string, string> = {
      OBSERVATIONS_UNAVAILABLE:'观测读取失败', ALERTS_UNAVAILABLE:'告警读取失败', RELATIONS_UNAVAILABLE:'关系读取失败',
      OBSERVATIONS_EMPTY:'尚未取得观测', OBSERVATIONS_EXPIRED:'观测已失效', OBSERVATIONS_STALE:'观测已过期',
      OBSERVATIONS_FUTURE:'观测时间异常', ALERTS_TRUNCATED:'告警记录不完整', OBSERVATIONS_TRUNCATED:'观测记录不完整',
    };
    return html`<operations-resource-relations resourceType="instance" .resourceId=${this.instanceId}></operations-resource-relations><div class="overview-grid">
      <app-card><h2 slot="header">当前需要关注</h2>
        ${this.overviewLoading ? html`<p role="status">正在读取资源状态与证据…</p>` : nothing}
        ${this.overviewError ? html`<p role="alert">${this.overviewError}</p><button class="btn" @click=${this.loadOverview}>重新读取概览</button>` : nothing}
        <section class="attention"><h3>${({ normal:'当前观测未提示运行异常', abnormal:'存在需要核对的异常', unavailable:'资源当前不可用', unknown:'当前证据不足以判断运行状态' })[state]}</h3>
          <p>${item && !item.gaps.includes('ALERTS_UNAVAILABLE') ? `未解决告警 ${item.alertsTruncated ? '至少 ' : ''}${item.unresolvedAlerts} 项。` : '尚未取得可用的告警结果。'} 状态只反映已有观测，不能代替完整健康判断。</p>
          <button class="btn" @click=${() => this._setTab('metrics')}>核对指标与时间范围</button>
          <button class="btn" @click=${() => this._setTab('logs')}>查看日志与完整事件</button>
        </section>
        <section class="attention"><h3>证据缺口</h3>
          <p>${item ? (item.gaps.length ? item.gaps.map(gap => gaps[gap] ?? '部分证据缺失').join('；') : item.quality !== 'good' ? '当前仅有部分或质量不足的观测，不能推断所有信号完整。' : '当前快照未报告缺口；不代表已覆盖全部信号。') : '尚未取得此资源的证据快照。'}${fresh === 'stale' ? ' 请先核对采集状态和观测时间。' : ''}</p>
          <button class="btn" @click=${() => this._setTab('collection')}>查看采集配置</button>
          ${item?.gaps.length ? html`<details class="overview-note"><summary>查看缺口原始标识</summary>${item.gaps.join(' · ')}</details>` : nothing}
        </section>
      </app-card>
      <app-card><h2 slot="header">资源与能力</h2><dl>
        <dt>类型</dt><dd>${this.instance!.db_type}</dd><dt>环境</dt><dd>${this.instance!.environment || '未设置'}</dd>
        <dt>连接配置</dt><dd>${this.instance!.status === 'active' ? '已启用（可用性需连接测试）' : this.instance!.status || '未知'}</dd><dt>连接地址</dt><dd>${this.instance!.host}:${this.instance!.port}</dd>
        <dt>数据库</dt><dd>${this.instance!.database_name || '未指定'}</dd>
        <dt>观测时间</dt><dd>${item?.observedAt ? new Date(item.observedAt).toLocaleString('zh-CN') : '未知'}</dd>
        <dt>观测时效</dt><dd>${({ fresh:'新鲜', stale:'过期', missing:'未取得', failed:'读取失败' })[fresh]}</dd>
      </dl><p class="overview-note">可用观测以指标页的能力与查询结果为准。概览提供方向，完整指标、定义和日志保留在专属页签。</p></app-card>
    </div>`;
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
            <button class="btn" @click=${this._goBack}>${icons['chevron-left']} 返回列表</button>
            <div class="title-copy"><span class="instance-title">${this.instance.name}</span><div class="resource-meta">${this.instance.db_type} · ${this.instance.host}:${this.instance.port} · 观测于 ${this.overview?.observedAt ? new Date(this.overview.observedAt).toLocaleString('zh-CN') : '未知'}</div></div>
            ${this._healthBadge()}
          </div>
          <div class="header-right">
            <span class="last-updated">详情成功读取：${this._formatTimeAgo(this.lastUpdated)}（非资源观测）</span>
            ${this.detailReadError ? html`<span role="alert">${this.detailReadError}，成功读取时间未更新</span>` : nothing}
            <button class="btn" @click=${() => { this.showDiagnosisModal = true; if (this.diagnosisStatus === "idle") this._startDiagnosis(); }}
              style="${this.diagnosisStatus === "running" ? "border-color:var(--warn);color:var(--warn);" : ""}">
              ${this.diagnosisStatus === "running" ? html`${icons['loader']} 诊断中...` : html`${icons['activity']} 一键诊断`}
            </button>
            <button aria-busy=${String(this.isRefreshing)} class="btn btn-refresh" @click=${this._manualRefresh} ?disabled=${this.isRefreshing}>
               刷新
            </button>
          </div>
        </div>

        <resource-investigation-links resourceType="instance" .resourceId=${this.instanceId}></resource-investigation-links>
      <div class="tabs" role="tablist" aria-label="资源详情页签">
          ${["overview","collection","metrics","topsql","health","sessions","capacity","schema","indexes","sqlaudit","logs","qan","diagnosis"].map(t => html`
            <button role="tab" aria-selected=${String(this.activeTab === t || t === "metrics" && this.activeTab === "trend")} class="tab ${(this.activeTab === t || t === "metrics" && this.activeTab === "trend") ? "active" : ""}" @click=${() => this._setTab(t)}>
              ${({ overview:"概览", collection:"采集配置", metrics:"指标与趋势", topsql:"慢查询", trend:"趋势", health:"健康评分", sessions:"会话", capacity:"容量", schema:"表结构", indexes:"索引", sqlaudit:"SQL 审核", logs:"日志", qan:"查询分析", diagnosis:"AI 诊断" } as Record<string,string>)[t]}
              ${t === "topsql" && this._queryState('topsql') === 'success' && this.slowQueries.length > 0 ? html`<span class="tab-badge">${this.slowQueries.length}</span>` : ""}
              ${t === "sessions" && this._queryState('sessions') === 'success' && this.sessions.length > 0 ? html`<span class="tab-badge">${this.sessions.length}</span>` : ""}
            </button>
          `)}
        </div>

        ${this._renderTabContent()}

        <instance-diagnosis-modal
          .instanceId=${this.instanceId}
          .instanceName=${this.instance?.name || null}
          .open=${this.showDiagnosisModal}
          .diagnosis=${this.diagnosisResult}
          .diagnosisRecord=${this.activeDiagnosisRecord}
          .executionTrace=${this.diagnosisExecutionTrace}
          .loading=${this.diagnosisStatus === "running"}
          .error=${this.diagnosisError}
          @close=${this._closeDiagnosisModal}
          @request-diagnosis=${this._startDiagnosis}
          @continue-in-chat=${this._continueInChat}
        ></instance-diagnosis-modal>
      </div>`;
  }

  private _renderDiagnosisHistory() {
    // Only show when there's history or an active diagnosis
    if (this.diagnosisHistory.length === 0 && this.diagnosisStatus !== "running") return nothing;

    if (this.diagnosisHistoryLoading) return html`<app-card style="margin-bottom:var(--space-lg);"><span slot="header">AI 诊断历史</span><div style="display:flex;align-items:center;justify-content:center;gap:10px;padding:24px;color:var(--muted);"><div class="spinner"></div><span>加载中...</span></div></app-card>`;

    return html`
      <app-card style="margin-bottom:var(--space-lg);">
        <span slot="header">AI 诊断历史 <span style="font-size:var(--text-xs);color:var(--muted);">最近 ${this.diagnosisHistory.length} 条</span></span>
        <div class="diagnosis-history-list">
          ${this.diagnosisHistory.map((r: any) => {
            const statusStyle = r.status === "completed" ? { cls: "ok", label: "已完成" } : r.status === "failed" ? { cls: "danger", label: "分析失败" } : r.status === "unknown" ? { cls: "danger", label: "结果未知" } : { cls: "info", label: "进行中" };
            const raw = typeof r.result === 'string' ? r.result : "";
            const summary = raw.replace(/^#+\s*/gm, "").trim().substring(0, 80);
            return html`<div class="diagnosis-history-item" @click=${() => { this.activeDiagnosisRecord = r; this.diagnosisResult = r; this.diagnosisStatus = r.status; this.diagnosisError = r.status === "unknown" ? null : r.error_message || null; this.diagnosisExecutionTrace = r.execution_trace || null; this.showDiagnosisModal = true; }}>
              <app-badge variant=${statusStyle.cls} style="font-size:var(--text-xs);padding:2px 8px;flex-shrink:0;">${statusStyle.label}</app-badge>
              <span class="diagnosis-time">${this._formatDiagnosisTime(r.updated_at || r.created_at)}</span>
              <span class="diagnosis-summary-text" title="${summary}">${summary}${raw.length > 80 ? "..." : ""}</span>
              ${icons['chevron-right']}
            </div>`;
          })}
        </div>
      </app-card>`;
  }

  private _renderTabContent() {
    if (this.activeTab === "collection") return html`<resource-collection-section resourceType="instance" .resourceId=${this.instanceId}></resource-collection-section>`;
    switch (this.activeTab) {
      case "overview": return this._renderOverview();
      case "metrics":
      case "trend": return html`<semantic-metrics resourceType="instance" .resourceId=${this.instanceId}></semantic-metrics>`;
      case "health": return html`<health-score-tab .instanceId=${this.instanceId}></health-score-tab>`;
      case "topsql": return this._renderTopSQL();
      case "sessions": return this._renderSessions();
      case "capacity": return this._renderCapacity();
      case "schema": return html`<schema-management-page .instanceId=${this.instanceId}></schema-management-page>`;
      case "indexes": return html`<index-management-page .instanceId=${this.instanceId}></index-management-page>`;
      case "sqlaudit": return html`<sql-audit-tab .instanceId=${this.instanceId}></sql-audit-tab>`;
      case "logs": return html`<database-log-tab .instanceId=${this.instanceId}></database-log-tab>`;
      case "qan": return html`<query-analysis-tab .instanceId=${this.instanceId}></query-analysis-tab>`;
      case "diagnosis": return this._renderDiagnosisHistory();
      default: return html`<semantic-metrics resourceType="instance" .resourceId=${this.instanceId}></semantic-metrics>`;
    }
  }
  private _renderTopSQL() {
    if (this._queryState('topsql') !== 'success') return this._renderQueryState('topsql');
    if (this.slowQueries.length === 0) return html`<app-card><app-empty-state title="本次查询未返回慢查询记录" description="空结果不能确认采集是否完整，也不能据此判断数据库健康。"></app-empty-state>${this._renderQueryProvenance('topsql')}</app-card>`;
    return html`
      <app-card>
        <span slot="header">慢查询列表（Top ${this.slowQueries.length}）</span>
        ${this._renderQueryProvenance('topsql')}
        <div class="table-container">
          <table class="table">
            <thead><tr><th>SQL 语句</th><th style="width:100px;text-align:center;">平均耗时</th><th style="width:100px;text-align:center;">最大耗时</th><th style="width:90px;text-align:center;">执行次数</th><th style="width:140px;text-align:center;">最后出现</th></tr></thead>
            <tbody>${this.slowQueries.map(q => html`<tr>
              <td><div class="sql-code" title="${q.sql_text}">${q.sql_text.substring(0, 80)}${q.sql_text.length > 80 ? "..." : ""}</div></td>
              <td style="text-align:center;"><span style="color:${Number(q.avg_time_ms) > 1000 ? 'var(--danger)' : Number(q.avg_time_ms) > 100 ? 'var(--warn)' : 'var(--ok)'};font-weight:600;">${Number(q.avg_time_ms).toFixed(2)} ms</span></td>
              <td style="text-align:center;">${Number(q.max_time_ms).toFixed(2)} ms</td>
              <td style="text-align:center;">${Number(q.execution_count).toLocaleString()}</td>
              <td style="text-align:center;">${new Date(q.last_seen).toLocaleString("zh-CN")}</td>
            </tr>`)}</tbody>
          </table>
        </div>
      </app-card>`;
  }

  private _renderSessions() {
    if (this._queryState('sessions') !== 'success') return this._renderQueryState('sessions');
    if (this.sessions.length === 0) return html`<app-card><app-empty-state title="本次查询未返回活跃会话" description="仅表示本次快照未返回会话，不代表数据库健康。"></app-empty-state>${this._renderQueryProvenance('sessions')}</app-card>`;
    return html`
      <app-card>
        <span slot="header">活跃会话 (${this.sessions.length})</span>
        ${this._renderQueryProvenance('sessions')}
        <div class="table-container">
          <table class="table">
            <thead><tr><th style="width:70px;text-align:center;">ID</th><th>用户</th><th>来源</th><th>数据库</th><th style="width:90px;text-align:center;">命令</th><th style="width:80px;text-align:center;">时间</th><th>当前查询</th></tr></thead>
            <tbody>${this.sessions.map(s => html`<tr>
              <td style="text-align:center;">${s.id}</td><td>${s.user}</td><td>${s.host}</td><td style="text-align:center;">${s.database || "—"}</td>
              <td style="text-align:center;"><span style="padding:2px 8px;background:var(--bg-muted);border-radius:var(--radius-sm);font-size:var(--text-xs);">${s.command}</span></td>
              <td style="text-align:center;"><span style="color:${s.time_seconds > 60 ? 'var(--danger)' : s.time_seconds > 10 ? 'var(--warn)' : 'var(--ok)'};font-weight:600;">${s.time_seconds}s</span></td>
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
      ${this.capHistory.time.length > 0 ? html`<metric-chart title="历史容量采样（过去7天，非当前读取）" height="220px" yAxisLabel="GB" .timeData=${this.capHistory.time} .series=${[{ name: "容量", data: this.capHistory.size, color: "var(--accent)" }]}></metric-chart><div style="height:16px"></div>` : nothing}
      <app-card>
        <span slot="header">容量读取结果：${cap.total_size_gb.toFixed(2)} GB</span>
        <p class="overview-note">来源：${cap.source || '数据库容量接口（来源未提供）'} · 观测：${evidenceTime(cap.observed_at)} · ${evidenceTimeState(cap.observed_at)}<br>范围：${cap.scope || '接口未提供范围，不与结构/索引数量直接比较'}。历史趋势为独立采样；结构/索引为独立快照，时间与范围可能不同。</p>
        ${cap.databases && cap.databases.length > 0 ? html`<h4 style="font-size:var(--text-md);color:var(--text-strong);margin:0 0 16px 0;">数据库</h4><div class="capacity-list">${cap.databases.map(db => html`<div class="capacity-item"><div class="capacity-icon">${icons['database']}</div><div class="capacity-info"><div class="capacity-name">${db.name}</div><div class="capacity-meta">${db.size_gb.toFixed(2)} GB${db.table_count !== undefined ? ` · ${db.table_count} 张表` : ""}</div></div></div>`)}</div>` : ""}
        ${cap.tablespaces && cap.tablespaces.length > 0 ? html`<h4 style="font-size:var(--text-md);color:var(--text-strong);margin:24px 0 16px 0;">表空间</h4><div class="capacity-list">${cap.tablespaces.map(ts => html`<div class="capacity-item"><div class="capacity-icon">${icons['package']}</div><div class="capacity-info"><div class="capacity-name">${ts.name}</div><div class="capacity-meta">${ts.size_gb.toFixed(2)} GB / ${ts.max_size_gb?.toFixed(2) || "∞"} GB</div></div>${ts.usage_percent !== undefined ? html`<div class="capacity-bar-wrap"><div class="capacity-percent" style="color:${ts.usage_percent > 90 ? 'var(--danger)' : ts.usage_percent > 70 ? 'var(--warn)' : 'var(--ok)'}">${ts.usage_percent.toFixed(1)}%</div><div class="progress-bar"><div class="progress-fill ${ts.usage_percent > 90 ? 'danger' : ts.usage_percent > 70 ? 'warn' : 'ok'}" style="width:${ts.usage_percent}%"></div></div></div>` : ""}</div>`)}</div>` : ""}
        <h4 style="font-size:var(--text-md);color:var(--text-strong);margin:24px 0 16px 0;">最大表（Top ${cap.top_tables.length}）</h4><div class="capacity-list">${cap.top_tables.map(t => html`<div class="capacity-item"><div class="capacity-icon">${icons['file-text']}</div><div class="capacity-info"><div class="capacity-name">${t.name}</div><div class="capacity-meta">${t.size_gb.toFixed(2)} GB${t.row_count ? ` · ${t.row_count.toLocaleString()} 行` : ""}</div></div></div>`)}</div>
      </app-card>`;
  }
}

if (!customElements.get("instance-detail-page")) {
  customElements.define("instance-detail-page", InstanceDetailPage);
}
