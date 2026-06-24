/**
 * 可复用 ECharts 指标趋势图组件
 *
 * Usage:
 *   <metric-chart
 *     title="CPU/内存使用率"
 *     .timeData=${['14:00', '14:05', '14:10']}
 *     .series=${[{ name: 'CPU', data: [45, 52, 38] }, { name: '内存', data: [60, 62, 65] }]}
 *     percentage
 *     height="280px"
 *   ></metric-chart>
 */
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import * as echarts from "echarts";

export interface MetricSeries {
  name: string;
  data: number[];
  color?: string;
}

export interface ThresholdConfig {
  name: string;
  value: number;
  color: string;
}

@customElement("metric-chart")
export class MetricChart extends LitElement {
  static override styles = css`
    :host {
      display: block;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
    }

    .chart-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-elevated);
    }

    .chart-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-strong);
    }

    .chart-container {
      width: 100%;
    }

    .chart-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 200px;
      color: var(--muted);
      font-size: 13px;
    }
    :host([compact]) .chart-header {
      padding: 8px 12px;
    }
    :host([compact]) .chart-title {
      font-size: 12px;
      font-weight: 600;
    }
    :host([compact]) .chart-container {
      padding: 4px 8px 8px;
    }
  `;

  @property({ type: Array }) timeData: string[] = [];
  @property({ type: Array }) series: MetricSeries[] = [];
  @property({ type: Array }) thresholds: ThresholdConfig[] = [];
  @property({ type: String }) title = "";
  @property({ type: String }) height = "280px";
  @property({ type: String }) yAxisLabel = "";
  @property({ type: Number }) yAxisMax = 100;
  @property({ type: Boolean }) percentage = false;
  @property({ type: Boolean }) compact = false;

  private _chartContainer: HTMLDivElement | null = null;
  private _chart: echarts.ECharts | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _rafId: number | null = null;

  override connectedCallback() {
    super.connectedCallback();
    // Re-initialize when component is re-inserted into DOM (e.g. tab switch)
    if (this._chartContainer && !this._chart && this.timeData.length > 0 && this.series.length > 0) {
      this._initChart();
    }
    // If chart exists but was initialized at 0 size (hidden tab), force resize
    // now that we're visible again
    if (this._chart) {
      requestAnimationFrame(() => {
        if (this._chart) this._chart.resize();
      });
    }
  }

  override firstUpdated() {
    this._chartContainer = this.shadowRoot?.querySelector(".chart-container") as HTMLDivElement;
    if (this._chartContainer) {
      this._applyHeight();
      this._initChart();
    }
  }

