import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { icons } from "../../../icons.js";
import "./app-card.js";
import "./app-badge.js";
import "./metric-chart.js";

interface InstanceDetail {
  id: number;
  name: string;
  db_type: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  environment: string;
  description: string;
  health_status: "healthy" | "warning" | "critical" | "unknown";
  health_score: number;
  status: string;
  created_at: string;
}

interface MetricsData {
  qps: number;
  tps: number;
  connections: number;
  version?: string;
  sga_size_mb?: number;
  pga_size_mb?: number;
  tablespace_usage_percent?: number;
  metrics_data?: Record<string, number>;
  [key: string]: any;
}

interface MetricDef {
  id: string;
  name: string;
  description: string;
  unit: string;
  is_collected: boolean;
  category?: string;
  threshold_template?: Record<string, number | string>;
  higher_is_worse?: boolean;
}

@customElement("instance-overview-tab")
export class InstanceOverviewTab extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: Object }) instance: InstanceDetail | null = null;
  @property({ type: Object }) metrics: MetricsData | null = null;
  @property({ type: Array }) metricRegistry: MetricDef[] = [];
  @property({ type: Object }) overviewHistory: { time: string[]; metrics: Record<string, number[]> } | null = null;
  @property({ type: Object }) metricsHistory: Record<string, number[]> = {};

  static styles = css`
    /* Hero KPIs */
    .hero-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-lg);
      margin-bottom: var(--space-lg);
    }
    .hero-stat {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-xl);
      text-align: center;
    }
    .hero-stat__value {
      font-size: 28px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.1;
      margin-bottom: 4px;
    }
    .hero-stat__label {
      font-size: var(--text-sm);
      color: var(--muted);
      font-weight: 500;
    }
    /* Instance Info */
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-md);
    }
    .overview-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: var(--space-md) var(--space-lg);
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
    }
    .overview-label {
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 600;
    }
    .overview-value {
      font-size: var(--text-md);
      font-weight: 600;
      color: var(--text-strong);
    }
    .overview-value svg { width: 14px; height: 14px; vertical-align: -1px; }
    .overview-value.ok { color: var(--ok); }
    .overview-value.warn { color: var(--warn); }
    .overview-value.danger { color: var(--danger); }
    /* Mini charts row */
    .mini-charts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-md);
      margin-top: var(--space-lg);
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-md);
    }
    .stat-box {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-lg);
      text-align: center;
    }
    .stat-value {
      font-size: 22px;
      font-weight: 700;
      line-height: 1.15;
      margin-bottom: 2px;
    }
    .stat-label {
      font-size: 11px;
      color: var(--muted);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .stat-label-wrapper {
      position: relative;
      display: inline-block;
    }
    .stat-label-wrapper .metric-tooltip {
      display: none;
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      background: var(--card-bg, #1e1e2e);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: var(--space-sm) var(--space-md);
      font-size: var(--text-sm);
      max-width: 250px;
      z-index: 100;
      white-space: normal;
      text-align: left;
      color: var(--text, #cdd6f4);
      pointer-events: none;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .stat-label-wrapper .metric-tooltip::after {
      content: "";
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 5px solid transparent;
      border-top-color: var(--border);
    }
    .stat-label-wrapper:hover .metric-tooltip,
    .stat-label-wrapper:focus-within .metric-tooltip { display: block; }
    .metric-tooltip-desc { display: block; margin-bottom: var(--space-xs); }
    .metric-tooltip-unit { display: block; font-size: var(--text-xs); opacity: 0.7; }
    .loading { display: flex; align-items: center; justify-content: center; min-height: 300px; color: var(--muted); }
    .loading-pulse { animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      width: 18px; height: 18px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
  `;

  private _getChartColor(metricId: string): string {
    const palette = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#409eff', '#ec4899', '#14b8a6', '#f97316'];
    let hash = 0;
    for (let i = 0; i < metricId.length; i++) {
      hash = ((hash << 5) - hash) + metricId.charCodeAt(i);
      hash |= 0;
    }
    return palette[Math.abs(hash) % palette.length];
  }

  private _getMetricDef(metricKey: string): MetricDef | undefined {
    const key = metricKey.toLowerCase().replace(/[-\s]+/g, "_");
    return this.metricRegistry.find(
      (d) => d.id.toLowerCase().replace(/[-\s]+/g, "_") === key ||
             d.name.toLowerCase().replace(/[-\s]+/g, "_") === key,
    );
  }

  private _renderStatBox(value: number | string, color: string, label: string, metricId?: string) {
    const def = metricId ? this.metricRegistry.find(
      (d) => d.id.toLowerCase() === metricId.toLowerCase(),
    ) : this._getMetricDef(label);
    const tooltipContent = def
      ? html`<span class="metric-tooltip-desc">${def.description}</span><span class="metric-tooltip-unit">unit: ${def.unit}</span>`
      : null;
    return html`
      <div class="stat-box">
        <div class="stat-value" style="color: ${color};">${value}</div>
        <div class="stat-label-wrapper" tabindex="0" role="button" aria-label="查看 ${label} 指标详情">
          <span class="stat-label">${label}</span>
          ${tooltipContent ? html`<div class="metric-tooltip">${tooltipContent}</div>` : ""}
        </div>
      </div>
    `;
  }

  override render() {
    const inst = this.instance;
    if (!inst) {
      return html`<div class="loading loading-pulse">加载中...</div>`;
    }

    const envLabels: Record<string, string> = {
      development: "开发环境", testing: "测试环境",
      staging: "预发布环境", production: "生产环境",
    };

    return html`
      <!-- Hero KPIs -->
      ${this.metrics ? html`
        <div class="hero-stats">
          <div class="hero-stat">
            <div class="hero-stat__value" style="color: var(--info);">${(this.metrics.qps ?? 0).toLocaleString()}</div>
            <div class="hero-stat__label">QPS · 每秒查询</div>
          </div>
          <div class="hero-stat">
            <div class="hero-stat__value" style="color: var(--warn);">${(this.metrics.tps ?? 0).toLocaleString()}</div>
            <div class="hero-stat__label">TPS · 每秒事务</div>
          </div>
          <div class="hero-stat">
            <div class="hero-stat__value" style="color: var(--ok);">${(this.metrics.connections ?? 0).toLocaleString()}</div>
            <div class="hero-stat__label">活跃连接</div>
          </div>
        </div>
      ` : ''}

      <!-- Instance Info -->
      <app-card>
        <span slot="header">${icons['database']} 实例信息</span>
        <div class="overview-grid">
          <div class="overview-item">
            <span class="overview-label">数据库类型</span>
            <span class="overview-value">${inst.db_type.toUpperCase()}</span>
          </div>
          <div class="overview-item">
            <span class="overview-label">主机地址</span>
            <span class="overview-value">${inst.host}:${inst.port}</span>
          </div>
          <div class="overview-item">
            <span class="overview-label">数据库名</span>
            <span class="overview-value">${inst.database_name || "—"}</span>
          </div>
          <div class="overview-item">
            <span class="overview-label">环境</span>
            <span class="overview-value">${envLabels[inst.environment || "development"] || inst.environment}</span>
          </div>
          <div class="overview-item">
            <span class="overview-label">用户名</span>
            <span class="overview-value">${inst.username || "—"}</span>
          </div>
          <div class="overview-item">
            <span class="overview-label">健康评分</span>
            <span class="overview-value ${inst.health_score >= 80 ? "ok" : inst.health_score >= 60 ? "warn" : "danger"}">
              ${inst.health_score} / 100
            </span>
          </div>
          <div class="overview-item">
            <span class="overview-label">运行状态</span>
            <span class="overview-value">${inst.status === "active" ? html`${icons['check-circle']} 活跃` : html`${icons['pause']} 停用`}</span>
          </div>
          <div class="overview-item">
            <span class="overview-label">创建时间</span>
            <span class="overview-value">${new Date(inst.created_at).toLocaleDateString("zh-CN")}</span>
          </div>
          ${inst.db_type === 'oracle' && this.metrics ? html`
            ${this.metrics.version ? html`<div class="overview-item"><span class="overview-label">Oracle 版本</span><span class="overview-value" style="font-size:var(--text-sm)">${this.metrics.version}</span></div>` : ''}
            ${this.metrics.sga_size_mb ? html`<div class="overview-item"><span class="overview-label">SGA 大小</span><span class="overview-value">${this.metrics.sga_size_mb} MB</span></div>` : ''}
            ${this.metrics.pga_size_mb ? html`<div class="overview-item"><span class="overview-label">PGA 大小</span><span class="overview-value">${this.metrics.pga_size_mb} MB</span></div>` : ''}
            ${this.metrics.tablespace_usage_percent != null ? html`<div class="overview-item"><span class="overview-label">表空间使用率</span><span class="overview-value ${this.metrics.tablespace_usage_percent >= 90 ? 'danger' : this.metrics.tablespace_usage_percent >= 80 ? 'warn' : 'ok'}">${(this.metrics.tablespace_usage_percent ?? 0).toFixed(1)}%</span></div>` : ''}
          ` : ''}
        </div>
        ${inst.description ? html`
          <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
            <span class="overview-label">描述</span>
            <p style="margin:6px 0 0;font-size:var(--text-sm);color:var(--text);line-height:1.6;">${inst.description}</p>
          </div>` : ""}
      </app-card>

      <!-- Mini time-series charts -->
      ${this.overviewHistory && this.overviewHistory.time.length > 0 ? html`
        <div class="mini-charts">
          ${this.metricRegistry.filter(d => d.is_collected).slice(0, 4).map(def => {
            const data = this.overviewHistory!.metrics[def.id];
            if (!data || data.length === 0) return nothing;
            return html`
              <metric-chart compact title="${def.name} (近24h)"
                height="120px"
                .timeData=${this.overviewHistory!.time}
                .series=${[{ name: def.name, data, color: this._getChartColor(def.id) }]}
              ></metric-chart>
            `;
          })}
        </div>
      ` : nothing}
    `;
  }
}

if (!customElements.get("instance-overview-tab")) {
  customElements.define("instance-overview-tab", InstanceOverviewTab);
}
