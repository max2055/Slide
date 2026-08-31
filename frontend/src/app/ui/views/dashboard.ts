import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "../components/app-card.js";
import "../components/app-badge.js";
import "../components/app-empty-state.js";
import "../components/app-data-table.js";
import * as echarts from "echarts";
import type { EChartsType } from "echarts";
import { icons } from "../../../icons.js";
import "../../../components/stat-card.js";
import { authFetch } from "../../../api/index.js";
import { showToast } from "../components/app-toast-container.js";
import { I18nController } from "../../i18n/lib/lit-controller.ts";
import { t } from "../../i18n/index.ts";

type ResourceType = "instance" | "server" | "network_device";
interface ResourceOverviewItem {
  resource: { type: ResourceType; id: number };
  label: string;
  status: string;
  quality: "good" | "degraded" | "invalid" | "unknown" | "partial";
  freshness: "fresh" | "stale" | "missing";
  observedAt: string | null;
  unresolvedAlerts: number;
  relationCount: number;
  impactScope: Array<{ type: ResourceType; id: number }>;
  gaps: string[];
}
interface ResourceOverview {
  schemaVersion: 1;
  collectedAt: string;
  dataQuality: "complete" | "partial" | "empty";
  summary: {
    total: number;
    byType: Record<ResourceType, number>;
    byStatus: Record<string, number>;
    fresh: number;
    stale: number;
    missing: number;
    unresolvedAlerts: number;
    impactedResources: number;
  };
  items: ResourceOverviewItem[];
}
interface ResourceMetricAggregate {
  value: number | null;
  resourceCount: number;
  observedAt: string | null;
}
interface ResourceMetricsSummary {
  schemaVersion: 1;
  collectedAt: string;
  dataQuality: "complete" | "partial" | "empty";
  scopes: Record<ResourceType, { metrics: Record<string, ResourceMetricAggregate> }>;
}

interface DashboardAiStats {
  today_total: number;
  breakdown: Record<string, number>;
  last_updated?: string;
}

interface DashboardAlert {
  id: number;
  title: string;
  severity: string;
  created_at: string;
}

