import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './app-card.js';
import './app-data-table.js';
import './app-empty-state.js';
import './app-badge.js';
import './metric-chart.js';
import { metricName } from './resource-metric-summary.js';
export interface MetricResult {
  definition: { id: string; category: string; meaning: string; unit: string }; state: string; capability: unknown;
  observed_at?: string;
  series: Array<{ dimensions: Record<string, string>; buckets: Array<{ value: { encoding: string; value?: number | string } | null;
    unit: string; coverage: number; quality: { status: string; reason: string }; freshness: string; observed_at?: string | null; accuracy: string; sources: unknown[]; window: { from: string; to: string } }> }>;
}
export interface SemanticResult { profile: { columns: Array<{ key: string; metric: { id: string }; label: string }> }; window: { from: string; to: string }; metrics: MetricResult[] }
const states: Record<string, string> = { query_operation_unavailable: '当前定义不允许速率聚合', available: '可用', not_configured: '当前模板未覆盖', disabled: '已停用', unsupported: '能力不支持', permission_denied: '采集权限不足', temporary_failure: '采集暂时失败', capability_unknown: '能力待确认' };
const qualityLabels: Record<string, string> = { good: '良好', partial: '部分', unknown: '未知', invalid: '无效', fresh: '新鲜', stale: '过期', exact: '精确', estimated: '估算' };
export function renderMetricValue(m: MetricResult) {
  return html`<span>${states[m.state] ?? m.state}</span>${m.series.length ? m.series.map(s => html`<div>
    ${Object.entries(s.dimensions).map(([k, v]) => `${k}=${v}`).join(' / ')}
    ${s.buckets.map(b => html`<div >
      <strong>${b.value && 'value' in b.value ? b.value.value : '未知'}</strong> ${b.unit}
      <div>观测时间：${b.observed_at && Number.isFinite(Date.parse(b.observed_at))
        ? html`<time datetime=${b.observed_at}>${new Date(b.observed_at).toLocaleString('zh-CN')}</time>` : '未知'}</div>
      <div class="quality-badges">${[b.quality.status, b.freshness, b.accuracy].map(label => html`<app-badge variant=${['good', 'fresh', 'exact'].includes(label) && m.state === 'available' ? 'muted' : 'warn'}>${qualityLabels[label] ?? label}</app-badge>`)}</div>
      <span>覆盖率 ${(b.coverage * 100).toFixed(0)}%</span><details><summary>时间、质量与来源</summary><p>采集窗口 ${b.window.from} — ${b.window.to}</p><p>质量原因：${b.quality.reason}</p><pre>${JSON.stringify(b.sources, null, 2)}</pre></details>
    </div>`)}
  </div>`) : html`<span> · 暂无可用观测</span>`}`;
}
const errors = (status: number) => status === 403 ? '没有此资源的查看权限' : status === 401 ? '登录已失效' : '查询暂时失败；保留上次结果，不能据此判断健康';
@customElement('semantic-metrics')
export class SemanticMetrics extends LitElement {
  @property() resourceType = 'instance';
  @property({ type: Number }) resourceId = 0;
  @property() from = '';
  @property() to = '';
  @state() private selectedMetric = '';
  @state() private hours = 1;
  @state() private chartKeys = new Set<string>();
  @state() result: SemanticResult | null = null;
  @state() error = '';
  @state() busy = false;
  private generation = 0;
  @state() private accessInvalidated = false;
  private onAccessChanged = () => {
    ++this.generation; this.result = null; this.chartKeys = new Set(); this.busy = false;
    this.accessInvalidated = true; this.error = '权限或登录状态已变更，请重新打开资源后读取指标';
  };
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.onAccessChanged);
    window.addEventListener('slide-session-expired', this.onAccessChanged);
  }
  override willUpdate(changes: Map<string, unknown>) {
    if (['resourceId', 'resourceType', 'from', 'to'].some(k => changes.has(k))) {
      this.result = null; this.chartKeys = new Set();
      if (changes.has('resourceId') || changes.has('resourceType')) {
        this.accessInvalidated = false;
        if ((changes.get('resourceId') !== undefined || changes.get('resourceType') !== undefined) && !changes.has('from') && !changes.has('to')) { this.from = ''; this.to = ''; }
        const p = new URL(location.href).searchParams;
        if (p.get('metricResource') === `${this.resourceType}:${this.resourceId}`) {
          this.selectedMetric = p.get('metric') ?? '';
          const from = p.get('metricFrom'), to = p.get('metricTo');
          if (from && to && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to))) { this.from = from; this.to = to; }
        } else this.selectedMetric = '';
      }
      void this.load();
    }
  }
  override disconnectedCallback() {
    this.generation++;
    window.removeEventListener('slide-permissions-loaded', this.onAccessChanged);
    window.removeEventListener('slide-session-expired', this.onAccessChanged);
    super.disconnectedCallback();
  }
  async load() {
    if (this.accessInvalidated || !this.resourceId) return;
    const generation = ++this.generation, resourceId = this.resourceId, resourceType = this.resourceType;
    const current = () => generation === this.generation && resourceId === this.resourceId && resourceType === this.resourceType;
    this.busy = true; this.error = '';
    try {
      const now = Date.now();
      const response = await authFetch('/api/metrics/query', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: { type: this.resourceType, id: this.resourceId }, view: 'all', ...(this.from && this.to ? { from: this.from, to: this.to } : { from: new Date(now - this.hours * 3600000).toISOString(), to: new Date(now).toISOString(), bucket_ms: Math.max(60000, this.hours * 60000) }) }) });
      if (!current()) return;
      if (!response.ok) { if ([401, 403, 404].includes(response.status)) this.result = null; throw new Error(errors(response.status)); }
      const result = await response.json();
      if (current()) this.result = result;
    } catch (e) { if (current()) this.error = e instanceof Error ? e.message : errors(503); }
    finally { if (current()) this.busy = false; }
  }
  private renderTrend(metric: MetricResult, series: MetricResult['series'][number]) {
    return html`<metric-chart .title=${metricName(metric.definition.id)} .yAxisLabel=${series.buckets[0]?.unit ?? metric.definition.unit}
      .timeData=${series.buckets.map(b => b.window.to)} .series=${[{ name: metricName(metric.definition.id), data: series.buckets.map(b => {
        const v = b.value?.value, n = Number(v);
        return v != null && Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER && metric.state === 'available' && b.quality.status === 'good' && b.freshness === 'fresh' ? n : null;
      }) }]}></metric-chart>`;
  }
  override render() {
    const metrics = this.result?.metrics.filter(m => !this.selectedMetric || m.definition.id === this.selectedMetric) ?? [];
    const trends = metrics.flatMap(metric => metric.series.map(series => ({ metric, series }))).filter(({series}) => series.buckets.filter(b => Number.isFinite(Date.parse(b.window.to))).length > 1);
    return html`<style>${sharedFieldStyles}${sharedBtnStyles}
      :host { display:block; min-width:0; color:var(--text); font-size:14px; }
      .actions { display:flex; flex-wrap:wrap; align-items:end; gap:var(--space-sm); margin-block:var(--space-md); }
      .actions label { display:grid; gap:var(--space-xs); min-width:0; max-width:100%; font-size:12px; color:var(--muted); }
      select { width:100%; max-width:360px; min-width:0; box-sizing:border-box; padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); background:var(--bg); font-size:14px; }
      .window { flex-basis:100%; margin:0; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
      .error { color:var(--danger); } .skeleton { min-height:4rem; background:var(--border); }
      p,strong,pre { overflow-wrap:anywhere; } pre { white-space:pre-wrap; }
      .quality-badges { display:flex; flex-wrap:wrap; gap:var(--space-xs); }
      app-data-table { display:block; max-width:100%; overflow-x:auto; }
      .summary-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:var(--space-md); border-bottom:1px solid var(--border); padding-block:var(--space-md); }
      .metric-name { margin:0 0 var(--space-sm); font-size:14px; color:var(--muted); }
      .current strong { font-size:24px; color:var(--text-strong); }
      .current { font-size:12px; min-width:0; overflow-wrap:anywhere; }
      .current time { display:block; color:var(--muted); margin-block:var(--space-xs); }
      .trend-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-md); margin-block:var(--space-lg); }
      .trend-grid app-card { min-width:0; }
      metric-chart { display:block; min-width:0; }
      details { margin-block:var(--space-sm); } summary { cursor:pointer; color:var(--text); }
      h2 { font-size:16px; margin-block:var(--space-lg) var(--space-sm); }
      @media(max-width:700px) { .trend-grid { grid-template-columns:minmax(0,1fr); } .summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .actions label { flex:1 1 120px; } select { max-width:100%; } }
    </style>
    <div class="actions">
      <label>时间范围 <select aria-label="时间范围" ?disabled=${this.accessInvalidated} .value=${String(this.hours)} @change=${(e: Event) => {
        this.hours = Number((e.target as HTMLSelectElement).value); this.result = null; this.chartKeys = new Set();
        const absolute = this.from || this.to; this.from = ''; this.to = ''; if (!absolute) void this.load();
      }}><option value="1">最近 1 小时</option><option value="6">最近 6 小时</option><option value="24">最近 24 小时</option></select></label>
      <label>指标 <select aria-label="指标" ?disabled=${this.accessInvalidated} .value=${this.selectedMetric} @change=${(e: Event) => { this.selectedMetric = (e.target as HTMLSelectElement).value; }}><option value="">全部指标</option>${this.result?.metrics.map(m => html`<option value=${m.definition.id}>${metricName(m.definition.id)} · ${m.definition.id}</option>`)}</select></label>
      <button aria-busy=${String(this.busy)} class="btn btn-refresh" .disabled=${this.busy || this.accessInvalidated} @click=${this.load}>刷新标准指标</button>
      ${this.result ? html`<p class="window">查询窗口：${this.result.window.from} — ${this.result.window.to} · 窗口不代表实际观测时间</p>` : nothing}
    </div>
    ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
    ${this.busy && !this.result ? html`<div class="skeleton" aria-label="正在读取指标"></div>` : nothing}
    ${metrics.length ? html`<div class="summary-grid" aria-label="当前指标比较">${metrics.map(m => html`<div class="current"><h3 class="metric-name">${metricName(m.definition.id)}</h3>
      <span>${states[m.state] ?? m.state}</span>
      ${!m.series.length ? html`<p>暂无可用观测</p>` : m.series.map(series => {
        const b = series.buckets.at(-1);
        return html`<div>${Object.values(series.dimensions).join(' / ')}${b ? html`<div><strong>${b.value?.value ?? '未知'}</strong> ${b.unit}</div>
          <div>观测时间：${b.observed_at && Number.isFinite(Date.parse(b.observed_at)) ? html`<time datetime=${b.observed_at}>${new Date(b.observed_at).toLocaleString('zh-CN')}</time>` : '未知'}</div>
          <div class="quality-badges">${[b.quality.status,b.freshness,b.accuracy].map(label => html`<app-badge variant=${['good','fresh','exact'].includes(label) && m.state === 'available' ? 'muted' : 'warn'}>${qualityLabels[label] ?? label}</app-badge>`)}</div>` : '暂无可用观测'}</div>`;
      })}</div>`)}</div>` : nothing}
    ${trends.length ? html`<div class="trend-grid" aria-label="指标趋势比较">${trends.slice(0,2).map(({metric,series}) => html`<app-card><span slot="header">${metricName(metric.definition.id)} · ${Object.values(series.dimensions).join(' / ') || '整体'}</span>${this.renderTrend(metric,series)}</app-card>`)}</div>
      <p class="window">缺失、过期、质量不明及超出安全数值精度的区间保留断点。全部维度与精确值可在观测明细中核对。</p>` : nothing}
    <h2>观测明细</h2>
    ${['canonical', 'extension'].map(category => html`<app-card><span slot="header">${category === 'canonical' ? '标准指标与能力' : '模板扩展指标'}</span>
      ${metrics.filter(m => m.definition.category === category).length ? html`<details><summary>查看原始时间桶、定义与来源（${metrics.filter(m => m.definition.category === category).length} 项）</summary>
        <app-data-table .dense=${true} .columns=${[{key:'metric',label:'指标与口径'},{key:'value',label:'观测与质量'}]}
        .rows=${metrics.filter(m => m.definition.category === category).map(m => ({metric:html`<strong>${metricName(m.definition.id)}</strong><details><summary>指标定义</summary><p>${m.definition.id}</p><p>${m.definition.meaning}</p></details>`,value:html`${renderMetricValue(m)}${m.series.map(series => html`<details @toggle=${(e:Event) => {
          const key=m.definition.id+JSON.stringify(series.dimensions), next=new Set(this.chartKeys);
          (e.target as HTMLDetailsElement).open ? next.add(key) : next.delete(key); this.chartKeys=next;
        }}><summary>此维度趋势</summary>${this.chartKeys.has(m.definition.id+JSON.stringify(series.dimensions)) ? this.renderTrend(m,series) : nothing}</details>`)}`}))}></app-data-table>
      </details>` : html`<app-empty-state title="暂无指标证据" description="未配置或无法读取不代表无异常。"></app-empty-state>`}
    </app-card>`)}`;
  }
}
// Separate from templates: the product's core columns are returned even for an unconfigured resource.
@customElement('semantic-core-list')
export class SemanticCoreList extends LitElement {
  @property() resourceType = 'instance';
  @property({ attribute: false }) resources: Array<{ id: number; name?: string; label?: string; host?: string }> = [];
  @state() private rows: Record<string, unknown>[] = [];
  private get columns() { return [{ key: 'resource', label: '资源' }, ...({
    instance: [{ key: 'db.uptime_seconds', label: '数据库运行时长' }],
    server: [{ key: 'host.filesystem.used_bytes', label: '文件系统已用' }, { key: 'host.filesystem.size_bytes', label: '文件系统容量' }, { key: 'host.network.bytes_total', label: '接口字节速率' }],
    network_device: [{ key: 'network.interface.oper_up', label: '接口运行状态' }],
  }[this.resourceType] ?? []), { key: 'error', label: '查询状态' }]; }
  private generation = 0;
  private onAccessChanged = () => { ++this.generation; this.rows = []; };
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.onAccessChanged);
    window.addEventListener('slide-session-expired', this.onAccessChanged);
  }
  override willUpdate(changes: Map<string, unknown>) { if (changes.has('resources') || changes.has('resourceType')) void this.load(); }
  override disconnectedCallback() {
    this.generation++;
    window.removeEventListener('slide-permissions-loaded', this.onAccessChanged);
    window.removeEventListener('slide-session-expired', this.onAccessChanged);
    super.disconnectedCallback();
  }
  private async load() {
    this.rows = [];
    const generation = ++this.generation, to = new Date().toISOString();
    const rows: Record<string, unknown>[] = [];
    // Bound concurrent requests and keep every row, including failed resources.
    for (const resource of this.resources) {
      if (generation !== this.generation) return;
      const row: Record<string, unknown> = { resource: resource.name || resource.label || resource.host || String(resource.id) };
      try {
        const response = await authFetch('/api/metrics/query', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resource: { type: this.resourceType, id: resource.id }, view: 'core', from: new Date(Date.parse(to) - 60000).toISOString(), to }) });
        if (!response.ok) throw new Error(errors(response.status));
        const data: SemanticResult = await response.json();
        if (generation !== this.generation) return;

        for (const m of data.metrics) row[m.definition.id] = renderMetricValue(m);
      } catch (e) { row.error = e instanceof Error ? e.message : errors(503); }
      rows.push(row);
    }
    if (generation === this.generation) this.rows = rows;
  }
  override render() { return html`<app-card><span slot="header">核心指标（固定产品口径）</span>
    <app-data-table .columns=${this.columns.length ? this.columns : [{ key: 'resource', label: '资源' }, { key: 'error', label: '查询状态' }]} .rows=${this.rows}></app-data-table></app-card>`; }
}
