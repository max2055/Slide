import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { sharedFieldStyles } from '../../styles/shared-field-styles.js';
import { MetricRequestError, metricRequest } from './metric-api.js';
import { metricDisplayName } from './metric-display.js';
import { bucketMsFor, type MetricValue, type SemanticResult } from './semantic-metrics.js';
import type { MetricSeries } from './metric-chart.js';
import './app-badge.js';
import './app-card.js';
import './app-data-table.js';
import './app-empty-state.js';
import './metric-chart.js';
import './semantic-metrics.js';

type Dimensions = Record<string, string>;
type Window = { from: string; to: string };
type Mode = 'graph' | 'values';
type Preset = '15' | '60' | '360' | '1440' | '10080' | '129600' | 'custom';
type Sample = { observed_at: string; value: MetricValue | null; unit: string; quality: { status: string }; accuracy: string };
type Point = Sample & { dimensions: Dimensions; freshness: string };
type Latest = {
  resource: { type: string; id: number }; evaluated_at: string;
  metrics: Array<{
    definition: { id: string; semantic_version: string; meaning: string; unit: string; kind: string; value_type: string;
      dimensions?: { keys: Array<{ required: boolean }> } };
    state: string;
    series: Point[];
  }>;
};
type HistoryPage = { window: Window; observations: Sample[]; total: number; has_more: boolean; next_cursor?: string };
type Row = { key: string; metric: Latest['metrics'][number]; point?: Point; dimensions: Dimensions; name: string; graph: boolean };

