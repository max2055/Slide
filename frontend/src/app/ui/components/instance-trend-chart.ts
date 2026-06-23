import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { icons } from "../../../icons.js";
import "./metric-chart.js";
import "./app-card.js";

interface MetricDef {
  id: string;
  name: string;
  description: string;
  unit: string;
  is_collected: boolean;
  threshold_template?: Record<string, number | string>;
  higher_is_worse?: boolean;
}

interface ThresholdConfig {
  name: string;
  value: number;
  color: string;
}

@customElement("instance-trend-chart")
export class InstanceTrendChart extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: Object }) trendData: { time: string[]; metrics: Record<string, number[]> } | null = null;
  @property({ type: Boolean }) loading = false;
  @property() activePeriod = "1h";
  @property({ type: Array }) metricRegistry: MetricDef[] = [];

  // Light DOM: static styles via adoptedStyleSheets does not work on plain
  // elements, so inject styles inline in render() instead.
  private static stylesText = `
    .trend-period-btn {
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
    .trend-period-btn:hover {
      color: var(--text);
      border-color: var(--border-strong);
    }
    .trend-period-btn.active {
      color: var(--accent);
      border-color: var(--accent);
      background: var(--accent-subtle);
    }
    .trend-period-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .loading { display: flex; align-items: center; justify-content: center; min-height: 200px; color: var(--muted); }
    .loading-pulse { animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .chart-wrap { margin-bottom: 16px; }
  `;

  private _dispatchPeriodChange(period: string) {
    this.dispatchEvent(new CustomEvent("period-change", {
      detail: { period },
      bubbles: true,
      composed: true,
    }));
  }

  private _getChartColor(metricId: string): string {
    const palette = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#409eff', '#ec4899', '#14b8a6', '#f97316'];
    let hash = 0;
    for (let i = 0; i < metricId.length; i++) {
      hash = ((hash << 5) - hash) + metricId.charCodeAt(i);
      hash |= 0;
    }
    return palette[Math.abs(hash) % palette.length];
  }

  private _parseThresholdValue(expr: number | string): number | null {
    if (typeof expr === "number") return expr;
    const match = expr.match(/^\s*[><=!]*\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (!match) return null;
    return parseFloat(match[1]);
  }

  private _buildThresholds(metricId: string): ThresholdConfig[] {
    const def = this.metricRegistry.find(
      (d) => d.id.toLowerCase().replace(/[-\s]+/g, "_") === metricId.toLowerCase().replace(/[-\s]+/g, "_"),
    );
    if (!def?.threshold_template) return [];

    const colorMap: Record<string, string> = { warning: "var(--warn)", error: "var(--danger)", critical: "var(--danger)" };
    const result: ThresholdConfig[] = [];
    for (const [level, expr] of Object.entries(def.threshold_template)) {
      const value = this._parseThresholdValue(expr);
      if (value !== null) {
        result.push({ name: level, value, color: colorMap[level] || "var(--muted)" });
      }
    }
    return result;
  }

  override render() {
    const periods = [
      { key: "1h", label: "1小时" },
      { key: "6h", label: "6小时" },
      { key: "24h", label: "24小时" },
      { key: "7d", label: "7天" },
    ];

    const collected = this.metricRegistry.filter(d => d.is_collected);

    return html`
      <style>${InstanceTrendChart.stylesText}</style>
      <app-card>
        <span slot="header">${icons['trending-up']} 指标趋势</span>
        <div style="display:flex;justify-content:flex-end;gap:var(--space-xs);margin-bottom:var(--space-md);">
          ${periods.map(p => html`
            <button class="trend-period-btn ${this.activePeriod === p.key ? 'active' : ''}"
              @click=${() => this._dispatchPeriodChange(p.key)}
              ?disabled=${this.loading}>${p.label}</button>
          `)}
        </div>
        ${this.loading
          ? html`<div class="loading loading-pulse">加载趋势数据...</div>`
          : !this.trendData || this.trendData.time.length === 0
            ? html`<div style="text-align:center;padding:40px;color:var(--muted);">
                <div style="font-size:var(--text-lg);font-weight:600;color:var(--text-strong);margin-bottom:var(--space-sm);">暂无趋势数据</div>
                <div style="font-size:var(--text-md);">当前时间范围内没有采集到指标数据</div>
              </div>`
            : collected.map(def => {
                const data = this.trendData!.metrics[def.id];
                if (!data || data.length === 0) {
                  return html`
                    <div style="margin-bottom:var(--space-md);border:1px solid var(--border);border-radius:var(--radius-lg);text-align:center;padding:20px;color:var(--muted);">
                      <div style="font-weight:600;">${def.name} — 暂无趋势数据</div>
                    </div>`;
                }
                return html`
                  <div class="chart-wrap">
                    <metric-chart
                      title="${def.name} (${def.unit})"
                      .timeData=${this.trendData!.time}
                      .series=${[{ name: def.name, data, color: this._getChartColor(def.id) }]}
                      .thresholds=${this._buildThresholds(def.id)}
                      .percentage=${def.unit === '%'}
                      height="280px"
                      yAxisLabel=${def.unit}
                    ></metric-chart>
                  </div>`;
              })}
      </app-card>
    `;
  }
}

if (!customElements.get("instance-trend-chart")) {
  customElements.define("instance-trend-chart", InstanceTrendChart);
}
