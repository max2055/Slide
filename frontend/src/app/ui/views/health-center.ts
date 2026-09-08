/**
 * Health Center Page — displays system consistency health checks
 * from GET /api/health/overview.
 *
 * Design principle: surface the ONE thing that needs attention.
 * Normal checks are secondary; anomalies get the spotlight.
 */
import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import { authFetch } from "../../../api/index.js";
import { icons } from "../../../icons.js";
import { inferBasePathFromPathname } from "../navigation.ts";
import "../components/app-card.js";
import "../components/app-badge.js";
import "../components/app-empty-state.js";
import "./platform-observations.js";

// ── Types ───────────────────────────────────────────────

interface ConsistencyCheck {
  id: string;
  label: string;
  category: string;
  status: 'pass' | 'warn' | 'fail' | 'deferred';
  severity: string;
  summary: string;
  details?: unknown;
  recommendation?: string;
}

interface ReadinessItem {
  key: string;
  label: string;
  status: boolean;
  severity: 'critical' | 'major' | 'minor';
  suggestion: string;
  actionLabel?: string;
  actionHref?: string;
}

interface HealthOverview {
  timestamp: string;
  summary: { pass: number; warn: number; fail: number; deferred: number; total: number; };
  checks: ConsistencyCheck[];
  readiness: {
    db_connected: boolean;
    db_reachable: boolean;
    llm_provider: boolean;
    cron_running: boolean;
    agent_engine: boolean;
  };
  truth: HealthTruth;
}

type HealthStatus = 'healthy' | 'degraded' | 'critical' | 'unknown';
interface HealthDimension { status: HealthStatus; numerator: number; denominator: number; failedRefs?: Array<{ type: string; id: number | string }>; observedAt?: string; reason?: string; }
interface HealthTruth { controlPlane: HealthDimension; managedAvailability: HealthDimension; dataFreshness: HealthDimension; workflow: HealthDimension; overall: HealthStatus; }

// ── Category labels ─────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  instance: '实例', capacity: '容量', metrics: '指标', alert: '告警',
  rbac: '权限', cron: '定时任务', chat: 'Chat', approval: '审批', notification: '通知',
};

// ── Component ────────────────────────────────────────────

@customElement("health-center-page")
export class HealthCenterPage extends LitElement {
  @state() private loading = true;
  @state() private refreshing = false;
  @state() private error: string | null = null;
  @state() private data: HealthOverview | null = null;
  @state() private truth: HealthTruth | null = null;
  @state() private expandedChecks = new Set<string>();
  @state() private showNormalChecks = false;

