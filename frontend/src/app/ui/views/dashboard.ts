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
    .dashboard__stat-cards { grid-template-columns: repeat(6, minmax(0, 1fr)); }
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
      grid-template-columns: repeat(6, 1fr);
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
  @state() private resourceScope: "all" | ResourceType = "all";
  @state() private moduleErrors: string[] = [];

  // ECharts instances for lifecycle management
  private _pieChart: EChartsType | null = null;
  private _pieRO: ResizeObserver | null = null;
  private _trendChart: EChartsType | null = null;
  private _trendRO: ResizeObserver | null = null;

  override firstUpdated() {
    this.loadDashboardData();
  }

  override updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('dbTypeDistribution') && this.dbTypeDistribution.length > 0) {
      this._disposePieChart();
      const container = this.renderRoot.querySelector('.pie-chart-container') as HTMLDivElement;
      if (container) {
        const { chart, ro } = this._initPieChart(container, this.dbTypeDistribution);
        this._pieChart = chart;
        this._pieRO = ro;
      }
    }
    if (changedProperties.has('capacityTrend') && this.capacityTrend && this.capacityTrend.trend.length > 0) {
      this._disposeTrendChart();
      const container = this.renderRoot.querySelector('.trend-chart-container') as HTMLDivElement;
      if (container) {
        const times = this.capacityTrend.trend.map(t => t.time);
        const values = this.capacityTrend.trend.map(t => t.total_size_gb);
        const { chart, ro } = this._initTrendChart(container, { time: times, values });
        this._trendChart = chart;
        this._trendRO = ro;
      }
    }
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
  }

  private _disposeTrendChart() {
    this._trendRO?.disconnect();
    this._trendChart?.dispose();
    this._trendChart = null;
    this._trendRO = null;
  }

  private async loadDashboardData() {
    const errors: string[] = [];
    const [overviewResult, metricsResult, alertsResult, instancesResult, capacityResult] = await Promise.allSettled([
      authFetch("/api/resources/overview"),
      authFetch("/api/resources/metrics/summary"),
      authFetch("/api/alerts"),
      authFetch("/api/database/instances"),
      authFetch(`/api/dashboard/capacity-trend?hours=${this.selectedHours}`),
    ]);

    const responseJson = async (result: PromiseSettledResult<Response>) => {
      if (result.status !== "fulfilled" || !result.value.ok) return null;
      try {
        return await result.value.json();
      } catch {
        return null;
      }
    };
    const [overview, metrics, alertsData, instances, capacity] = await Promise.all([
      responseJson(overviewResult), responseJson(metricsResult), responseJson(alertsResult),
      responseJson(instancesResult), responseJson(capacityResult),
    ]);
    if (overview) this.resourceOverview = overview as ResourceOverview;
    else errors.push("资源总览暂不可用");
    if (metrics) this.resourceMetrics = metrics as ResourceMetricsSummary;
    else errors.push("统一指标暂不可用");
    if (alertsData) {
      const alerts = alertsData.items ?? alertsData;
      const unreadAlerts = alerts.filter((a: any) => !a.acknowledged);
    } else errors.push("告警暂不可用");
    if (instances) {
      const list = instances as Array<{ id: number; name: string; db_type: string; health_status: string | null; last_health_check_at: string | null }>;
      this.instances = list;
      const typeMap: Record<string, number> = {};
      for (const inst of list) typeMap[inst.db_type || "unknown"] = (typeMap[inst.db_type || "unknown"] || 0) + 1;
      this.dbTypeDistribution = Object.entries(typeMap).map(([name, value]) => ({ name, value }));
    }
    if (capacity) this.capacityTrend = capacity;
    this.moduleErrors = errors;
    this.error = !this.resourceOverview && !this.resourceMetrics ? "统一资源总览暂不可用" : null;
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
      if (!res.ok) throw new Error("加载容量趋势失败");
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
          return `${params.name}<br/>实例数: ${params.value}<br/>占比: ${pct}%`;
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
          return `${params[0].name}<br/>数据总量: ${params[0].value.toFixed(2)} GB`;
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
    return type === "instance" ? "数据库" : type === "server" ? "服务器" : "网络设备";
  }

  private _resourceStatusVariant(item: ResourceOverviewItem): "ok" | "warn" | "danger" | "muted" {
    if (item.freshness === "missing" || item.quality === "invalid") return "muted";
    if (item.freshness === "stale" || item.quality === "degraded" || item.quality === "partial" || item.unresolvedAlerts > 0) return "warn";
    if (["offline", "error", "critical", "unreachable", "down"].includes(item.status.toLowerCase())) return "danger";
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
    return scope === "all" ? "全部资源" : this._resourceTypeLabel(scope);
  }

  private _resourceMetricRows(): Array<{ label: string; value: string; coverage: string }> {
    const scope = this.resourceScope === "all" ? null : this.resourceScope;
    const scopes = scope ? [scope] : (["instance", "server", "network_device"] as ResourceType[]);
    const labels: Record<string, string> = {
      cpu_usage: "CPU 使用率", memory_usage: "内存使用率", disk_usage: "磁盘使用率",
      connections: "活动连接", qps: "QPS", load_1min: "1 分钟负载",
      device_reachability: "设备可达率", device_cpu_percent: "设备 CPU", device_memory_percent: "设备内存",
      device_temperature_celsius: "设备温度",
    };
    const rows: Array<{ label: string; value: string; coverage: string }> = [];
    for (const type of scopes) {
      const metrics = this.resourceMetrics?.scopes[type]?.metrics ?? {};
      for (const [metricId, metric] of Object.entries(metrics)) {
        if (metric.value == null || !metric.resourceCount) continue;
        const suffix = /percent|usage|reachability/.test(metricId) ? "%" : metricId.includes("temperature") ? " °C" : "";
        const value = metric.value < 10 && suffix === "%" ? metric.value.toFixed(1) : Math.round(metric.value * 10) / 10;
        rows.push({ label: `${this._resourceTypeLabel(type)} · ${labels[metricId] ?? metricId}`, value: `${value}${suffix}`, coverage: `${metric.resourceCount} 个资源` });
      }
    }
    return rows.slice(0, 8);
  }

  private _resourceRows(): Array<Record<string, unknown>> {
    return this._visibleResourceItems().map((item) => ({
      resource: html`<span>${this._resourceTypeLabel(item.resource.type)} · ${item.label}</span>`,
      status: html`<app-badge variant=${this._resourceStatusVariant(item)}>${item.status || "unknown"}</app-badge>`,
      freshness: html`<app-badge variant=${item.freshness === "fresh" ? "ok" : item.freshness === "stale" ? "warn" : "muted"}>${item.freshness === "fresh" ? "新鲜" : item.freshness === "stale" ? "已过期" : "无数据"}</app-badge>`,
      alerts: item.unresolvedAlerts,
      relations: `${item.relationCount} · 影响 ${item.impactScope.length}`,
      gaps: item.gaps.length ? item.gaps.join(", ") : "-",
    }));
  }

  private _renderResourceOverview() {
    const overview = this.resourceOverview;
    if (!overview) return nothing;
    return html`
      <app-card class="resource-overview-card">
        <span slot="header">资源清单与影响范围</span>
        <div class="resource-overview-summary"><span>当前范围：${this._scopeLabel(this.resourceScope)}</span><span>影响关系和采集缺口</span></div>
        ${this._visibleResourceItems().length
          ? html`<div class="resource-overview-table"><app-data-table .columns=${[
            { key: "resource", label: "资源" },
            { key: "status", label: "状态" },
            { key: "freshness", label: "数据新鲜度" },
            { key: "alerts", label: "未解决告警", textAlign: "right" },
            { key: "relations", label: "关系 / 影响范围" },
            { key: "gaps", label: "缺口" },
          ]} .rows=${this._resourceRows()} .dense=${true} emptyMessage="暂无资源"></app-data-table></div>`
          : html`<app-empty-state title="暂无基础资源" description="请先纳管数据库、服务器或网络设备"></app-empty-state>`}
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
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    return "今天";
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
          <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:var(--space-md);">
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
    const riskItems = this._visibleResourceItems().filter((item) => item.unresolvedAlerts > 0 || this._resourceStatusVariant(item) === 'danger').sort((a, b) => (b.unresolvedAlerts - a.unresolvedAlerts) || (this._resourceStatusVariant(a) === 'danger' ? -1 : 1)).slice(0, 5);
    return html`
      <div class="dashboard-grid">
        <div class="dashboard-toolbar">
          <div class="scope-switch" role="tablist" aria-label="资源范围">
            ${(['all', 'instance', 'server', 'network_device'] as const).map((scope) => html`
              <button class=${this.resourceScope === scope ? 'active' : ''} aria-selected=${this.resourceScope === scope} @click=${() => { this.resourceScope = scope; }}>${this._scopeLabel(scope)}</button>
            `)}
          </div>
          <div class="dashboard-meta">
            <span>采集于 ${this.resourceOverview?.collectedAt ? this._formatTime(this.resourceOverview.collectedAt) : '未知'}</span>
            <app-badge variant=${this.resourceOverview?.dataQuality === 'complete' ? 'ok' : this.resourceOverview?.dataQuality === 'partial' ? 'warn' : 'muted'}>${this.resourceOverview?.dataQuality === 'complete' ? '数据完整' : this.resourceOverview?.dataQuality === 'partial' ? '部分可用' : '无数据'}</app-badge>
            <button class="btn-ghost" @click=${() => this.loadDashboardData()}>刷新</button>
          </div>
        </div>
        ${this.moduleErrors.length ? html`<div class="dashboard-notice">${this.moduleErrors.join(' · ')}</div>` : nothing}

        <div class="dashboard__stat-cards">
          <stat-card label="纳管资源" value=${summary.total} hint=${typeCounts.map(({ type, count }) => `${this._resourceTypeLabel(type)} ${count}`).join(' · ')}></stat-card>
          <stat-card label="健康 / 在线" value=${summary.healthy} variant="ok" hint=${`占比 ${summary.total ? Math.round(summary.healthy / summary.total * 100) : 0}%`}></stat-card>
          <stat-card label="降级" value=${summary.degraded} variant="warn" hint="需要关注的资源"></stat-card>
          <stat-card label="严重 / 离线" value=${summary.critical} variant="danger" hint="优先处理"></stat-card>
          <stat-card label="活跃事件" value=${summary.activeIncidents} variant=${summary.activeIncidents ? 'warn' : 'ok'} hint="未解决告警"></stat-card>
          <stat-card label="过期 / 缺失数据" value=${summary.staleOrMissing} variant=${summary.staleOrMissing ? 'warn' : 'ok'} hint="采集质量"></stat-card>
        </div>

        <div class="dashboard__primary">
          <section class="dashboard-panel">
            <div class="dashboard-panel__header"><span class="dashboard-panel__title">${icons['triangle-alert']} 当前风险</span><button class="btn-ghost" @click=${() => this._navigateTo('alerts')}>查看告警</button></div>
            ${riskItems.length ? html`<div class="status-list">${riskItems.map((item) => html`
              <div class="status-item" @click=${() => this._navigateTo(item.resource.type === 'instance' ? 'instances-db' : item.resource.type === 'server' ? 'servers' : 'network-devices')}>
                <div class="status-item__left"><div class="status-item__icon ${this._resourceStatusVariant(item)}">${icons['triangle-alert']}</div><span class="status-item__name">${this._resourceTypeLabel(item.resource.type)} · ${item.label}</span></div>
                <span class="status-item__time">${item.unresolvedAlerts ? `${item.unresolvedAlerts} 个告警` : item.status}</span>
              </div>` )}</div>` : html`<app-empty-state title="暂无高风险资源" description="当前纳管资源没有需要立即处理的风险"><div slot="icon">${icons['check-circle']}</div></app-empty-state>`}
          </section>
          <section class="dashboard-panel">
            <div class="dashboard-panel__header"><span class="dashboard-panel__title">资源健康分布</span><span class="dashboard-meta">${this._scopeLabel(this.resourceScope)}</span></div>
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
          <div class="dashboard-panel__header"><span class="dashboard-panel__title">统一指标快照</span><span class="dashboard-meta">最新可用观测</span></div>
          ${this._resourceMetricRows().length ? html`<div class="metric-list">${this._resourceMetricRows().map((metric) => html`<div class="metric-row"><div><span class="metric-row__label">${metric.label}</span><span class="metric-row__coverage">${metric.coverage}</span></div><span class="metric-row__value">${metric.value}</span></div>`)}</div>` : html`<app-empty-state title="暂无统一指标" description="请确认对应资源已启用采集"></app-empty-state>`}
        </section>

        ${this.resourceScope === 'all' || this.resourceScope === 'instance' ? html`<div class="dashboard__charts">
          <!-- DB Type Distribution Pie Chart -->
          <div class="chart-card">
            <div class="chart-card__header">
              <span class="chart-card__title">${icons['database']} 数据库类型分布</span><span class="dashboard-meta">数据库专属</span>
            </div>
            ${this.dbTypeDistribution.length > 0
              ? html`<div class="chart-container pie-chart-container"></div>`
              : html`<div class="chart-empty-state">暂无数据库实例</div>`
            }
          </div>

          <!-- Data Volume Trend Line Chart -->
          <div class="chart-card">
            <div class="chart-card__header">
              <span class="chart-card__title">${icons['bar-chart']} 数据容量趋势</span>
              <div class="chart-card__controls">
                <select class="instance-select" @change=${this._onInstanceChange}>
                  <option value="">全库汇总</option>
                  ${this._instanceOptions}
                </select>
                <button class="time-btn ${this.selectedHours === 24 ? 'active' : ''}" @click=${() => this.reloadTrend({ hours: 24, instanceId: this.selectedInstanceId })}>24h</button>
                <button class="time-btn ${this.selectedHours === 168 ? 'active' : ''}" @click=${() => this.reloadTrend({ hours: 168, instanceId: this.selectedInstanceId })}>7d</button>
                <button class="time-btn ${this.selectedHours === 720 ? 'active' : ''}" @click=${() => this.reloadTrend({ hours: 720, instanceId: this.selectedInstanceId })}>30d</button>
                <div class="date-picker-group">
                  <input type="date" class="date-picker" .value=${this.startDate} @change=${this._onStartDateChange}>
                  <span class="date-separator">至</span>
                  <input type="date" class="date-picker" .value=${this.endDate} @change=${this._onEndDateChange}>
                </div>
              </div>
            </div>
            ${this.capacityTrend && this.capacityTrend.trend.length > 0
              ? html`
                  <div class="chart-current-total">当前总量 <span class="total-badge">${this._formatBytes(this.capacityTrend.current_total_gb)}</span></div>
                  <div class="chart-container trend-chart-container"></div>
                `
              : html`<div class="chart-empty-state">暂无容量数据，请确保监控采集已启用</div>`
            }
          </div>
        </div>` : nothing}

        ${this._renderResourceOverview()}
      </div>
    `;
  }
}

if (!customElements.get("dashboard-page")) {
  customElements.define("dashboard-page", DashboardPage);
}
