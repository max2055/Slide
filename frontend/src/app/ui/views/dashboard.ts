import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import "../components/app-card.js";
import "../components/app-badge.js";
import "../components/app-empty-state.js";
import * as echarts from "echarts";
import { icons } from "../../../icons.js";
import "../../../components/stat-card.js";
import { authFetch } from "../../../api/index.js";
import { showToast } from "../components/app-toast-container.js";

interface InstanceSummary {
  total: number;
  healthy: number;
  warning: number;
  critical: number;
}

interface AlertSummary {
  total: number;
  unread: number;
  critical: number;
  warning: number;
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
    }

    @media (max-width: 480px) {
      .dashboard__stat-cards,
      .dashboard__charts {
        grid-template-columns: 1fr;
      }
    }
  `;

  @state() private instanceSummary: InstanceSummary | null = null;
  @state() private alertSummary: AlertSummary | null = null;
  @state() private metricsSummary: { connections: number; qps: number } | null = null;
  @state() private dbTypeDistribution: Array<{ name: string; value: number }> = [];
  @state() private capacityTrend: { current_total_gb: number; trend: Array<{ time: string; total_size_gb: number }> } | null = null;
  @state() private aiStats: { today_total: number; breakdown: Record<string, number> } | null = null;
  @state() private recentAlerts: Array<{ id: number; title: string; severity: string; created_at: string }> = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private selectedHours = 168;
  @state() private selectedInstanceId: number | null = null;
  @state() private instances: Array<{ id: number; name: string; db_type: string; health_status?: string | null }> = [];
  @state() private startDate = '';
  @state() private endDate = '';
  @state() private trendLoading = false;

  // ECharts instances for lifecycle management
  private _pieChart: echarts.ECharts | null = null;
  private _pieRO: ResizeObserver | null = null;
  private _trendChart: echarts.ECharts | null = null;
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
    try {
      const [instancesRes, alertsRes, capacityRes, aiRes] = await Promise.all([
        authFetch("/api/database/instances"),
        authFetch("/api/alerts"),
        authFetch(`/api/dashboard/capacity-trend?hours=${this.selectedHours}`),
        authFetch("/api/dashboard/ai-stats"),
      ]);

      if (!instancesRes.ok) throw new Error("加载实例数据失败");
      if (!alertsRes.ok) throw new Error("加载告警数据失败");
      if (!capacityRes.ok) throw new Error("加载容量趋势失败");
      if (!aiRes.ok) throw new Error("加载 AI 分析数据失败");

      const instances: Array<{ id: number; name: string; db_type: string; health_status: string | null; last_health_check_at: string | null }> = await instancesRes.json();
      const alertsData = await alertsRes.json();
      const alerts = alertsData.items ?? alertsData;
      const capacityData = await capacityRes.json();
      const aiData = await aiRes.json();

      // --- Health status computation ---
      const healthy = instances.filter((i: any) => i.health_status === "healthy").length;
      const warningCount = instances.filter((i: any) => i.health_status === "warning").length;
      const critical = instances.filter((i: any) => i.health_status === "critical" || i.health_status === "unknown").length;

      this.instanceSummary = { total: instances.length, healthy, warning: warningCount, critical };
      this.instances = instances;

      // --- DB type distribution (DASH-01 / D-02) ---
      const typeMap: Record<string, number> = {};
      for (const inst of instances) {
        const t = inst.db_type || "unknown";
        typeMap[t] = (typeMap[t] || 0) + 1;
      }
      this.dbTypeDistribution = Object.entries(typeMap).map(([name, value]) => ({ name, value }));

      // --- Alerts ---
      const totalAlerts = alerts.length;
      const unreadAlerts = alerts.filter((a: any) => !a.acknowledged);
      const unread = unreadAlerts.length;
      const criticalAlerts = unreadAlerts.filter((a: any) => a.severity === "critical").length;
      const warningAlerts = unreadAlerts.filter((a: any) => a.severity === "warning").length;
      this.alertSummary = { total: totalAlerts, unread, critical: criticalAlerts, warning: warningAlerts };
      this.recentAlerts = alerts
        .filter((a: any) => !a.acknowledged)
        .slice(0, 3)
        .map((a: any) => ({ id: a.id, title: a.title, severity: a.severity, created_at: a.created_at }));

      // --- Capacity trend (DASH-02) ---
      this.capacityTrend = capacityData;

      // --- AI stats ---
      this.aiStats = aiData;

      // Mark loading complete before async metrics fetch so Lit renders charts
      // (dbTypeDistribution/capacityTrend changes must reach updated() while
      // the chart containers exist in DOM, not while the loading spinner shows)
      this.loading = false;

      // --- Metrics summary: sum connections and QPS across healthy instances ---
      const healthyInstances = instances.filter((i: any) => i.health_status === "healthy");
      let totalConnections = 0;
      let totalQps = 0;
      try {
        const results = await Promise.allSettled(
          healthyInstances.map((i: any) => authFetch(`/api/database/instances/${i.id}/metrics`))
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.ok) {
            const m = await r.value.json();
            if (m && !m.error) {
              totalConnections += m.connections || 0;
              totalQps += m.qps || 0;
            }
          }
        }
      } catch (_) {}
      this.metricsSummary = { connections: totalConnections, qps: totalQps };
    } catch (err: any) {
      this.error = err.message;
      this.loading = false;
    }
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

  private _formatBytes(gb: number): string {
    if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
    return `${gb.toFixed(1)} GB`;
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
      return html`<div class="loading" style="color: var(--danger);">${this.error}</div>`;
    }

    return html`
      <div class="dashboard-grid">
        <!-- Row 1: Stat Cards -->
        <div class="dashboard__stat-cards">
          <stat-card
            label="数据库实例"
            value="${this.instanceSummary?.total ?? 0}"
            .hint=${html`
              <span style="display:flex;align-items:center;gap:4px;white-space:nowrap">
                <span class="dot ok"></span>${this.instanceSummary?.healthy ?? 0} 健康
                <span class="dot warn"></span>${this.instanceSummary?.warning ?? 0} 警告
                <span class="dot danger"></span>${this.instanceSummary?.critical ?? 0} 异常
              </span>
            `}
          ></stat-card>
          <stat-card
            label="数据总量"
            value="${this.capacityTrend ? this._formatBytes(this.capacityTrend.current_total_gb) : '--'}"
            hint="${this.capacityTrend ? `趋势图中 ${this.selectedHours / 24} 天数据` : '暂无数据'}"
          ></stat-card>
          <stat-card
            label="活动会话数"
            value="${this.metricsSummary?.connections ?? 0}"
            hint="已连接实例实时汇总"
          ></stat-card>
          <stat-card
            label="每秒查询数"
            value="${this.metricsSummary?.qps ?? 0}"
            hint="QPS · 过去 1 分钟"
          ></stat-card>
          <stat-card
            label="活跃告警"
            value="${this.alertSummary?.unread ?? 0}"
            hint="严重 ${this.alertSummary?.critical ?? 0} · 警告 ${this.alertSummary?.warning ?? 0}"
          ></stat-card>
          <stat-card
            label="AI 分析总数"
            value="${this.aiStats?.today_total ?? 0}"
            hint="今日汇总 · RCA/SQL 审核等"
          ></stat-card>
        </div>

        <!-- Row 2: Charts -->
        <div class="dashboard__charts">
          <!-- DB Type Distribution Pie Chart -->
          <div class="chart-card">
            <div class="chart-card__header">
              <span class="chart-card__title">${icons['database']} 数据库类型分布</span>
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
        </div>

        <!-- Row 3: Alert Panel -->
        <div class="dashboard__panels">
          <app-card variant="default">
            <div slot="header">
              <span class="chart-card__title">${icons['triangle-alert']} 待处理告警</span>
              <span style="font-size:var(--text-sm);color:var(--accent);cursor:pointer;" @click=${() => this._navigateTo("alerts")}>查看全部 →</span>
            </div>
            ${this.recentAlerts.length > 0
              ? html`
                  <div class="status-list">
                    ${this.recentAlerts.map(alert => html`
                      <div class="status-item" @click=${() => this._navigateTo("alerts")}>
                        <div class="status-item__left">
                          <div class="status-item__icon ${alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warn' : 'ok'}">
                            ${alert.severity === 'critical' ? icons['alert-circle'] : alert.severity === 'warning' ? icons['triangle-alert'] : icons['info']}
                          </div>
                          <span class="status-item__name">${alert.title}</span>
                        </div>
                        <span class="status-item__time">${this._formatTime(alert.created_at)}</span>
                      </div>
                    `)}
                  </div>
                `
              : html`
                  <app-empty-state title="暂无未处理告警" description="系统运行正常">
                    <div slot="icon">${icons['check-circle']}</div>
                  </app-empty-state>
                `
            }
          </app-card>

        </div>
      </div>
    `;
  }
}

if (!customElements.get("dashboard-page")) {
  customElements.define("dashboard-page", DashboardPage);
}