  static styles = [
    sharedBtnStyles,
    css`
      :host { display: block; max-width: 800px; min-width: 0; }

      /* ── Page header ─────────────────────────────── */
      .page-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; }
      .page-header h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: var(--text-strong); }
      .page-header p { font-size: 13px; color: var(--muted); margin: 0; }
      .refresh-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--card); color: var(--text); cursor: pointer; white-space: nowrap; flex-shrink: 0; }
      .refresh-btn:hover { background: var(--hover); }
      .refresh-btn:active { background: var(--active); }
      .refresh-btn .spinning { animation: spin 0.8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }

      /* ── Health score + stats (unified top bar) ──── */
      .health-bar { display: flex; align-items: center; gap: 20px; padding: 12px 16px; margin-bottom: 16px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); }
      .health-bar .hs-left { display: flex; align-items: baseline; gap: 8px; flex-shrink: 0; }
      .health-bar .hs-label { font-size: 13px; color: var(--muted); }
      .health-bar .hs-pct { font-weight: 700; font-size: 22px; }
      .health-bar .hs-pct.ok { color: var(--ok, #22c55e); }
      .health-bar .hs-pct.warn { color: var(--warn, #f59e0b); }
      .health-bar .hs-pct.danger { color: var(--danger, #ef4444); }
      .health-bar .hs-track { width: 120px; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; flex-shrink: 0; }
      .health-bar .hs-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }
      .health-bar .hs-stats { display: flex; gap: 16px; margin-left: auto; font-size: 13px; }
      .health-bar .hs-stat { display: flex; align-items: center; gap: 4px; color: var(--text); }
      .health-bar .hs-stat .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .health-bar .hs-stat .dot.ok { background: var(--ok, #22c55e); }
      .health-bar .hs-stat .dot.warn { background: var(--warn, #f59e0b); }
      .health-bar .hs-stat .dot.danger { background: var(--danger, #ef4444); }
      .health-bar .hs-stat .dot.muted { background: var(--muted); }

      /* ── Readiness (compact inline) ──────────────── */
      .readiness-inline { display: flex; align-items: center; gap: 16px; padding: 10px 0; margin-bottom: 16px; font-size: 13px; flex-wrap: wrap; }
      .readiness-inline .ri-label { font-weight: 600; color: var(--text-strong); white-space: nowrap; }
      .readiness-inline .ri-label .ri-ok { color: var(--ok, #22c55e); }
      .readiness-inline .ri-label .ri-partial { color: var(--warn, #f59e0b); }
      .readiness-inline .ri-items { display: flex; gap: 14px; flex-wrap: wrap; }
      .readiness-inline .ri-item { display: flex; align-items: center; gap: 5px; color: var(--text); }
      .readiness-inline .ri-item .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .readiness-inline .ri-item .dot.ok { background: var(--ok, #22c55e); }
      .readiness-inline .ri-item .dot.fail { background: var(--danger, #ef4444); }
      .readiness-inline .ri-item .dot.degraded { background: var(--warn, #f59e0b); }
      .truth-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-sm); margin-bottom: var(--space-lg); }
      .truth-header { display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-sm); color: var(--text-strong); font-size: var(--text-sm); font-weight: 600; }
      .truth-dimension { border: 1px solid var(--border); padding: var(--space-sm); background: var(--card); }
      .truth-label { color: var(--muted); font-size: 12px; display: block; }
      .truth-value { color: var(--text-strong); font-weight: 700; font-size: 16px; display: block; margin-top: 4px; }
      .truth-reason { color: var(--muted); font-size: 11px; display: block; margin-top: 4px; overflow-wrap: anywhere; }
      .truth-refs { display: flex; flex-wrap: wrap; gap: var(--space-xs); margin-top: var(--space-xs); }
      .resource-link { display: inline-flex; align-items: center; gap: var(--space-xs); padding: 0; border: 0; background: none; color: var(--accent); cursor: pointer; font-size: 12px; }
      .resource-link svg { width: 12px; height: 12px; }
      .resource-link:hover { text-decoration: underline; }
      .truth-dimension.critical .truth-value { color: var(--danger); }
      .truth-dimension.degraded .truth-value { color: var(--warn); }
      .truth-dimension.unknown .truth-value { color: var(--muted); }

      /* ── Issues section (highlighted anomalies) ──── */
      .issues-section { margin-bottom: 16px; }
      .issue-card { padding: 14px 16px; border-radius: var(--radius-md); border: 1px solid var(--warn, #f59e0b); background: rgba(245, 158, 11, 0.04); margin-bottom: 8px; }
      .issue-card.fail { border-color: var(--danger, #ef4444); background: rgba(239, 68, 68, 0.04); }
      .issue-card .ic-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .issue-card .ic-icon { font-size: 16px; }
      .issue-card .ic-label { font-weight: 600; font-size: 14px; color: var(--text-strong); }
      .issue-card .ic-cat { font-size: 12px; color: var(--muted); margin-left: auto; }
      .issue-card .ic-summary { font-size: 13px; color: var(--text); margin-bottom: 6px; }
      .issue-card .ic-detail { font-size: 12px; color: var(--muted); }
      .issue-card .ic-detail table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; }
      .issue-card .ic-detail th { text-align: left; font-weight: 600; color: var(--muted); padding: 3px 10px 3px 0; border-bottom: 1px solid var(--border); font-size: 11px; }
      .issue-card .ic-detail td { padding: 4px 10px 4px 0; color: var(--text); }
      .issue-card .ic-detail .pct-over { color: var(--danger, #ef4444); font-weight: 600; }
      .issue-card .ic-actions { margin-top: 10px; }
      .issue-card .ic-link { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--accent, #409eff); cursor: pointer; background: none; border: none; padding: 0; }
      .issue-card .ic-link:hover { text-decoration: underline; }

      /* ── Check table ─────────────────────────────── */
      .check-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
      .check-section-header h2 { font-size: 15px; font-weight: 600; color: var(--text-strong); margin: 0; }
      .check-section-header .filter-hint { font-size: 12px; color: var(--muted); }
      .normal-toggle { display: inline-flex; align-items: center; gap: var(--space-xs); }
      .normal-toggle svg { width: 14px; height: 14px; }
      .check-table { width: 100%; border-collapse: collapse; font-size: 13px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
      .check-table-scroll { max-width: 100%; overflow-x: auto; }
      .check-table thead th { padding: 10px 12px; font-size: 12px; font-weight: 600; color: var(--muted); text-align: left; background: var(--bg-elevated, var(--bg-app)); border-bottom: 1px solid var(--border); }
      .check-table tbody td { padding: 10px 12px; vertical-align: middle; background: var(--card); }
      .check-table tbody tr { border-bottom: 1px solid var(--border); }
      .check-table tbody tr:last-child { border-bottom: none; }
      .check-table .col-num { width: 36px; color: var(--muted); font-size: 12px; text-align: center; }
      .check-table .col-cat { width: 64px; color: var(--muted); font-size: 12px; }
      .check-table .col-label { font-weight: 500; color: var(--text); min-width: 120px; }
      .check-table .col-summary { color: var(--text); font-size: 13px; }
      .check-table .col-status { width: 72px; text-align: center; }
      .check-table .col-risk { width: 56px; text-align: center; }

      /* ── Expandable detail row ───────────────────── */
      .detail-row td { padding: 0 12px 10px 60px !important; }
      .detail-box { font-size: 12px; color: var(--text); padding: 8px 12px; background: var(--bg-elevated, var(--bg-app)); border-radius: var(--radius-sm); border: 1px solid var(--border); }
      .detail-box table { width: 100%; border-collapse: collapse; }
      .detail-box th { text-align: left; font-weight: 600; color: var(--muted); padding: 3px 10px 3px 0; border-bottom: 1px solid var(--border); font-size: 11px; }
      .detail-box td { padding: 4px 10px 4px 0; }
      .detail-box .pct-over { color: var(--danger, #ef4444); font-weight: 600; }
      .expand-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--accent, #409eff); cursor: pointer; background: none; border: none; padding: 4px 0; margin-top: 4px; }
      .expand-btn:hover { text-decoration: underline; }

      /* ── Recommendation link ─────────────────────── */
      .rec-link { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--accent, #409eff); cursor: pointer; background: none; border: none; padding: 0; margin-top: 4px; }
      .rec-link:hover { text-decoration: underline; }

      .loading, .error-state { padding: 48px; text-align: center; color: var(--muted); }
    `,
  ];

