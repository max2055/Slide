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
import type { EChartsOption, EChartsType } from "echarts";
import { formatMetricTime, isMetricTimestamp } from './metric-time.js';

export interface MetricSeries {
  name: string;
  data: Array<number | null>;
  color?: string;
  /** Optional bucket envelope; shown as dashed bounds so an in-bucket spike survives downsampling. */
  min?: Array<number | null>;
  max?: Array<number | null>;
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
    .chart-timezone { margin:0; padding:var(--space-sm) var(--space-md); color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
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
  private _chart: EChartsType | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _rafId: number | null = null;
  private _themeObserver: MutationObserver | null = null;

  override connectedCallback() {
    super.connectedCallback();
    // Canvas colors do not inherit CSS updates when the user switches themes.
    this._themeObserver = new MutationObserver(() => this._updateChart());
    this._themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme-mode", "style"],
    });
    // Re-initialize when component is re-inserted into DOM (e.g. tab switch)
    // Only if _chartContainer exists (set in firstUpdated)
    if (this._chartContainer && !this._chart && this.timeData.length > 0 && this.series.length > 0) {
      this._initChart();
    }
    // If chart exists but was initialized at 0 size (hidden tab), force resize
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
    // Update chart when data changes
    if (changedProperties.has("timeData") || changedProperties.has("series") || changedProperties.has("thresholds")) {
      if (this._chart) {
        this._updateChart();
        this._chart.resize();
      }
    }
    if (changedProperties.has("height")) {
      this._applyHeight();
      if (this._chart) this._chart.resize();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._themeObserver?.disconnect();
    this._themeObserver = null;
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

    // Always create chart immediately. ECharts handles 0-size containers,
    // and ResizeObserver will trigger resize() when container becomes visible.
    this._chart = echarts.init(this._chartContainer, undefined, {
      renderer: "canvas",
    });

    this._setupResizeObserver();
    this._updateChart();

    // Force resize after layout completes — fixes blank charts when component
    // is rendered during tab switch before container has final dimensions.
    requestAnimationFrame(() => {
      if (this._chart) this._chart.resize();
    });
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

  private _resolveColor(value: string): number[] | undefined {
    // Let the browser resolve variables (including nested fallbacks) in this
    // component's theme scope before handing colors to the canvas renderer.
    const probe = document.createElement('span');
    probe.style.color = value;
    if (!probe.style.color) return undefined;
    probe.hidden = true;
    this.shadowRoot!.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    const rgba = echarts.color.parse(resolved);
    if (rgba) return rgba;
    // Modern CSS colors such as oklch are supported by canvas but not by
    // ECharts' color parser. Normalize those through a single sRGB pixel.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.fillStyle = resolved;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
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
      const style = getComputedStyle(this);
      const text = style.getPropertyValue("--text").trim();
      const muted = style.getPropertyValue("--muted").trim();
      const border = style.getPropertyValue("--border").trim();

      const seriesOptions: Record<string, unknown>[] = [];
      this.series.forEach((s, index) => {
        const rgba = s.color ? this._resolveColor(s.color) : undefined;
        const color = (opacity: number) => rgba
          ? `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] * opacity})`
          : undefined;
        const base: Record<string, unknown> = {
          name: s.name,
          type: "line" as const,
          data: s.data,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2 },
          itemStyle: rgba ? { color: color(1) } : undefined,
          areaStyle: rgba
            ? {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: color(64 / 255)! },
                  { offset: 1, color: color(5 / 255)! },
                ]),
              }
            : undefined,
        };

        // Add markLine threshold lines only to the first series
        if (hasThresholds && index === 0) {
          base.markLine = {
            silent: true,
            data: this.thresholds.map((t) => {
              const rgba = this._resolveColor(t.color);
              const color = rgba ? `rgba(${rgba.join(',')})` : undefined;
              return {
                yAxis: t.value,
                name: t.name,
                lineStyle: {
                  color,
                  type: "dashed" as const,
                  width: 1,
                },
                label: {
                  formatter: `{name}: ${t.value}`,
                  position: "end" as const,
                  color,
                },
              };
            }),
          };
        }

        seriesOptions.push(base);
        // The envelope keeps the bucket's own minimum/maximum visible without pretending
        // they are another measurement series.
        if (s.min) seriesOptions.push({ name: `${s.name} · 下限`, type: "line" as const, data: s.min, smooth: true, showSymbol: false,
          lineStyle: { width: 1, type: "dashed" as const, opacity: 0.7 }, itemStyle: rgba ? { color: color(0.7) } : undefined, z: 1 });
        if (s.max) seriesOptions.push({ name: `${s.name} · 上限`, type: "line" as const, data: s.max, smooth: true, showSymbol: false,
          lineStyle: { width: 1, type: "dashed" as const, opacity: 0.7 }, itemStyle: rgba ? { color: color(0.7) } : undefined, z: 1 });
      });

      const option: EChartsOption = {
        tooltip: {
          trigger: "axis",
          backgroundColor: style.getPropertyValue("--popover").trim(),
          borderColor: border,
          textStyle: { color: text, fontSize: 12 },
          axisPointer: {
            type: "line",
            lineStyle: { color: muted, type: "dashed" },
          },
        },
        legend: {
          data: seriesOptions.map((s) => s.name as string),
          top: 0,
          right: 10,
          textStyle: { color: text, fontSize: 12 },
          itemWidth: 12,
          itemHeight: 8,
        },
        grid: {
          left: 50,
          right: 20,
          top: seriesOptions.length > 1 ? 36 : 10,
          bottom: 30,
        },
        xAxis: {
          type: "category",
          data: this.timeData,
          boundaryGap: false,
          axisLine: { lineStyle: { color: border } },
          axisLabel: {
            color: muted,
            fontSize: 11,
            interval: 'auto',
            rotate: 0,
            hideOverlap: true,
            formatter: (val: string) => {
              const first = this.timeData[0], last = this.timeData.at(-1)!;
              const spansDays = isMetricTimestamp(first) && isMetricTimestamp(last)
                && new Date(first).toLocaleDateString() !== new Date(last).toLocaleDateString();
              return formatMetricTime(val, spansDays);
            },
          },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          name: this.yAxisLabel || undefined,
          nameTextStyle: { color: muted },
          min: this.percentage ? 0 : undefined,
          max: this.percentage ? this.yAxisMax : undefined,
          axisLabel: {
            color: muted,
            fontSize: 11,
            formatter: this.percentage ? "{value}%" : "{value}",
          },
          splitLine: { lineStyle: { color: border, type: "dashed" } },
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
      ${this.timeData.some(isMetricTimestamp) ? html`<p class="chart-timezone">本地时间（${Intl.DateTimeFormat().resolvedOptions().timeZone}）；悬停查看完整原始时间及其时区。</p>` : ''}
      <div
        class="chart-container"
        style="height: ${this.height}"
      ></div>
    `;
  }
}