@customElement("dashboard-page")
export class DashboardPage extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    @keyframes fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .dashboard-grid {
      display: flex;
      flex-direction: column;
      gap: var(--space-xl);
      padding: 0 0 var(--space-xl) 0;
      animation: fade-in 0.3s ease-out;
    }

    .dashboard-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-md);
      flex-wrap: wrap;
    }

    .scope-switch {
      display: inline-flex;
      gap: 2px;
      padding: 3px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-accent);
    }

    .scope-switch button {
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--muted);
      padding: 7px 12px;
      font-size: var(--text-sm);
      cursor: pointer;
      transition: background var(--duration-normal) var(--ease-out), color var(--duration-normal) var(--ease-out);
    }

    .scope-switch button.active {
      background: var(--card);
      color: var(--text-strong);
      box-shadow: var(--shadow-sm);
    }

    .dashboard-meta { color: var(--muted); font-size: var(--text-sm); display: flex; align-items: center; gap: var(--space-sm); }
    .dashboard-notice { padding: var(--space-sm) var(--space-md); border: 1px solid var(--warn); border-radius: var(--radius-sm); color: var(--warn); background: var(--warn-subtle); font-size: var(--text-sm); }
    .dashboard__stat-cards { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    .dashboard__primary { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, 1fr); gap: var(--space-md); }
    .dashboard-panel { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--card); padding: var(--space-lg); box-shadow: var(--shadow-sm); }
    .dashboard-panel__header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-md); }
    .dashboard-panel__title { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--text-md); font-weight: 600; color: var(--text-strong); }
    .health-distribution { display: grid; gap: var(--space-md); }
    .health-row { display: grid; grid-template-columns: 82px 1fr 40px; gap: var(--space-sm); align-items: center; font-size: var(--text-sm); }
    .health-track { height: 9px; display: flex; overflow: hidden; border-radius: var(--radius-sm); background: var(--bg-muted); }
    .health-track span { height: 100%; }
    .health-track .ok { background: var(--ok); } .health-track .warn { background: var(--warn); } .health-track .danger { background: var(--danger); } .health-track .muted { background: var(--muted); }
    .health-count { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-strong); }
    .metric-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-sm); }
    .metric-row { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-sm); padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-accent); }
    .metric-row__label { color: var(--muted); font-size: var(--text-sm); }
    .metric-row__value { color: var(--text-strong); font-weight: 650; font-variant-numeric: tabular-nums; }
    .metric-row__coverage { display: block; margin-top: 2px; color: var(--muted); font-size: var(--text-xs); }

    /* ---- Stat Cards Grid ---- */
    .dashboard__stat-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: var(--space-md);
    }

    /* ---- Charts Grid ---- */
    .dashboard__charts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-md);
    }

    .chart-card {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--card);
      padding: var(--space-lg);
      box-shadow: var(--shadow-sm);
    }

    .chart-card__header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-sm);
      margin-bottom: 12px;
    }

    .chart-card__title {
      font-size: var(--text-md);
      font-weight: 600;
      color: var(--text-strong);
      display: flex;
      align-items: center;
      gap: var(--space-xs);
    }
    .chart-card__title svg {
      width: 16px;
      height: 16px;
      opacity: 0.72;
      flex-shrink: 0;
    }

    .chart-card__controls {
      display: flex;
      align-items: center;
      gap: var(--space-md);
    }

    .chart-container {
      width: 100%;
      height: 260px;
    }

    .chart-empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 260px;
      color: var(--muted);
      font-size: var(--text-base);
      gap: var(--space-xs);
    }

    .chart-current-total {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: var(--text-sm);
      color: var(--muted);
      padding: var(--space-xs) 0 0 0;
    }

    .chart-current-total .total-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 10px;
      background: var(--accent-subtle);
      border-radius: var(--radius-sm);
      font-weight: 600;
      font-size: var(--text-md);
      color: var(--accent);
    }

    .chart-current-total strong {
      font-weight: 600;
      color: var(--text-strong);
    }

    /* ---- Time preset buttons ---- */
    .time-btn {
      padding: var(--space-xs) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--card);
      color: var(--muted);
      font-size: var(--text-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .time-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    .time-btn.active {
      background: var(--accent-subtle);
      border-color: var(--accent);
      color: var(--accent);
    }

    /* ---- Instance filter dropdown ---- */
    .instance-select {
      padding: var(--space-xs) var(--space-sm);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--card);
      color: var(--text);
      font-size: var(--text-sm);
      cursor: pointer;
    }

    /* ---- Date range picker ---- */
    .date-picker-group {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
    }

    .date-picker {
      padding: var(--space-xs) var(--space-sm);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--card);
      color: var(--text);
      font-size: var(--text-sm);
      cursor: pointer;
    }

    .date-separator {
      font-size: var(--text-sm);
      color: var(--muted);
    }

    /* ---- Alert Panel ---- */
    .dashboard__panels {
      display: grid;
      grid-template-columns: 1fr;
      gap: var(--space-md);
      margin-top: var(--space-sm);
    }

    .resource-overview-card {
      display: block;
    }

    .resource-overview-summary {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-sm) var(--space-lg);
      margin-bottom: var(--space-md);
      color: var(--muted);
      font-size: var(--text-sm);
    }

    .resource-overview-summary span {
      white-space: nowrap;
    }

    .resource-overview-table {
      overflow-x: auto;
    }


    .status-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }

    .status-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px var(--space-md);
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
      transition: background 0.15s ease;
      cursor: pointer;
    }

    .status-item:hover {
      background: var(--bg-hover);
    }

    .status-item__left {
      display: flex;
      align-items: center;
      gap: var(--space-md);
    }

    .status-item__icon {
      width: 28px;
      height: 28px;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .status-item__icon svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.5px;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .status-item__icon.ok {
      background: var(--ok-subtle);
      color: var(--ok);
    }

    .status-item__icon.warn {
      background: var(--warn-subtle);
      color: var(--warn);
    }

    .status-item__icon.danger {
      background: var(--danger-subtle);
      color: var(--danger);
    }

    .status-item__name {
      font-size: var(--text-base);
      font-weight: 500;
      color: var(--text-strong);
    }

    .status-item__time {
      font-size: var(--text-sm);
      color: var(--muted);
      flex-shrink: 0;
      min-width: 72px;
      text-align: right;
    }

    .status-item__time small {
      color: var(--muted);
      font-size: var(--text-xs);
      white-space: nowrap;
    }



    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 300px;
      color: var(--muted);
    }

    /* ---- Responsive Breakpoints ---- */
    @media (max-width: 1200px) {
      .dashboard__stat-cards {
        grid-template-columns: repeat(3, 1fr);
      }
      .dashboard__charts {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 768px) {
      .dashboard__stat-cards {
        grid-template-columns: repeat(2, 1fr);
      }
      .dashboard__primary { grid-template-columns: 1fr; }
    }

    @media (max-width: 480px) {
      .dashboard__stat-cards,
      .dashboard__charts,
      .metric-list {
        grid-template-columns: 1fr;
      }
    }
  `;

  @state() private dbTypeDistribution: Array<{ name: string; value: number }> = [];
  @state() private capacityTrend: { current_total_gb: number; trend: Array<{ time: string; total_size_gb: number }> } | null = null;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private selectedHours = 168;
  @state() private selectedInstanceId: number | null = null;
  @state() private instances: Array<{ id: number; name: string; db_type: string; health_status?: string | null }> = [];
  @state() private startDate = '';
  @state() private endDate = '';
  @state() private trendLoading = false;
  @state() private resourceOverview: ResourceOverview | null = null;
  @state() private resourceMetrics: ResourceMetricsSummary | null = null;
  @state() private aiStats: DashboardAiStats | null = null;
  @state() private recentAlerts: DashboardAlert[] = [];
  @state() private resourceScope: "all" | ResourceType = "all";
  @state() private moduleErrors: string[] = [];

  private readonly _i18n = new I18nController(this);

  // ECharts instances for lifecycle management
  private _pieChart: EChartsType | null = null;
  private _pieRO: ResizeObserver | null = null;
  private _trendChart: EChartsType | null = null;
  private _trendRO: ResizeObserver | null = null;
  private _pieContainer: HTMLDivElement | null = null;
  private _trendContainer: HTMLDivElement | null = null;

  override firstUpdated() {
    this.loadDashboardData();
  }

  override updated(changedProperties: Map<string, unknown>) {
    const chartStateChanged = changedProperties.has('dbTypeDistribution')
      || changedProperties.has('capacityTrend')
      || changedProperties.has('resourceScope')
      || changedProperties.has('loading');
    this._syncPieChart(chartStateChanged);
    this._syncTrendChart(chartStateChanged);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._disposePieChart();
    this._disposeTrendChart();
  }

  private _disposePieChart() {
    this._pieRO?.disconnect();
    this._pieChart?.dispose();
    this._pieChart = null;
    this._pieRO = null;
    this._pieContainer = null;
  }

  private _disposeTrendChart() {
    this._trendRO?.disconnect();
    this._trendChart?.dispose();
    this._trendChart = null;
    this._trendRO = null;
    this._trendContainer = null;
  }

  private _databaseChartsVisible(): boolean {
    return !this.loading && (this.resourceScope === 'all' || this.resourceScope === 'instance');
  }

  private _syncPieChart(force = false) {
    const container = this.renderRoot.querySelector('.pie-chart-container') as HTMLDivElement | null;
    if (!this._databaseChartsVisible() || !container || this.dbTypeDistribution.length === 0) {
      this._disposePieChart();
      return;
    }
    if (!force && this._pieChart && this._pieContainer === container) return;
    this._disposePieChart();
    const { chart, ro } = this._initPieChart(container, this.dbTypeDistribution);
    this._pieChart = chart;
    this._pieRO = ro;
    this._pieContainer = container;
  }

  private _syncTrendChart(force = false) {
    const container = this.renderRoot.querySelector('.trend-chart-container') as HTMLDivElement | null;
    if (!this._databaseChartsVisible() || !container || !this.capacityTrend?.trend.length) {
      this._disposeTrendChart();
      return;
    }
    if (!force && this._trendChart && this._trendContainer === container) return;
    this._disposeTrendChart();
    const times = this.capacityTrend.trend.map((point) => point.time);
    const values = this.capacityTrend.trend.map((point) => point.total_size_gb);
    const { chart, ro } = this._initTrendChart(container, { time: times, values });
    this._trendChart = chart;
    this._trendRO = ro;
    this._trendContainer = container;
  }

  private async loadDashboardData() {
    const errors: string[] = [];
    const [overviewResult, metricsResult, alertsResult, instancesResult, capacityResult, aiStatsResult] = await Promise.allSettled([
      authFetch("/api/resources/overview"),
      authFetch("/api/resources/metrics/summary"),
      authFetch("/api/alerts"),
      authFetch("/api/database/instances"),
      authFetch(`/api/dashboard/capacity-trend?hours=${this.selectedHours}`),
      authFetch("/api/dashboard/ai-stats"),
    ]);

    const responseJson = async (result: PromiseSettledResult<Response>) => {
      if (result.status !== "fulfilled" || !result.value.ok) return null;
      try {
        return await result.value.json();
      } catch {
        return null;
      }
    };
    const [overview, metrics, alertsData, instances, capacity, aiStats] = await Promise.all([
      responseJson(overviewResult), responseJson(metricsResult), responseJson(alertsResult),
      responseJson(instancesResult), responseJson(capacityResult), responseJson(aiStatsResult),
    ]);
    if (overview) this.resourceOverview = overview as ResourceOverview;
    else {
      this.resourceOverview = null;
      errors.push(t("dashboard.overviewUnavailable"));
    }
    if (metrics) this.resourceMetrics = metrics as ResourceMetricsSummary;
    else {
      this.resourceMetrics = null;
      errors.push(t("dashboard.metricsUnavailable"));
    }
    if (alertsData) {
      const alerts = Array.isArray(alertsData)
        ? alertsData
        : alertsData && Array.isArray(alertsData.items) ? alertsData.items : [];
      this.recentAlerts = alerts
        .filter((alert: any) => !alert.acknowledged)
        .slice(0, 3)
        .map((alert: any) => ({
          id: Number(alert.id),
          title: String(alert.title ?? alert.message ?? t('dashboard.unknownAlert')),
          severity: String(alert.severity ?? alert.level ?? 'info').toLowerCase(),
          created_at: String(alert.created_at ?? alert.createdAt ?? new Date().toISOString()),
        }));
    } else {
      this.recentAlerts = [];
      errors.push(t("dashboard.alertsUnavailable"));
    }
    if (instances) {
      const list = instances as Array<{ id: number; name: string; db_type: string; health_status: string | null; last_health_check_at: string | null }>;
      this.instances = list;
      const typeMap: Record<string, number> = {};
      for (const inst of list) typeMap[inst.db_type || "unknown"] = (typeMap[inst.db_type || "unknown"] || 0) + 1;
      this.dbTypeDistribution = Object.entries(typeMap).map(([name, value]) => ({ name, value }));
    } else {
      this.instances = [];
      this.dbTypeDistribution = [];
    }
    if (capacity) this.capacityTrend = capacity;
    else this.capacityTrend = null;
    if (aiStats) this.aiStats = aiStats as DashboardAiStats;
    else {
      this.aiStats = null;
      errors.push(t("dashboard.aiUnavailable"));
    }
    this.moduleErrors = errors;
    this.error = !this.resourceOverview && !this.resourceMetrics ? t("dashboard.overviewUnavailable") : null;
    this.loading = false;
  }

  private async reloadTrend(opts?: { hours?: number; instanceId?: number | null; startDate?: string; endDate?: string }) {
    this.trendLoading = true;
    try {
      const qp = new URLSearchParams();

      if (opts?.startDate && opts?.endDate) {
        qp.set('start_date', opts.startDate);
        qp.set('end_date', opts.endDate);
        this.selectedHours = 0;
        this.startDate = opts.startDate;
        this.endDate = opts.endDate;
      } else {
        const hours = opts?.hours ?? this.selectedHours;
        qp.set('hours', String(hours));
        this.selectedHours = hours;
        this.startDate = '';
        this.endDate = '';
      }

      const instanceId = opts?.instanceId !== undefined ? opts.instanceId : this.selectedInstanceId;
      if (instanceId) qp.set('instance_id', String(instanceId));

      const res = await authFetch(`/api/dashboard/capacity-trend?${qp.toString()}`);
      if (!res.ok) throw new Error(t("dashboard.capacityLoadFailed"));
      const data = await res.json();
      this.capacityTrend = data;
    } catch (err: any) {
      showToast('Failed to load capacity trend', 'error');
    } finally {
      this.trendLoading = false;
    }
  }

  private _initPieChart(container: HTMLDivElement, data: Array<{ name: string; value: number }>) {
    const chart = echarts.init(container, undefined, { renderer: "canvas" });
    const total = data.reduce((s, d) => s + d.value, 0);

    chart.setOption({
      tooltip: {
        trigger: "item",
        formatter: (params: any) => {
          const pct = ((params.value / total) * 100).toFixed(1);
          return `${params.name}<br/>${t("dashboard.instanceCount")}: ${params.value}<br/>${t("dashboard.shareLabel")}: ${pct}%`;
        },
      },
      legend: {
        orient: "horizontal",
        left: "center",
        bottom: 0,
        itemGap: 16,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#777", fontSize: 12 },
        formatter: (name: string) => {
          const item = data.find(d => d.name === name);
          const pct = item ? ((item.value / total) * 100).toFixed(1) : "0";
          return `${name}  ${pct}%`;
        },
      },
      series: [{
        type: "pie",
        radius: "75%",
        center: ["50%", "48%"],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 4, borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        emphasis: {
          label: { show: true, fontSize: 13, fontWeight: "bold" },
        },
        data,
      }],
    });

    chart.on("click", (params: any) => {
      window.dispatchEvent(new CustomEvent("slide-navigate", {
        detail: { tab: "instances-db", filter: { db_type: params.name.toLowerCase() } },
      }));
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(container);
    return { chart, ro };
  }

  private _initTrendChart(container: HTMLDivElement, data: { time: string[]; values: number[] }) {
    const chart = echarts.init(container, undefined, { renderer: "canvas" });

    chart.setOption({
      tooltip: {
        trigger: "axis",
        formatter: (params: any) => {
          return `${params[0].name}<br/>${t("dashboard.dataTotal")}: ${params[0].value.toFixed(2)} GB`;
        },
      },
      grid: { left: 50, right: 20, top: 10, bottom: 30 },
      xAxis: {
        type: "category",
        data: data.time,
        boundaryGap: false,
        axisLabel: { color: "#777", fontSize: 11 },
        axisLine: { lineStyle: { color: "#d0d0d0" } },
      },
      yAxis: {
        type: "value",
        name: "GB",
        axisLabel: { color: "#777", fontSize: 11 },
        splitLine: { lineStyle: { color: "#d0d0d0", type: "dashed" } },
      },
      series: [{
        type: "line",
        data: data.values,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color: "#409eff" },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(64, 158, 255, 0.3)" },
            { offset: 1, color: "rgba(64, 158, 255, 0.05)" },
          ]),
        },
      }],
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(container);
    return { chart, ro };
  }

  private _navigateTo(tab: string) {
    window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab } }));
  }

  private _resourceTypeLabel(type: ResourceType): string {
    return type === "instance" ? t("dashboard.database") : type === "server" ? t("dashboard.server") : t("dashboard.networkDevice");
  }

  private _resourceStatusVariant(item: ResourceOverviewItem): "ok" | "warn" | "danger" | "muted" {
    // An explicit outage or missing collection evidence is actionable even
    // when no alert has been emitted yet, so it must remain in the danger
    // queue instead of being hidden as a muted/unknown state.
    if (["offline", "error", "critical", "unreachable", "down"].includes(item.status.toLowerCase())) return "danger";
    if (item.freshness === "missing") return "danger";
    if (item.quality === "invalid") return "danger";
    if (item.freshness === "stale" || item.quality === "degraded" || item.quality === "partial" || item.unresolvedAlerts > 0) return "warn";
    return "ok";
  }

  private _visibleResourceItems(): ResourceOverviewItem[] {
    const items = this.resourceOverview?.items ?? [];
    return this.resourceScope === "all" ? items : items.filter((item) => item.resource.type === this.resourceScope);
  }

  private _visibleResourceSummary() {
    const items = this._visibleResourceItems();
    const healthy = items.filter((item) => this._resourceStatusVariant(item) === "ok").length;
    const degraded = items.filter((item) => this._resourceStatusVariant(item) === "warn").length;
    const critical = items.filter((item) => this._resourceStatusVariant(item) === "danger" || item.freshness === "missing").length;
    return {
      total: items.length,
      healthy,
      degraded,
      critical,
      activeIncidents: items.reduce((total, item) => total + item.unresolvedAlerts, 0),
      staleOrMissing: items.filter((item) => item.freshness !== "fresh").length,
    };
  }

  private _scopeLabel(scope: "all" | ResourceType): string {
    return scope === "all" ? t("dashboard.allResources") : this._resourceTypeLabel(scope);
  }

  private _resourceMetricRows(): Array<{ label: string; value: string; coverage: string }> {
    const scope = this.resourceScope === "all" ? null : this.resourceScope;
    const scopes = scope ? [scope] : (["instance", "server", "network_device"] as ResourceType[]);
    const labels: Record<string, string> = {
      cpu_usage: t("dashboard.metrics.cpuUsage"), memory_usage: t("dashboard.metrics.memoryUsage"), disk_usage: t("dashboard.metrics.diskUsage"),
      connections: t("dashboard.metrics.connections"), qps: "QPS", load_1min: t("dashboard.metrics.load1m"),
      device_reachability: t("dashboard.metrics.deviceReachability"), device_cpu_percent: t("dashboard.metrics.deviceCpu"), device_memory_percent: t("dashboard.metrics.deviceMemory"),
      device_temperature_celsius: t("dashboard.metrics.deviceTemperature"),
    };
    const rows: Array<{ label: string; value: string; coverage: string }> = [];
    for (const type of scopes) {
      const metrics = this.resourceMetrics?.scopes[type]?.metrics ?? {};
      for (const [metricId, metric] of Object.entries(metrics)) {
        if (metric.value == null || !metric.resourceCount) continue;
        let value: string;
        if (metricId === "device_reachability") {
          value = metric.value >= 1 ? t("dashboard.reachable") : t("dashboard.unreachable");
        } else {
          const suffix = /(?:percent|usage)$/.test(metricId) || metricId === "cpu_usage" ? "%" : metricId.includes("temperature") ? " °C" : "";
          const numeric = metric.value < 10 && suffix === "%" ? metric.value.toFixed(1) : String(Math.round(metric.value * 10) / 10);
          value = `${numeric}${suffix}`;
        }
        rows.push({ label: `${this._resourceTypeLabel(type)} · ${labels[metricId] ?? metricId}`, value, coverage: t("dashboard.resourceCoverage", { count: String(metric.resourceCount) }) });
      }
    }
    return rows.slice(0, 8);
  }

  private _resourceRows(): Array<Record<string, unknown>> {
    return this._visibleResourceItems().map((item) => ({
      resource: html`<span>${this._resourceTypeLabel(item.resource.type)} · ${item.label}</span>`,
      status: html`<app-badge variant=${this._resourceStatusVariant(item)}>${item.status || "unknown"}</app-badge>`,
      freshness: html`<app-badge variant=${item.freshness === "fresh" ? "ok" : item.freshness === "stale" ? "warn" : "danger"}>${this._freshnessLabel(item.freshness)}</app-badge>`,
      alerts: item.unresolvedAlerts,
      relations: t("dashboard.relationsValue", { relations: String(item.relationCount), impact: String(item.impactScope.length) }),
      gaps: item.gaps.length ? item.gaps.join(", ") : "-",
    }));
  }

  private _freshnessLabel(freshness: ResourceOverviewItem["freshness"]): string {
    return freshness === "fresh" ? t("dashboard.fresh") : freshness === "stale" ? t("dashboard.stale") : t("dashboard.missing");
  }

  private _combinedDataQuality(): ResourceOverview["dataQuality"] {
    const overviewQuality = this.resourceOverview?.dataQuality;
    const metricsQuality = this.resourceMetrics?.dataQuality;
    if (!overviewQuality && !metricsQuality) return "empty";
    if (!overviewQuality || !metricsQuality) return "partial";
    if (overviewQuality === "empty" && metricsQuality === "empty") return "empty";
    if (overviewQuality === "partial" || metricsQuality === "partial"
      || overviewQuality === "empty" || metricsQuality === "empty") return "partial";
    return "complete";
  }

  private _qualityLabel(quality: ResourceOverview["dataQuality"]): string {
    return quality === "complete" ? t("dashboard.complete") : quality === "partial" ? t("dashboard.partial") : t("dashboard.empty");
  }

  private _riskPriority(item: ResourceOverviewItem): number {
    const variant = this._resourceStatusVariant(item);
    return variant === "danger" ? 2 : variant === "warn" ? 1 : 0;
  }

  private _renderRecentAlerts() {
    return html`
      <section class="dashboard-panel">
        <div class="dashboard-panel__header">
          <span class="dashboard-panel__title">${icons['triangle-alert']} ${t("dashboard.recentAlerts")}</span>
          <button class="btn-ghost" @click=${() => this._navigateTo('alerts')}>${t("dashboard.viewAlerts")}</button>
        </div>
        ${this.recentAlerts.length ? html`<div class="status-list">${this.recentAlerts.map((alert) => html`
          <div class="status-item" @click=${() => this._navigateTo('alerts')}>
            <div class="status-item__left">
              <div class="status-item__icon ${alert.severity === 'critical' || alert.severity === 'error' ? 'danger' : alert.severity === 'warning' || alert.severity === 'warn' ? 'warn' : 'ok'}">
                ${alert.severity === 'critical' || alert.severity === 'error' ? icons['alert-circle'] : alert.severity === 'warning' || alert.severity === 'warn' ? icons['triangle-alert'] : icons['info']}
              </div>
              <span class="status-item__name">${alert.title}</span>
            </div>
            <span class="status-item__time">${this._formatTime(alert.created_at)}</span>
          </div>`)} </div>` : html`<app-empty-state title=${t("dashboard.noRecentAlerts")} description=${t("dashboard.systemNormal")}><div slot="icon">${icons['check-circle']}</div></app-empty-state>`}
      </section>
    `;
  }

  private _renderResourceOverview() {
    const overview = this.resourceOverview;
    if (!overview) return nothing;
    return html`
      <app-card class="resource-overview-card">
        <span slot="header">${t("dashboard.resourceInventory")}</span>
        <div class="resource-overview-summary"><span>${t("dashboard.currentScope")}：${this._scopeLabel(this.resourceScope)}</span><span>${t("dashboard.relationsAndGaps")}</span></div>
        ${this._visibleResourceItems().length
          ? html`<div class="resource-overview-table"><app-data-table .columns=${[
            { key: "resource", label: t("dashboard.resource") },
            { key: "status", label: t("dashboard.status") },
            { key: "freshness", label: t("dashboard.freshness") },
            { key: "alerts", label: t("dashboard.unresolvedAlerts"), textAlign: "right" },
            { key: "relations", label: t("dashboard.relationsImpact") },
            { key: "gaps", label: t("dashboard.gaps") },
          ]} .rows=${this._resourceRows()} .dense=${true} emptyMessage=${t("dashboard.noResources")}></app-data-table></div>`
          : html`<app-empty-state title=${t("dashboard.noResources")} description=${t("dashboard.addResources")}></app-empty-state>`}
      </app-card>
    `;
  }

  private _formatBytes(gb: number): string {
    if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
    return `${gb.toFixed(2)} GB`;
  }

  private _formatTime(dateStr: string): string {
    const date = new Date(dateStr);
    const diff = Date.now() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    if (minutes < 1) return t("dashboard.justNow");
    if (minutes < 60) return t("dashboard.minutesAgo", { count: String(minutes) });
    if (hours < 24) return t("dashboard.hoursAgo", { count: String(hours) });
    return t("dashboard.today");
  }

  private _onInstanceChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    this.selectedInstanceId = select.value ? Number(select.value) : null;
    this.reloadTrend({ hours: this.selectedHours, instanceId: this.selectedInstanceId });
  }

  private get _instanceOptions() {
    return this.instances.map(i => html`<option value=${i.id}>${i.name}</option>`);
  }

  private _onStartDateChange(e: Event) {
    this.startDate = (e.target as HTMLInputElement).value;
    if (this.startDate && this.endDate) {
      this.reloadTrend({ startDate: this.startDate, endDate: this.endDate, instanceId: this.selectedInstanceId });
    }
  }

  private _onEndDateChange(e: Event) {
    this.endDate = (e.target as HTMLInputElement).value;
    if (this.startDate && this.endDate) {
      this.reloadTrend({ startDate: this.startDate, endDate: this.endDate, instanceId: this.selectedInstanceId });
    }
  }

  override render() {
    if (this.loading) {
      return html`<div class="loading" style="flex-direction:column;gap:16px;padding:40px;">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-md);">
            <div class="skeleton-stat" style="width:100%;height:80px;"></div>
            <div class="skeleton-stat" style="width:100%;height:80px;"></div>
            <div class="skeleton-stat" style="width:100%;height:80px;"></div>
            <div class="skeleton-stat" style="width:100%;height:80px;"></div>
            <div class="skeleton-stat" style="width:100%;height:80px;"></div>
            <div class="skeleton-stat" style="width:100%;height:80px;"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-md);">
            <div class="skeleton-block" style="height:320px;"></div>
            <div class="skeleton-block" style="height:320px;"></div>
          </div>
          <div class="skeleton-block" style="height:200px;"></div>
        </div>`;
    }

    if (this.error) {
      return html`<div class="dashboard-panel" style="color: var(--danger);">${this.error}</div>`;
    }
    const summary = this._visibleResourceSummary();
    const typeCounts = (['instance', 'server', 'network_device'] as ResourceType[]).map((type) => ({ type, count: this._visibleResourceItems().filter((item) => item.resource.type === type).length }));
    const riskItems = this._visibleResourceItems()
      .filter((item) => this._resourceStatusVariant(item) !== 'ok')
      .sort((a, b) => this._riskPriority(b) - this._riskPriority(a)
        || b.unresolvedAlerts - a.unresolvedAlerts
        || b.impactScope.length - a.impactScope.length)
      .slice(0, 5);
    const freshnessCounts = {
      fresh: this._visibleResourceItems().filter((item) => item.freshness === 'fresh').length,
      stale: this._visibleResourceItems().filter((item) => item.freshness === 'stale').length,
      missing: this._visibleResourceItems().filter((item) => item.freshness === 'missing').length,
    };
    const quality = this._combinedDataQuality();
    return html`
      <div class="dashboard-grid">
        <div class="dashboard-toolbar">
          <div class="scope-switch" role="tablist" aria-label=${t("dashboard.resourceScope")}>
            ${(['all', 'instance', 'server', 'network_device'] as const).map((scope) => html`
              <button class=${this.resourceScope === scope ? 'active' : ''} aria-selected=${this.resourceScope === scope} @click=${() => { this.resourceScope = scope; }}>${this._scopeLabel(scope)}</button>
            `)}
          </div>
          <div class="dashboard-meta">
            <span>${t("dashboard.collectedAt")} ${this.resourceOverview?.collectedAt ? this._formatTime(this.resourceOverview.collectedAt) : t("dashboard.unknown")}</span>
            <app-badge variant=${quality === 'complete' ? 'ok' : quality === 'partial' ? 'warn' : 'muted'}>${this._qualityLabel(quality)}</app-badge>
            <button class="btn-ghost" @click=${() => this.loadDashboardData()}>${t("dashboard.refresh")}</button>
          </div>
        </div>
        ${this.moduleErrors.length ? html`<div class="dashboard-notice">${this.moduleErrors.join(' · ')}</div>` : nothing}

        <div class="dashboard__stat-cards">
          <stat-card label=${t("dashboard.managedResources")} value=${summary.total} hint=${typeCounts.map(({ type, count }) => `${this._resourceTypeLabel(type)} ${count}`).join(' · ')}></stat-card>
          <stat-card label=${t("dashboard.healthyOnline")} value=${summary.healthy} variant="ok" hint=${t("dashboard.share", { percent: String(summary.total ? Math.round(summary.healthy / summary.total * 100) : 0) })}></stat-card>
          <stat-card label=${t("dashboard.degraded")} value=${summary.degraded} variant="warn" hint=${t("dashboard.needsAttention")}></stat-card>
          <stat-card label=${t("dashboard.criticalOffline")} value=${summary.critical} variant="danger" hint=${t("dashboard.prioritize")}></stat-card>
          <stat-card label=${t("dashboard.activeIncidents")} value=${summary.activeIncidents} variant=${summary.activeIncidents ? 'warn' : 'ok'} hint=${t("dashboard.unresolvedAlerts")}></stat-card>
          <stat-card label=${t("dashboard.staleMissing")} value=${summary.staleOrMissing} variant=${summary.staleOrMissing ? 'warn' : 'ok'} hint=${t("dashboard.collectionQuality")}></stat-card>
          <stat-card label=${t("dashboard.aiAnalyses")} value=${this.aiStats?.today_total ?? 0} hint=${t("dashboard.today")}></stat-card>
        </div>

        <div class="dashboard__primary">
          <section class="dashboard-panel">
            <div class="dashboard-panel__header"><span class="dashboard-panel__title">${icons['triangle-alert']} ${t("dashboard.riskQueue")}</span><button class="btn-ghost" @click=${() => this._navigateTo('alerts')}>${t("dashboard.viewAlerts")}</button></div>
            ${riskItems.length ? html`<div class="status-list">${riskItems.map((item) => html`
              <div class="status-item" @click=${() => this._navigateTo(item.resource.type === 'instance' ? 'instances-db' : item.resource.type === 'server' ? 'servers' : 'network-devices')}>
                <div class="status-item__left"><div class="status-item__icon ${this._resourceStatusVariant(item)}">${icons['triangle-alert']}</div><span class="status-item__name">${this._resourceTypeLabel(item.resource.type)} · ${item.label}</span></div>
                <span class="status-item__time">${item.unresolvedAlerts ? t("dashboard.alertCount", { count: String(item.unresolvedAlerts) }) : item.status}<br><small>${this._freshnessLabel(item.freshness)} · ${t("dashboard.impactCount", { count: String(item.impactScope.length) })}</small></span>
              </div>` )}</div>` : html`<app-empty-state title=${t("dashboard.noRisks")} description=${t("dashboard.noRisksDescription")}><div slot="icon">${icons['check-circle']}</div></app-empty-state>`}
          </section>
          <section class="dashboard-panel">
            <div class="dashboard-panel__header"><span class="dashboard-panel__title">${t("dashboard.healthDistribution")}</span><span class="dashboard-meta">${this._scopeLabel(this.resourceScope)}</span></div>
            <div class="health-distribution">${typeCounts.filter(({ count }) => count > 0).map(({ type, count }) => {
              const items = this._visibleResourceItems().filter((item) => item.resource.type === type);
              const ok = items.filter((item) => this._resourceStatusVariant(item) === 'ok').length;
              const warn = items.filter((item) => this._resourceStatusVariant(item) === 'warn').length;
              const danger = items.filter((item) => this._resourceStatusVariant(item) === 'danger').length;
              const muted = Math.max(0, count - ok - warn - danger);
              return html`<div class="health-row"><span>${this._resourceTypeLabel(type)}</span><div class="health-track"><span class="ok" style="width:${ok / count * 100}%"></span><span class="warn" style="width:${warn / count * 100}%"></span><span class="danger" style="width:${danger / count * 100}%"></span><span class="muted" style="width:${muted / count * 100}%"></span></div><span class="health-count">${count}</span></div>`;
            })}</div>
          </section>
        </div>

        <section class="dashboard-panel">
          <div class="dashboard-panel__header"><span class="dashboard-panel__title">${t("dashboard.collectionQuality")}</span><app-badge variant=${quality === 'complete' ? 'ok' : quality === 'partial' ? 'warn' : 'muted'}>${this._qualityLabel(quality)}</app-badge></div>
          <div class="health-distribution">
            ${(['fresh', 'stale', 'missing'] as const).map((freshness) => html`
              <div class="health-row"><span>${this._freshnessLabel(freshness)}</span><div class="health-track"><span class=${freshness === 'fresh' ? 'ok' : freshness === 'stale' ? 'warn' : 'danger'} style="width:${summary.total ? freshnessCounts[freshness] / summary.total * 100 : 0}%"></span></div><span class="health-count">${freshnessCounts[freshness]}</span></div>
            `)}
          </div>
        </section>

        <section class="dashboard-panel">
          <div class="dashboard-panel__header"><span class="dashboard-panel__title">${t("dashboard.metricSnapshot")}</span><span class="dashboard-meta">${t("dashboard.latestObservations")}</span></div>
          ${this._resourceMetricRows().length ? html`<div class="metric-list">${this._resourceMetricRows().map((metric) => html`<div class="metric-row"><div><span class="metric-row__label">${metric.label}</span><span class="metric-row__coverage">${metric.coverage}</span></div><span class="metric-row__value">${metric.value}</span></div>`)}</div>` : html`<app-empty-state title=${t("dashboard.noMetrics")} description=${t("dashboard.enableCollection")}></app-empty-state>`}
        </section>

        ${this.resourceScope === 'all' || this.resourceScope === 'instance' ? html`<div class="dashboard__charts">
          <!-- DB Type Distribution Pie Chart -->
          <div class="chart-card">
            <div class="chart-card__header">
              <span class="chart-card__title">${icons['database']} ${t("dashboard.dbTypeDistribution")}</span><span class="dashboard-meta">${t("dashboard.databaseOnly")}</span>
            </div>
            ${this.dbTypeDistribution.length > 0
              ? html`<div class="chart-container pie-chart-container"></div>`
              : html`<div class="chart-empty-state">${t("dashboard.noDatabaseInstances")}</div>`
            }
          </div>

          <!-- Data Volume Trend Line Chart -->
          <div class="chart-card">
            <div class="chart-card__header">
              <span class="chart-card__title">${icons['bar-chart']} ${t("dashboard.capacityTrend")}</span>
              <div class="chart-card__controls">
                <select class="instance-select" @change=${this._onInstanceChange}>
                  <option value="">${t("dashboard.allDatabases")}</option>
                  ${this._instanceOptions}
                </select>
                <button class="time-btn ${this.selectedHours === 24 ? 'active' : ''}" @click=${() => this.reloadTrend({ hours: 24, instanceId: this.selectedInstanceId })}>24h</button>
                <button class="time-btn ${this.selectedHours === 168 ? 'active' : ''}" @click=${() => this.reloadTrend({ hours: 168, instanceId: this.selectedInstanceId })}>7d</button>
                <button class="time-btn ${this.selectedHours === 720 ? 'active' : ''}" @click=${() => this.reloadTrend({ hours: 720, instanceId: this.selectedInstanceId })}>30d</button>
                <div class="date-picker-group">
                  <input type="date" class="date-picker" .value=${this.startDate} @change=${this._onStartDateChange}>
                  <span class="date-separator">${t("dashboard.to")}</span>
                  <input type="date" class="date-picker" .value=${this.endDate} @change=${this._onEndDateChange}>
                </div>
              </div>
            </div>
            ${this.capacityTrend && this.capacityTrend.trend.length > 0
              ? html`
                  <div class="chart-current-total">${t("dashboard.currentTotal")} <span class="total-badge">${this._formatBytes(this.capacityTrend.current_total_gb)}</span></div>
                  <div class="chart-container trend-chart-container"></div>
                `
              : html`<div class="chart-empty-state">${t("dashboard.noCapacityData")}</div>`
            }
          </div>
        </div>` : nothing}

        ${this._renderRecentAlerts()}
        ${this._renderResourceOverview()}
      </div>
    `;
  }
}

if (!customElements.get("dashboard-page")) {
  customElements.define("dashboard-page", DashboardPage);
}