  override updated(changedProperties: Map<string, unknown>) {
    // Re-init if container or data structure changed significantly
    if (changedProperties.has("timeData") || changedProperties.has("series") || changedProperties.has("thresholds")) {
      if (this._chart) {
        this._updateChart();
        // Force resize after data update — fixes blank chart when component
        // was initialized while hidden (e.g. inactive tab, display:none)
        this._chart.resize();
      } else if (this.timeData.length > 0 && this.series.length > 0) {
        // Chart not yet initialized (container was hidden or not yet laid out).
        // Disconnect any pending observer and re-init — _initChart will check
        // dimensions and either create immediately or set up a new observer.
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        this._initChart();
      }
    }
    if (changedProperties.has("height")) {
      this._applyHeight();
      if (this._chart) this._chart.resize();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._chart?.dispose();
    this._chart = null;
  }

  private _initChart() {
    if (!this._chartContainer) return;

    const rect = this._chartContainer.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      // Container is hidden or not yet laid out.
      // Use ResizeObserver to wait for actual visibility — more reliable
      // than requestAnimationFrame which may fire before layout recalculates.
      if (this._resizeObserver) return; // already waiting

      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
            observer.disconnect();
            this._resizeObserver = null;
            if (!this.isConnected) return;
            this._chart = echarts.init(this._chartContainer, undefined, {
              renderer: "canvas",
            });
            this._setupResizeObserver();
            this._updateChart();
            break;
          }
        }
      });
      this._resizeObserver = observer;
      observer.observe(this._chartContainer);
      return;
    }

    this._chart = echarts.init(this._chartContainer, undefined, {
      renderer: "canvas",
    });

    this._setupResizeObserver();
    this._updateChart();
  }

  private _setupResizeObserver() {
    if (!this._chartContainer || !this._chart) return;

    this._resizeObserver = new ResizeObserver(() => {
      if (this._chart) {
        this._chart.resize();
      }
    });
    this._resizeObserver.observe(this._chartContainer);
  }

  private _updateChart() {
    if (!this._chart) return;

    // Debounce via requestAnimationFrame
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
    }
    this._rafId = requestAnimationFrame(() => {
      if (!this._chart) return;

      const hasData = this.timeData.length > 0 && this.series.length > 0;

      if (!hasData) {
        this._chart.clear();
        return;
      }

      const hasThresholds = this.thresholds && this.thresholds.length > 0;

      const seriesOptions = this.series.map((s, index) => {
        const base: Record<string, unknown> = {
          name: s.name,
          type: "line" as const,
          data: s.data,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2 },
          itemStyle: s.color ? { color: s.color } : undefined,
          areaStyle: s.color
            ? {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: s.color + "40" },
                  { offset: 1, color: s.color + "05" },
                ]),
              }
            : undefined,
        };

        // Add markLine threshold lines only to the first series
        if (hasThresholds && index === 0) {
          base.markLine = {
            silent: true,
            data: this.thresholds.map((t) => ({
              yAxis: t.value,
              name: t.name,
              lineStyle: {
                color: t.color,
                type: "dashed" as const,
                width: 1,
              },
              label: {
                formatter: `{name}: ${t.value}`,
                position: "end" as const,
                color: t.color,
              },
            })),
          };
        }

        return base;
      });

      const option: echarts.EChartsOption = {
        tooltip: {
          trigger: "axis",
          backgroundColor: "rgba(0, 0, 0, 0.8)",
          borderColor: "#333",
          textStyle: { color: "#fff", fontSize: 12 },
          axisPointer: {
            type: "line",
            lineStyle: { color: "#666", type: "dashed" },
          },
        },
        legend: {
          data: this.series.map((s) => s.name),
          top: 0,
          right: 10,
          textStyle: { fontSize: 12 },
          itemWidth: 12,
          itemHeight: 8,
        },
        grid: {
          left: 50,
          right: 20,
          top: this.series.length > 1 ? 36 : 10,
          bottom: 30,
        },
        xAxis: {
          type: "category",
          data: this.timeData,
          boundaryGap: false,
          axisLine: { lineStyle: { color: "#ccc" } },
          axisLabel: {
            color: "#888",
            fontSize: 11,
            interval: 'auto',
            rotate: this.timeData.length > 20 ? 30 : 0,
            formatter: (val: string) => {
              // Show only time portion if present
              const parts = val.split(" ");
              return parts.length > 1 ? parts[1] : parts[0];
            },
          },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          name: this.yAxisLabel || undefined,
          min: this.percentage ? 0 : undefined,
          max: this.percentage ? this.yAxisMax : undefined,
          axisLabel: {
            color: "#888",
            fontSize: 11,
            formatter: this.percentage ? "{value}%" : "{value}",
          },
          splitLine: { lineStyle: { color: "#eee", type: "dashed" } },
          axisLine: { show: false },
        },
        series: seriesOptions,
      };

      this._chart.setOption(option, true);
    });
  }

  private _applyHeight() {
    if (this._chartContainer) {
      this._chartContainer.style.height = this.height;
    }
  }

  override render() {
    return html`
      <div class="chart-header">
        <span class="chart-title">${this.title}</span>
      </div>
      <div
        class="chart-container"
        style="height: ${this.height}"
      ></div>
    `;
  }
}