  override connectedCallback() { super.connectedCallback(); this._load(); }

  private async _load() {
    this.loading = true; this.error = null; this.expandedChecks = new Set(); this.showNormalChecks = false;
    try {
      const res = await authFetch("/api/health/overview");
      if (!res.ok) throw new Error(`加载失败 (${res.status})`);
      this.data = await res.json();
      this.truth = this.data?.truth ?? null;
    } catch (e: any) { this.error = e.message; }
    finally { this.loading = false; }
  }

  private async _refresh() {
    this.refreshing = true;
    try {
      const res = await authFetch("/api/health/overview?refresh=true");
      if (!res.ok) throw new Error(`加载失败 (${res.status})`);
      this.data = await res.json(); this.truth = this.data?.truth ?? null; this.error = null;
      this.expandedChecks = new Set();
    } catch (e: any) { console.warn('Health check refresh failed:', e.message); }
    finally { this.refreshing = false; }
  }

  private _sv(status: string) { return { pass:'ok',warn:'warn',fail:'danger',deferred:'muted' }[status] || 'muted'; }
  private _si(status: string) { return { pass:'✓',warn:'!',fail:'✕',deferred:'⏳' }[status] || '?'; }
  private _sl(status: string) { return { pass:'通过',warn:'警告',fail:'失败',deferred:'推迟' }[status] || '?'; }

