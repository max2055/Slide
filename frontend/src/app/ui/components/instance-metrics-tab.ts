import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { icons } from "../../../icons.js";
import "./app-card.js";
import "./app-badge.js";
import "./metric-chart.js";

interface MetricDef {
  id: string;
  name: string;
  unit: string;
  is_collected: boolean;
  category?: string;
  threshold_template?: Record<string, number | string>;
  higher_is_worse?: boolean;
}

@customElement("instance-metrics-tab")
export class InstanceMetricsTab extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: Array }) metricRegistry: MetricDef[] = [];
  @property({ type: Object }) metrics: Record<string, any> | null = null;
  @property({ type: Object }) metricsHistory: Record<string, number[]> = {};

  static styles = css`
    .metrics-dashboard {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-md);
    }
    .metric-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-xl);
      overflow: hidden;
      position: relative;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .metric-card:hover {
      border-color: var(--border-strong);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
    }
    .metric-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
      background: var(--accent);
    }
    .metric-card.cat-performance::before { background: var(--info); }
    .metric-card.cat-resource::before { background: var(--warn); }
    .metric-card.cat-storage::before { background: var(--danger); }
    .metric-card.cat-availability::before { background: var(--ok); }
    .metric-card.cat-security::before { background: var(--accent); }
    .metric-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: var(--space-md);
    }
    .metric-label {
      font-size: var(--text-sm);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .metric-value-row {
      display: flex;
      align-items: baseline;
      gap: var(--space-xs);
      margin-bottom: var(--space-md);
    }
    .metric-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--text-strong);
    }
    .metric-unit {
      font-size: var(--text-base);
      color: var(--muted);
    }
    .progress-bar {
      height: 8px;
      background: var(--bg-muted);
      border-radius: var(--radius-full);
      overflow: hidden;
      margin-top: var(--space-sm);
    }
    .progress-fill {
      height: 100%;
      border-radius: var(--radius-full);
      transition: width 0.5s ease;
    }
    .progress-fill.ok { background: linear-gradient(90deg, var(--ok), #22c55e); }
    .progress-fill.warn { background: linear-gradient(90deg, var(--warn), #f59e0b); }
    .progress-fill.danger { background: linear-gradient(90deg, var(--danger), #ef4444); }
    .empty-state { text-align: center; padding: 60px var(--space-xl); }
    .empty-title { font-size: var(--text-lg); font-weight: 600; color: var(--text-strong); margin-bottom: var(--space-sm); }
    .empty-desc { font-size: var(--text-md); color: var(--muted); }
    .empty-icon svg { width: 48px; height: 48px; opacity: 0.5; }
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

  private _parseThresholdValue(expr: number | string): number | null {
    if (typeof expr === "number") return expr;
    const match = expr.match(/^\s*[><=!]*\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (!match) return null;
    return parseFloat(match[1]);
  }

  private _getMetricColor(value: number, metricDef?: MetricDef): string {
    if (!metricDef?.threshold_template) {
      return value > 80 ? 'var(--danger)' : value > 60 ? 'var(--warn)' : 'var(--text-strong)';
    }
    const tpl = metricDef.threshold_template;
    const higherIsWorse = metricDef.higher_is_worse ?? true;
    const exceeds = higherIsWorse ? (v: number, t: number) => v >= t : (v: number, t: number) => v <= t;
    if (tpl.critical != null) { const cv = this._parseThresholdValue(tpl.critical); if (cv !== null && exceeds(value, cv)) return 'var(--danger)'; }
    if (tpl.error != null) { const ev = this._parseThresholdValue(tpl.error); if (ev !== null && exceeds(value, ev)) return 'var(--danger)'; }
    if (tpl.warning != null) { const wv = this._parseThresholdValue(tpl.warning); if (wv !== null && exceeds(value, wv)) return 'var(--warn)'; }
    return 'var(--text-strong)';
  }

  private _getProgressClass(value: number, metricDef?: MetricDef): string {
    if (!metricDef?.threshold_template) {
      return value > 80 ? 'danger' : value > 60 ? 'warn' : 'ok';
    }
    const tpl = metricDef.threshold_template;
    const higherIsWorse = metricDef.higher_is_worse ?? true;
    const exceeds = higherIsWorse ? (v: number, t: number) => v >= t : (v: number, t: number) => v <= t;
    if (tpl.critical != null) { const cv = this._parseThresholdValue(tpl.critical); if (cv !== null && exceeds(value, cv)) return 'danger'; }
    if (tpl.error != null) { const ev = this._parseThresholdValue(tpl.error); if (ev !== null && exceeds(value, ev)) return 'danger'; }
    if (tpl.warning != null) { const wv = this._parseThresholdValue(tpl.warning); if (wv !== null && exceeds(value, wv)) return 'warn'; }
    return 'ok';
  }

  private _renderSparkline(data: number[], color: string) {
    if (data.length < 2) return html`<div style="height:40px"></div>`;
    return html`
      <metric-chart compact height="40px"
        .timeData=${data.map((_, i) => String(i))}
        .series=${[{ name: "", data, color }]}
      ></metric-chart>
    `;
  }

  private _renderDynamicCard(def: MetricDef) {
    const value = this.metrics?.[def.id] ?? this.metrics?.metrics_data?.[def.id];
    const chartColor = this._getChartColor(def.id);
    const catClass = def.category ? `cat-${def.category.toLowerCase().replace(/\s+/g, '-')}` : '';

    if (value == null) {
      return html`
        <div class="metric-card ${catClass}" style="opacity:0.5;">
          <div class="metric-header"><span class="metric-label">${def.name}</span></div>
          <div class="metric-value-row"><span class="metric-value" style="color:var(--muted);font-size:16px;">暂无数据</span></div>
          ${this.metricsHistory[def.id]?.length >= 2 ? this._renderSparkline(this.metricsHistory[def.id], chartColor) : html`<div style="height:40px"></div>`}
        </div>`;
    }

    const val = Number(value);
    const sparklineData = this.metricsHistory[def.id] || [];
    const isPercent = def.unit === '%';

    return html`
      <div class="metric-card ${catClass}">
        <div class="metric-header"><span class="metric-label">${def.name}</span></div>
        <div class="metric-value-row">
          <span class="metric-value" style="color:${this._getMetricColor(val, def)};">${val.toFixed(1)}</span>
          <span class="metric-unit">${def.unit}</span>
        </div>
        ${sparklineData.length >= 2 ? this._renderSparkline(sparklineData, chartColor) : html`<div style="height:40px"></div>`}
        ${isPercent ? html`
          <div class="progress-bar"><div class="progress-fill ${this._getProgressClass(val, def)}" style="width:${Math.min(val, 100)}%"></div></div>
        ` : ''}
      </div>`;
  }

  override render() {
    const collected = this.metricRegistry.filter(d => d.is_collected);

    if (!this.metrics || collected.length === 0) {
      return html`
        <app-card>
          <div class="empty-state">
            <div class="empty-icon" style="color:var(--muted);margin-bottom:var(--space-lg);">${icons['monitor']}</div>
            <div class="empty-title">暂无监控数据</div>
            <div class="empty-desc">${!this.metrics ? '实例可能未连接或暂无数据' : '暂无已采集的指标'}</div>
          </div>
        </app-card>`;
    }

    const groups = new Map<string, MetricDef[]>();
    for (const def of collected) {
      const cat = def.category || '通用';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(def);
    }

    return html`
      ${Array.from(groups.entries()).map(([category, defs]) => html`
        <app-card style="margin-bottom:var(--space-lg);">
          <span slot="header">${icons['bar-chart']} ${category}</span>
          <div class="metrics-dashboard">
            ${defs.map(def => this._renderDynamicCard(def))}
          </div>
        </app-card>
      `)}
    `;
  }
}

if (!customElements.get("instance-metrics-tab")) {
  customElements.define("instance-metrics-tab", InstanceMetricsTab);
}