const pageSize = 25;
const historyPageSize = 50;
const maxDetailDays = 31, maxChartDays = 366;
const windowDays = (mode: Mode) => mode === 'graph' ? maxChartDays : maxDetailDays;
const numeric = ['float64', 'int64', 'uint64'];
const qualityLabels: Record<string, string> = { good: '良好', partial: '部分', unknown: '未知', invalid: '无效', exact: '精确', estimated: '估算' };
const stateLabels: Record<string, string> = {
  available: '采集可用', not_covered: '当前模板未覆盖', disabled: '已停用', unsupported: '不支持',
  permission_denied: '采集权限不足', temporary_failure: '最近采集失败', capability_unknown: '能力待确认',
};
const presets = [['15', '最近 15 分钟'], ['60', '最近 1 小时'], ['360', '最近 6 小时'], ['1440', '最近 24 小时'], ['10080', '最近 7 天'], ['129600', '最近 90 天'], ['custom', '自定义']];
const timestamp = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const rolling = (minutes: number): Window => {
  const now = Date.now();
  return { from: new Date(now - minutes * 60_000).toISOString(), to: new Date(now).toISOString() };
};
const localInput = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const dimensionKey = (value: Dimensions) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const dimensionText = (value: Dimensions) => Object.entries(value).map(([key, v]) => `${key} = ${v}`).join(' · ');
const rowKey = (id: string, version: string, dimensions: Dimensions) => JSON.stringify([id, version, dimensionKey(dimensions)]);
const validWindow = ({ from, to }: Window, days: number) => {
  const start = Date.parse(from), end = Date.parse(to);
  return Number.isFinite(start) && Number.isFinite(end) && start < end && end <= Date.now() && end - start <= days * 86_400_000;
};
const normalizedWindow = ({from, to}: Window): Window => ({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
const accessDenied = (error: unknown) => error instanceof MetricRequestError && [401, 403, 404].includes(error.status);

function chartNumber(value: MetricValue | null, quality: string, sameUnit: boolean, floating: boolean): number | null {
  if (!value || !sameUnit || !['good', 'partial'].includes(quality) || !numeric.includes(value.encoding)) return null;
  const number = Number(value.value);
  return Number.isFinite(number) && (floating && value.encoding === 'float64' || Math.abs(number) <= Number.MAX_SAFE_INTEGER)
    ? number : null;
}

function displayValue(sample: Sample | undefined, full = false) {
  if (!sample?.value) return html`<span class="subtle">${sample ? '空值' : '暂无采样'}</span>`;
  const { value, unit } = sample;
  if (numeric.includes(value.encoding)) return html`<span class="number">${value.value}</span>${unit === '1' ? nothing : html` <span class="subtle">${unit}</span>`}`;
  if (typeof value.value === 'string') return full ? html`<span class="record-text">${value.value}</span>`
    : html`<span class="sample-preview" title=${value.value}>${value.value}</span>`;
  return full ? html`<details><summary>查看结构化值</summary><pre>${JSON.stringify(value, null, 2)}</pre></details>`
    : html`<span>结构化记录</span>`;
}

@customElement('resource-metric-browser')
export class ResourceMetricBrowser extends LitElement {
  @property() resourceType = 'instance';
  @property({ type: Number }) resourceId = 0;

  @state() private latest: Latest | null = null;
  @state() private listBusy = false;
  @state() private listError = '';
  @state() private search = '';
  @state() private listPage = 0;
  @state() private selection: Row | null = null;
  @state() private mode: Mode = 'graph';
  @state() private preset: Preset = '60';
  @state() private window = rolling(60);
  @state() private fromInput = '';
  @state() private toInput = '';
  @state() private rangeError = '';
  @state() private graph: SemanticResult | null = null;
  @state() private historyPage: HistoryPage | null = null;
  @state() private historyBusy = false;
  @state() private historyError = '';
  @state() private cursorStack: Array<string | undefined> = [undefined];
  @state() private advanced = false;
  private latestRequest?: AbortController;
  private historyRequest?: AbortController;
  private invalidated = false;
  private initialized = false;

  static override styles = [sharedBtnStyles, sharedFieldStyles, css`
    :host { display: block; min-width: 0; color: var(--text); }
    h2, h3, p { margin: 0; }
    h2 { font-size: var(--text-xl, 20px); color: var(--text-strong); }
    h3 { font-size: var(--text-md); }
    .heading, .toolbar, .pagination, .history-title {
      display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm) var(--space-md); flex-wrap: wrap;
    }
    .heading { align-items: start; }
    .toolbar { justify-content: start; align-items: end; }
    .heading p, .subtle { color: var(--muted); }
    .heading p { margin-top: var(--space-xs); }
    .stack { display: grid; gap: var(--space-md); min-width: 0; }
    .toolbar label { display: grid; gap: var(--space-xs); min-width: 0; }
    .toolbar input, .toolbar select {
      box-sizing: border-box; min-height: var(--control-height); min-width: 0; max-width: 100%;
      color: var(--text); background: var(--input-bg, var(--bg)); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 0 var(--space-sm); font: inherit;
    }
    .toolbar :is(input, select):focus-visible, summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
    .search { flex: 0 1 26rem; }
    .history-title { justify-content: start; }
    .history-title h2 { overflow-wrap: anywhere; }
    .name { font-weight: 600; overflow-wrap: anywhere; }
    .dimension, .status-note { display: block; margin-top: var(--space-xs); color: var(--muted); font-size: var(--text-sm); overflow-wrap: anywhere; }
    .sample-preview { display: inline-block; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
    .number, time { font-variant-numeric: tabular-nums; }
    .record-text, pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .badges, .modes { display: flex; gap: var(--space-xs); flex-wrap: wrap; }
    .modes button[aria-pressed='true'] { color: var(--accent); background: var(--accent-subtle); }
    .pagination { justify-content: end; padding-top: var(--space-sm); }
    .pagination > span { margin-right: auto; }
    .advanced { margin-top: var(--space-md); }
    summary { cursor: pointer; }
    .advanced > summary { color: var(--muted); }
    .error { color: var(--danger); overflow-wrap: anywhere; }
    .window { color: var(--muted); font-size: var(--text-sm); }
    .loading { min-height: 6rem; }
    app-data-table { --table-min-width: 700px; }
  `];

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.recheckAccess);
    window.addEventListener('slide-session-expired', this.invalidate);
    window.addEventListener('popstate', this.restoreRoute);
  }

  override disconnectedCallback() {
    window.removeEventListener('slide-permissions-loaded', this.recheckAccess);
    window.removeEventListener('slide-session-expired', this.invalidate);
    window.removeEventListener('popstate', this.restoreRoute);
    this.latestRequest?.abort();
    this.historyRequest?.abort();
    super.disconnectedCallback();
  }

  protected override willUpdate(changes: Map<string, unknown>) {
    if (changes.has('resourceType') || changes.has('resourceId')) {
      this.latestRequest?.abort();
      this.clearHistory();
      this.latest = null;
      this.listError = '';
      this.selection = null;
      this.search = '';
      this.listPage = 0;
      this.preset = '60';
      this.window = rolling(60);
      this.invalidated = false;
      this.initialized = false;
      this.advanced = false;
      void this.load();
    }
  }

  private invalidate = () => {
    this.invalidated = true;
    this.latestRequest?.abort();
    this.clearHistory();
    this.latest = null;
    this.selection = null;
    this.advanced = false;
    this.listBusy = false;
    this.listError = '登录或权限已变更，请重新打开资源后读取指标。';
  };

  private recheckAccess = () => {
    this.invalidate();
    this.invalidated = false;
    this.initialized = false;
    void this.load();
  };

  private get resource() { return { type: this.resourceType, id: this.resourceId }; }

  async load() {
    if (this.invalidated || !this.resourceId) return;
    this.latestRequest?.abort();
    const request = this.latestRequest = new AbortController();
    const resource = this.resource;
    this.listBusy = true;
    this.listError = '';
    try {
      const latest = await metricRequest<Latest>('latest', resource, request.signal);
      if (request.signal.aborted) return;
      if (latest.resource.type !== resource.type || latest.resource.id !== resource.id || !Array.isArray(latest.metrics)) {
        throw new Error('LATEST_METRICS_CONTEXT');
      }
      this.latest = latest;
      if (!this.initialized) {
        this.initialized = true;
        this.restoreRoute();
      }
    } catch (error) {
      if (request.signal.aborted) return;
      if (accessDenied(error)) this.invalidate();
      else this.listError = '读取最新采集数据失败，请刷新重试。';
    } finally {
      if (!request.signal.aborted) this.listBusy = false;
    }
  }

  private rows(): Row[] {
    return (this.latest?.metrics ?? []).flatMap(metric => {
      const definition = metric.definition;
      const points = metric.series.length ? metric.series : [undefined];
      return points.map(point => {
        const dimensions = point?.dimensions ?? {};
        return {
          key: rowKey(definition.id, definition.semantic_version, dimensions),
          name: metricDisplayName(definition.id), metric, point, dimensions,
          graph: numeric.includes(definition.value_type)
            && ['gauge', 'counter'].includes(definition.kind) && (!point?.value || numeric.includes(point.value.encoding)),
        };
      });
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.key.localeCompare(b.key));
  }

  private restoreRoute = () => {
    if (!this.latest || this.invalidated) return;
    const params = new URL(location.href).searchParams;
    const metric = params.get('metric'), version = params.get('metricVersion');
    if (params.get('metricResource') !== `${this.resourceType}:${this.resourceId}` || !metric) {
      this.clearHistory();
      this.selection = null;
      return;
    }
    const dimension = params.get('metricDimensions');
    const row = this.rows().find(candidate => candidate.metric.definition.id === metric
      && (!version || candidate.metric.definition.semantic_version === version)
      && (!dimension || dimensionKey(candidate.dimensions) === dimension));
    if (!row || !this.canOpen(row)) {
      this.clearHistory();
      this.selection = null;
      this.listError = '链接指定的指标序列当前不可用，可从列表重新选择。';
      return;
    }
    const range = { from: params.get('metricFrom') ?? '', to: params.get('metricTo') ?? '' };
    if (validWindow(range, row.graph ? maxChartDays : maxDetailDays)) {
      this.window = normalizedWindow(range);
      this.preset = 'custom';
      this.setInputs();
    }
    this.selection = row;
    this.mode = row.graph && params.get('metricView') !== 'values' ? 'graph' : 'values';
    void this.readHistory();
  };

  private setInputs() {
    this.fromInput = localInput(this.window.from);
    this.toInput = localInput(this.window.to);
  }

  private canOpen(row: Row) {
    return Boolean(row.point) || !row.metric.definition.dimensions?.keys.some(key => key.required);
  }

  private writeRoute(push = false) {
    const url = new URL(location.href);
    const { searchParams: p } = url;
    const row = this.selection;
    if (row) {
      p.set('metricResource', `${this.resourceType}:${this.resourceId}`);
      p.set('metric', row.metric.definition.id);
      p.set('metricVersion', row.metric.definition.semantic_version);
      p.set('metricDimensions', dimensionKey(row.dimensions));
      p.set('metricFrom', this.window.from);
      p.set('metricTo', this.window.to);
      p.set('metricView', this.mode);
      window.dispatchEvent(new CustomEvent('slide-resource-window', { detail: { ...this.resource, window: this.window } }));
    } else {
      for (const key of ['metric', 'metricVersion', 'metricDimensions', 'metricView']) p.delete(key);
    }
    history[push ? 'pushState' : 'replaceState'](history.state, '', url);
  }

  private async open(row: Row) {
    this.selection = row;
    this.preset = '60';
    this.window = rolling(60);
    this.mode = row.graph ? 'graph' : 'values';
    this.rangeError = '';
    this.advanced = false;
    this.writeRoute(true);
    void this.readHistory();
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>('.history-title h2')?.focus();
  }

  private async back() {
    const previous = this.selection?.key;
    this.clearHistory();
    this.selection = null;
    this.writeRoute();
    await this.updateComplete;
    const actions = Array.from(this.renderRoot.querySelectorAll<HTMLButtonElement>('button[data-metric-key]'));
    (actions.find(button => button.dataset.metricKey === previous) ?? this.renderRoot.querySelector<HTMLInputElement>('.search input'))?.focus();
  }

  private clearHistory() {
    this.historyRequest?.abort();
    this.historyBusy = false;
    this.graph = null;
    this.historyPage = null;
    this.historyError = '';
    this.cursorStack = [undefined];
  }

  private changePreset(preset: Preset) {
    this.preset = preset;
    this.rangeError = '';
    if (preset === 'custom') this.setInputs();
    else this.applyWindow(rolling(Number(preset)));
  }

  private applyCustom() {
    const range = { from: this.fromInput, to: this.toInput };
    if (!validWindow(range, windowDays(this.mode))) {
      this.rangeError = `请选择有效的开始和结束时间，结束时间不得晚于现在，范围最长 ${windowDays(this.mode)} 天。`;
      return;
    }
    this.applyWindow(normalizedWindow(range));
  }

  private applyWindow(range: Window) {
    this.window = range;
    this.rangeError = '';
    this.writeRoute();
    void this.readHistory();
  }

  private changeMode(mode: Mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.rangeError = '';
    this.writeRoute();
    void this.readHistory();
  }

  private async readHistory(cursors: Array<string | undefined> = [undefined]) {
    const row = this.selection;
    if (!row || this.invalidated) return;
    this.historyRequest?.abort();
    const request = this.historyRequest = new AbortController();
    const { from, to } = this.window, { mode } = this;
    const series = { metric: { id: row.metric.definition.id, semantic_version: row.metric.definition.semantic_version }, dimensions: row.dimensions };
    const resource = this.resource;
    this.historyBusy = true;
    this.historyError = '';
    this.graph = null;
    this.historyPage = null;
    this.cursorStack = cursors;
    if (mode === 'values' && !validWindow(this.window, maxDetailDays)) {
      this.historyBusy = false;
      return;
    }
    try {
      if (mode === 'graph') {
        const result = await metricRequest<SemanticResult>('query', {
          resource, series, history: true, include_retained_trends: true, from, to,
          bucket_ms: bucketMsFor(Date.parse(from), Date.parse(to)),
        }, request.signal);
        if (request.signal.aborted) return;
        if (result.window.from !== from || result.window.to !== to) throw new Error('METRIC_HISTORY_WINDOW');
        this.graph = result;
      } else {
        const cursor = cursors.at(-1);
        const result = await metricRequest<HistoryPage>('observations', { resource, ...series, from, to,
          limit: historyPageSize, ...(cursor ? { cursor } : {}) }, request.signal);
        if (request.signal.aborted) return;
        if (result.window.from !== from || result.window.to !== to) throw new Error('METRIC_HISTORY_WINDOW');
        this.historyPage = result;
      }
    } catch (error) {
      if (request.signal.aborted) return;
      if (accessDenied(error)) this.invalidate();
      else this.historyError = error instanceof MetricRequestError && error.code === 'QUERY_LIMIT_EXCEEDED'
        ? '所选范围内的数据过多，请缩短时间范围。' : '读取指标历史失败，请重试。';
    } finally {
      if (!request.signal.aborted) this.historyBusy = false;
    }
  }

  private renderLatest() {
    const rows = this.rows(), query = this.search.trim().toLowerCase();
    const filtered = rows.filter(row => !query || `${row.name} ${row.metric.definition.id} ${dimensionText(row.dimensions)}`.toLowerCase().includes(query));
    const page = Math.min(this.listPage, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
    const shown = filtered.slice(page * pageSize, (page + 1) * pageSize);
    return html`<div class="stack">
      <div class="heading">
        <div><h2>最新采集数据</h2><p>每项显示最新一次正式采样及其质量。</p></div>
        <button class="btn btn-refresh" ?disabled=${this.listBusy || this.invalidated} @click=${() => void this.load()}>刷新指标</button>
      </div>
      ${this.listError ? html`<p class="error" role="alert">${this.listError}</p>` : nothing}
      ${this.latest ? html`<app-card>
        <div class="stack">
          <div class="toolbar">
            <label class="search">筛选指标<input type="search" placeholder="搜索指标名称、标识或维度" .value=${this.search}
              @input=${(event: Event) => { this.search = (event.target as HTMLInputElement).value; this.listPage = 0; }}></label>
            <span class="subtle">${filtered.length} / ${rows.length} 项 · 更新于 ${timestamp(this.latest.evaluated_at)}</span>
          </div>
          ${shown.length ? html`<app-data-table .dense=${true} .columns=${[
            { key: 'name', label: '指标' }, { key: 'time', label: '采样时间' }, { key: 'value', label: '最新值' },
            { key: 'state', label: '采集与质量' }, { key: 'action', label: '历史', width: '108px' },
          ]} .rows=${shown.map(row => {
            const point = row.point, dimensions = dimensionText(row.dimensions);
            return {
              name: html`<span class="name" title=${row.metric.definition.meaning}>${row.name}</span>
                <span class="dimension">${dimensions || row.metric.definition.id}${dimensions ? ` · ${row.metric.definition.id}` : ''} · v${row.metric.definition.semantic_version}</span>`,
              time: point ? html`<time datetime=${point.observed_at} title=${point.observed_at}>${timestamp(point.observed_at)}</time>` : '—',
              value: displayValue(point),
              state: html`<div class="badges">${point ? html`
                <app-badge variant=${point.quality.status === 'good' ? 'muted' : 'warn'}>${qualityLabels[point.quality.status] ?? point.quality.status}</app-badge>
                ${point.freshness !== 'fresh' ? html`<app-badge variant="warn">${point.freshness === 'stale' ? '已过期' : '时效待确认'}</app-badge>` : nothing}` : nothing}</div>
                <span class="status-note">${stateLabels[row.metric.state] ?? row.metric.state}</span>`,
              action: this.canOpen(row) ? html`<button class="btn-ghost btn-sm" data-metric-key=${row.key} title=${row.name}
                @click=${() => void this.open(row)}>${row.graph ? '图形' : '历史记录'}</button>` : html`<span class="subtle">待发现维度</span>`,
            };
          })}></app-data-table>` : html`<app-empty-state title=${rows.length ? '没有匹配的指标' : '尚无可展示的指标'}
            description=${rows.length ? '可调整搜索词后重试。' : '可在监控配置中检查模板绑定和采集状态。'}></app-empty-state>`}
          ${filtered.length > pageSize ? html`<div class="pagination">
            <span>第 ${page + 1} / ${Math.ceil(filtered.length / pageSize)} 页</span>
            <button class="btn" ?disabled=${page === 0} @click=${() => { this.listPage = page - 1; }}>上一页</button>
            <button class="btn" ?disabled=${(page + 1) * pageSize >= filtered.length} @click=${() => { this.listPage = page + 1; }}>下一页</button>
          </div>` : nothing}
        </div>
      </app-card>` : this.listBusy ? html`<div class="skeleton loading" role="status" aria-label="正在读取最新采集数据"></div>` : nothing}
      ${!this.invalidated ? html`<details class="advanced" @toggle=${(event: Event) => { this.advanced = (event.target as HTMLDetailsElement).open; }}>
        <summary>进阶分析与采集证据</summary>
        ${this.advanced ? html`<semantic-metrics .resourceType=${this.resourceType} .resourceId=${this.resourceId}></semantic-metrics>` : nothing}
      </details>` : nothing}
    </div>`;
  }

  private renderGraph(row: Row) {
    if (!this.graph) return nothing;
    const series = this.graph.metrics.find(metric => metric.definition.id === row.metric.definition.id
      && metric.definition.semantic_version === row.metric.definition.semantic_version)?.series
      .find(item => dimensionKey(item.dimensions) === dimensionKey(row.dimensions));
    const unit = row.metric.definition.unit;
    const floating = row.metric.definition.value_type === 'float64';
    const points = series?.buckets ?? [];
    const data = points.map(bucket => chartNumber(bucket.value, bucket.quality.status, bucket.unit === unit, floating));
    const trendMarkers = points.map(bucket => bucket.value === null && bucket.retained_sample_count
      ? chartNumber(bucket.stats?.avg ?? null, 'partial', bucket.unit === unit, floating) : null);
    const hasMarkers = trendMarkers.some(value => value !== null);
    if (!hasMarkers && !data.some(value => value !== null)) return html`<app-empty-state title="该时段没有可绘制的数值"
      description="可改选时间范围，或切换数值核对精确值与采集质量。"></app-empty-state>`;
    const bounds = (values: MetricSeries['data'], trend = false) => {
      const bound = (side: 'min' | 'max') => points.map((bucket, index) => values[index] === null ? null
        : chartNumber(bucket.stats?.[side] ?? null, trend ? 'partial' : bucket.quality.status, bucket.unit === unit, floating));
      const min = bound('min'), max = bound('max');
      return min.some((value, index) => value !== null && max[index] !== null && value !== max[index]) ? { min, max } : {};
    };
    const showSymbols = data.filter(value => value !== null).length <= 60;
    const hasTrends = hasMarkers || points.some((bucket, index) => data[index] !== null && bucket.retained_sample_count);
    const hasDetail = points.some((bucket, index) => data[index] !== null && !bucket.retained_sample_count);
    const chartSeries: MetricSeries[] = [{ name: row.name, data, showSymbols, showIsolatedPoints: hasTrends, ...bounds(data) }];
    if (hasMarkers) chartSeries.push({ name: '断点处的趋势统计', data: trendMarkers,
      pointsOnly: true, showSymbols: true, showIsolatedPoints: true, ...bounds(trendMarkers, true) });
    const description = hasTrends
      ? `${hasDetail ? '明细桶显示最后一个采样值。' : ''}含保留趋势的桶显示平均值，并保留最小值和最大值。`
      : '明细桶显示最后一个采样值。';
    return html`<metric-chart .title=${row.name} .yAxisLabel=${unit === '1' ? '' : unit} .height=${'320px'}
      .timeData=${points.map(bucket => bucket.window.to)}
      .series=${chartSeries}></metric-chart>
      <p class="window">${description}${row.metric.definition.kind === 'counter' ? '曲线显示累计值。' : ''}空桶和无效明细保留断点。${floating ? '' : '超出绘图精度的值可在数值表查看。'}</p>`;
  }

  private renderValues() {
    if (!validWindow(this.window, maxDetailDays)) return html`<app-empty-state title="数值查询最长 31 天"
      description="请选择更短的时间范围查看明细。"></app-empty-state>`;
    const data = this.historyPage;
    if (!data) return nothing;
    if (!data.observations.length) return html`<app-empty-state title="该时段没有原始观测"
      description="可调整时间范围后重新查询。"></app-empty-state>`;
    return html`<app-data-table .dense=${true} .columns=${[
      { key: 'time', label: '采样时间', width: '206px' }, { key: 'value', label: '原始值' },
      { key: 'quality', label: '质量', width: '160px' },
    ]} .rows=${data.observations.map(sample => ({
      time: html`<time datetime=${sample.observed_at} title=${sample.observed_at}>${timestamp(sample.observed_at)}</time>`,
      value: displayValue(sample, true),
      quality: html`<app-badge variant=${sample.quality.status === 'good' ? 'muted' : 'warn'}>${qualityLabels[sample.quality.status] ?? sample.quality.status}</app-badge>
        ${qualityLabels[sample.accuracy] ?? sample.accuracy}`,
    }))}></app-data-table>
    <div class="pagination">
      <span>共 ${data.total} 条 · 第 ${this.cursorStack.length} 页 · 按采样时间升序</span>
      <button class="btn" ?disabled=${this.cursorStack.length === 1} @click=${() => void this.readHistory(this.cursorStack.slice(0, -1))}>上一页</button>
      <button class="btn" ?disabled=${!data.has_more || !data.next_cursor} @click=${() => void this.readHistory([...this.cursorStack, data.next_cursor])}>下一页</button>
    </div>`;
  }

  private renderHistory(row: Row) {
    const dimensions = dimensionText(row.dimensions);
    return html`<div class="stack">
      <div class="history-title">
        <button class="btn" @click=${() => void this.back()}>返回指标列表</button>
        <div><h2 tabindex="-1">${row.name}</h2><span class="dimension">${dimensions ? `${dimensions} · ` : ''}${row.metric.definition.id} · v${row.metric.definition.semantic_version}</span></div>
      </div>
      <app-card><div class="stack">
        <form class="toolbar" @submit=${(event: Event) => { event.preventDefault(); this.applyCustom(); }}>
          <label>时间范围<select .value=${this.preset} @change=${(event: Event) => this.changePreset((event.target as HTMLSelectElement).value as Preset)}>
            ${presets.map(([key, label]) => html`<option value=${key} ?selected=${key === this.preset}
              ?disabled=${key === '129600' && this.mode === 'values'}>${label}</option>`)}
          </select></label>
          ${this.preset === 'custom' ? html`<label>开始时间<input type="datetime-local" required .value=${this.fromInput}
            @input=${(e: Event) => { this.fromInput = (e.target as HTMLInputElement).value; }}></label>
            <label>结束时间<input type="datetime-local" required .value=${this.toInput}
              @input=${(e: Event) => { this.toInput = (e.target as HTMLInputElement).value; }}></label>
            <button class="btn-primary" type="submit">应用</button>` : nothing}
          <button class="btn btn-refresh" type="button" ?disabled=${this.historyBusy} @click=${() => this.preset === 'custom'
            ? void this.readHistory() : this.applyWindow(rolling(Number(this.preset)))}>刷新历史</button>
        </form>
        ${this.rangeError ? html`<p class="error" role="alert">${this.rangeError}</p>` : nothing}
        <div class="heading">
          ${row.graph ? html`<div class="modes" role="group" aria-label="历史查看方式">
            <button class="btn" aria-pressed=${String(this.mode === 'graph')} @click=${() => this.changeMode('graph')}>图形</button>
            <button class="btn" aria-pressed=${String(this.mode === 'values')} @click=${() => this.changeMode('values')}>数值</button>
          </div>` : html`<h3>历史记录</h3>`}
          <p class="window">${timestamp(this.window.from)} — ${timestamp(this.window.to)} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
        </div>
        ${this.historyError ? html`<p class="error" role="alert">${this.historyError}</p>
          <button class="btn" @click=${() => void this.readHistory(this.cursorStack)}>重试</button>` : nothing}
        ${this.historyBusy ? html`<div class="skeleton loading" role="status" aria-label="正在读取指标历史"></div>` :
          this.mode === 'graph' ? this.renderGraph(row) : this.renderValues()}
      </div></app-card>
    </div>`;
  }

  override render() {
    return this.selection ? this.renderHistory(this.selection) : this.renderLatest();
  }
}