  private _navigateTo(target: string) {
    const routeMap: Record<string, string> = {
      '#/database-instances': '/instances-db',
      '#/settings/llm-config': '/settings/ai/models',
      '#/settings/cron-jobs': '/cron-jobs',
      '#/settings/rbac': '/settings/access/users?view=roles',
      '#/settings/notifications': '/settings/platform/notifications',
      '#/alerts': '/events?view=active',
    };
    const targetRoute = routeMap[target] ?? '/settings';
    const basePath = inferBasePathFromPathname(window.location.pathname);
    window.history.pushState({}, '', new URL(`${basePath}${targetRoute}`, window.location.origin));
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  private _readinessItems(): ReadinessItem[] {
    if (!this.data) return [];
    const r = this.data.readiness;
    return [
      { key:'db_connected',label:'主数据库连接',status:r.db_connected,severity:'critical', suggestion:'检查 .env 中 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME 配置，以及 MySQL 服务是否运行' },
      { key:'db_reachable',label:'纳管实例可达',status:r.db_reachable,severity:'major', suggestion:'添加至少一个数据库实例并确保测试连接通过' },
      { key:'llm_provider',label:'LLM Provider',status:r.llm_provider,severity:'major', suggestion:'添加 Provider 并填写 API Key' },
      { key:'cron_running',label:'Cron 定时任务',status:r.cron_running,severity:'minor', suggestion:'启用至少一个定时任务（如容量数据采集）' },
      { key:'agent_engine',label:'Agent 引擎',status:r.agent_engine,severity:'critical', suggestion:'检查 AGENT_WS_URL 配置以及 DirectAdapter 服务是否运行' },
    ];
  }

  private _allReady(): boolean {
    if (!this.data) return false;
    const r = this.data.readiness;
    return r.db_connected && r.db_reachable && r.llm_provider && r.cron_running && r.agent_engine;
  }

  private _healthPct(): number {
    if (!this.data) return 0;
    const s = this.data.summary;
    const actionable = s.total - s.deferred;
    if (actionable === 0) return 100;
    return Math.round((s.pass / actionable) * 100);
  }

  private _healthClass(pct: number): string {
    if (pct >= 90) return 'ok';
    if (pct >= 70) return 'warn';
    return 'danger';
  }

  private _healthFill(pct: number): string {
    const color = pct >= 90 ? 'var(--ok, #22c55e)' : pct >= 70 ? 'var(--warn, #f59e0b)' : 'var(--danger, #ef4444)';
    return `width:${pct}%;background:${color}`;
  }

  private _sevLabel(severity: string): string {
    const map: Record<string, string> = { critical: '严重', major: '高', minor: '中', info: '低' };
    return map[severity] || '低';
  }

  private _sevClass(severity: string): string {
    const map: Record<string, string> = { critical: 'danger', major: 'warn', minor: 'warn', info: 'muted' };
    return map[severity] || 'muted';
  }

  private _truthLabel(key: keyof Omit<HealthTruth, 'overall'>): string {
    return { controlPlane: '控制面', managedAvailability: '纳管可用性', dataFreshness: '数据新鲜度', workflow: '工作流' }[key];
  }

  private _healthStatusLabel(status: HealthStatus): string {
    return { healthy: '健康', degraded: '降级', critical: '严重', unknown: '未知' }[status];
  }

  private _healthStatusVariant(status: HealthStatus): 'ok' | 'warn' | 'danger' | 'muted' {
    return { healthy: 'ok', degraded: 'warn', critical: 'danger', unknown: 'muted' }[status] as 'ok' | 'warn' | 'danger' | 'muted';
  }

  private _renderTruth() {
    if (!this.truth) return nothing;
    const dimensions = ['controlPlane', 'managedAvailability', 'dataFreshness', 'workflow'] as const;
    return html`<div class="truth-header">
      <span>资源总体健康</span>
      <app-badge variant=${this._healthStatusVariant(this.truth.overall)}>${this._healthStatusLabel(this.truth.overall)}</app-badge>
    </div><div class="truth-grid" aria-label="资源健康真相">
      ${dimensions.map((key) => {
        const dimension = this.truth![key];
        const refs = dimension.failedRefs ?? [];
        const detail = [dimension.reason, dimension.observedAt ? new Date(dimension.observedAt).toLocaleString() : undefined].filter(Boolean).join(' · ');
        return html`<div class="truth-dimension ${dimension.status}">
          <span class="truth-label">${this._truthLabel(key)}</span>
          <span class="truth-value">${this._healthStatusLabel(dimension.status)} · ${dimension.numerator}/${dimension.denominator}</span>
          ${refs.length ? html`<span class="truth-refs">${refs.map((ref) => this._renderResourceRef(ref))}</span>` : nothing}
          ${detail ? html`<span class="truth-reason">${detail}</span>` : nothing}
        </div>`;
      })}
    </div>`;
  }

  private _renderResourceRef(ref: { type: string; id: number | string }) {
    if (ref.type !== 'instance' && ref.type !== 'server') return html`<span class="truth-reason">${ref.type}:${ref.id}</span>`;
    const label = ref.type === 'instance' ? `实例 #${ref.id}` : `服务器 #${ref.id}`;
    return html`<button class="resource-link" @click=${() => this._navigateToResource(ref)}>${label}${icons['external-link']}</button>`;
  }

  private _navigateToResource(ref: { type: string; id: number | string }) {
    const id = Number(ref.id);
    const detail = ref.type === 'instance'
      ? { tab: 'instance-detail', id }
      : { tab: 'server-detail', serverId: id };
    window.dispatchEvent(new CustomEvent('slide-navigate', { detail }));
  }

  private _recommendationNav(checkId: string): { label: string; href: string } | null {
    const map: Record<string, { label: string; href: string }> = {
      capacity_sum_match: { label: '查看详情', href: '#/settings/cron-jobs' },
      metrics_freshness: { label: '查看详情', href: '#/settings/cron-jobs' },
      alert_rule_metric_refs: { label: '查看详情', href: '#/alerts' },
      cron_hung_jobs: { label: '查看详情', href: '#/settings/cron-jobs' },
      instance_count_match: { label: '查看详情', href: '#/database-instances' },
      rbac_orphan_records: { label: '查看详情', href: '#/settings/rbac' },
      notification_closure: { label: '查看详情', href: '#/settings/notifications' },
    };
    return map[checkId] || null;
  }

  private _toggleExpand(checkId: string) {
    const next = new Set(this.expandedChecks);
    if (next.has(checkId)) next.delete(checkId); else next.add(checkId);
    this.expandedChecks = next;
  }

  private _renderCapacityDetailTable(details: unknown) {
    if (!Array.isArray(details) || details.length === 0) return nothing;
    const rows = details as Array<{ name: string; inst_size: number; cap_size: number; cap_ts: string | null }>;
    return html`
      <table>
        <thead><tr><th>实例</th><th>DB 容量</th><th>采集容量</th><th>差异</th></tr></thead>
        <tbody>
          ${rows.map(r => {
            const diff = r.cap_size > 0 ? ((r.inst_size - r.cap_size) / r.cap_size * 100) : null;
            return html`
              <tr>
                <td>${r.name}</td>
                <td>${r.inst_size.toFixed(2)} GB</td>
                <td>${r.cap_size >= 0 ? r.cap_size.toFixed(2) + ' GB' : '无数据'}</td>
                <td>${diff !== null ? html`<span class="pct-over">+${Math.round(diff)}%</span>` : '—'}</td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    `;
  }

  override render() {
    if (this.loading) return html`<div class="loading">加载中...</div>`;
    if (this.error) return html`<div class="error-state"><p>${this.error}</p><button class="btn btn-primary" @click=${this._load}>重试</button></div>`;
    if (!this.data) return html`<div class="loading">无数据</div>`;

    const d = this.data;
    const items = this._readinessItems();
    const allReady = this._allReady();
    const healthPct = this._healthPct();
    const s = d.summary;

    // Separate checks: issues (warn/fail) vs normal (pass/deferred)
    const issueChecks = d.checks.filter(c => c.status === 'warn' || c.status === 'fail');
    const normalChecks = d.checks.filter(c => c.status === 'pass' || c.status === 'deferred');

    return html`
      <platform-observations></platform-observations>
      <!-- Page header -->
      <div class="page-header">
        <div>
          <h1>系统自检</h1>
          <p>系统数据一致性与运行状态检查 · ${new Date(d.timestamp).toLocaleString()}</p>
        </div>
        <button class="btn refresh-btn" @click=${this._refresh} ?disabled=${this.refreshing}>
          <span class=${this.refreshing ? 'spinning' : ''}>${icons['refresh-cw']}</span>
          ${this.refreshing ? '检查中…' : '刷新'}
        </button>
      </div>

      <!-- Unified health bar: score + stats in one row -->
      <div class="health-bar">
        <div class="hs-left">
          <span class="hs-label">一致性通过率</span>
          <span class="hs-pct ${this._healthClass(healthPct)}">${healthPct}%</span>
        </div>
        <div class="hs-track"><div class="hs-fill" style="${this._healthFill(healthPct)}"></div></div>
        <div class="hs-stats">
          <span class="hs-stat"><span class="dot ok"></span>${s.pass} 通过</span>
          <span class="hs-stat"><span class="dot warn"></span>${s.warn} 警告</span>
          <span class="hs-stat"><span class="dot danger"></span>${s.fail} 失败</span>
          ${s.deferred > 0 ? html`<span class="hs-stat"><span class="dot muted"></span>${s.deferred} 推迟</span>` : ''}
        </div>
      </div>

      ${this._renderTruth()}

      <!-- Readiness: compact inline, not a card -->
      <div class="readiness-inline">
        <span class="ri-label">
          系统准备度 ·
          ${allReady
            ? html`<span class="ri-ok">✓ 全部就绪</span>`
            : html`<span class="ri-partial">${items.filter(i => i.status).length}/${items.length} 就绪</span>`}
        </span>
        <div class="ri-items">
          ${items.map(item => html`
            <span class="ri-item">
              <span class="dot ${item.status ? 'ok' : (item.severity === 'critical' ? 'fail' : 'degraded')}"></span>
              ${item.label}
            </span>
          `)}
        </div>
      </div>

      <!-- Issues section: only shown when there are anomalies -->
      ${issueChecks.length > 0 ? html`
        <div class="issues-section">
          ${issueChecks.map(check => {
            const nav = this._recommendationNav(check.id);
            const isCapacity = check.id === 'capacity_sum_match' && Array.isArray(check.details);
            return html`
              <div class="issue-card ${check.status === 'fail' ? 'fail' : ''}">
                <div class="ic-header">
                  <span class="ic-icon">${check.status === 'fail' ? icons['circle-alert'] : icons['triangle-alert']}</span>
                  <span class="ic-label">${check.label}</span>
                  <span class="ic-cat">${CATEGORY_LABELS[check.category] || check.category}</span>
                </div>
                <div class="ic-summary">${check.summary}</div>
                ${isCapacity ? html`
                  <div class="ic-detail">${this._renderCapacityDetailTable(check.details)}</div>
                ` : ''}
                ${check.recommendation ? html`<div class="ic-detail">${check.recommendation}</div>` : ''}
                ${nav ? html`
                  <div class="ic-actions">
                    <button class="ic-link" @click=${() => this._navigateTo(nav.href)}>${nav.label} →</button>
                  </div>
                ` : ''}
              </div>
            `;
          })}
        </div>
      ` : ''}

      <!-- Normal checks stay collapsed so anomalies remain the primary focus. -->
      <div class="check-section-header">
        <h2>正常检查项</h2>
        <button class="btn btn-ghost normal-toggle" @click=${() => { this.showNormalChecks = !this.showNormalChecks; }}>
          ${this.showNormalChecks ? icons['chevron-up'] : icons['chevron-down']}
          ${this.showNormalChecks ? '收起正常检查' : `显示正常检查（${normalChecks.length}）`}
        </button>
      </div>
      ${this.showNormalChecks ? html`<div class="check-table-scroll"><table class="check-table">
        <thead>
          <tr>
            <th class="col-num">#</th>
            <th class="col-cat">分类</th>
            <th class="col-label">检查项</th>
            <th class="col-summary">结果</th>
            <th class="col-status">状态</th>
            <th class="col-risk">风险</th>
          </tr>
        </thead>
        <tbody>
          ${normalChecks.map((check, i) => {
            const isCapacity = check.id === 'capacity_sum_match' && Array.isArray(check.details);
            const isExpanded = this.expandedChecks.has(check.id);
            return html`
              <tr>
                <td class="col-num">${i + 1}</td>
                <td class="col-cat">${CATEGORY_LABELS[check.category] || check.category}</td>
                <td class="col-label">${check.label}</td>
                <td class="col-summary">
                  ${check.summary}
                  ${isCapacity ? html`
                    <br><button class="expand-btn" @click=${() => this._toggleExpand(check.id)}>
                      ${isExpanded ? '收起 ▲' : '展开详情 ▼'}
                    </button>
                  ` : ''}
                </td>
                <td class="col-status">
                  <app-badge variant=${this._sv(check.status)}>${this._si(check.status)} ${this._sl(check.status)}</app-badge>
                </td>
                <td class="col-risk">
                  <app-badge variant=${this._sevClass(check.severity)}>${this._sevLabel(check.severity)}</app-badge>
                </td>
              </tr>
              ${isCapacity && isExpanded ? html`
                <tr class="detail-row">
                  <td colspan="6">
                    <div class="detail-box">${this._renderCapacityDetailTable(check.details)}</div>
                  </td>
                </tr>
              ` : ''}
            `;
          })}
        </tbody>
      </table></div>` : nothing}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "health-center-page": HealthCenterPage; } }
