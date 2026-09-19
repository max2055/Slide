import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './app-card.js';
import './app-data-table.js';
import './app-empty-state.js';
import './app-badge.js';
export interface MetricResult {
  definition: { id: string; category: string; meaning: string; unit: string }; state: string; capability: unknown;
  series: Array<{ dimensions: Record<string, string>; buckets: Array<{ value: { encoding: string; value?: number | string } | null;
    unit: string; coverage: number; quality: { status: string; reason: string }; freshness: string; accuracy: string; sources: unknown[]; window: { from: string; to: string } }> }>;
}
export interface SemanticResult { profile: { columns: Array<{ key: string; metric: { id: string }; label: string }> }; window: { from: string; to: string }; metrics: MetricResult[] }
const states: Record<string, string> = { query_operation_unavailable: '当前定义不允许速率聚合', available: '可用', not_configured: '未配置', disabled: '已停用', unsupported: '能力不支持', permission_denied: '采集权限不足', temporary_failure: '采集暂时失败', capability_unknown: '能力待确认' };
const qualityLabels: Record<string, string> = { good: '良好', partial: '部分', unknown: '未知', invalid: '无效', fresh: '新鲜', stale: '过期', exact: '精确', estimated: '估算' };
export function renderMetricValue(m: MetricResult) {
  return html`<span>${states[m.state] ?? m.state}</span>${m.series.length ? m.series.map(s => html`<div>
    ${Object.entries(s.dimensions).map(([k, v]) => `${k}=${v}`).join(' / ')}
    ${s.buckets.map(b => html`<div title=${JSON.stringify({ definition: m.definition, ...b })}>
      <strong>${b.value && 'value' in b.value ? b.value.value : '未知'}</strong> ${b.unit}
      <div class="quality-badges">${[b.quality.status, b.freshness, b.accuracy].map(label => html`<app-badge variant=${['good', 'fresh', 'exact'].includes(label) && m.state === 'available' ? 'muted' : 'warn'}>${qualityLabels[label] ?? label}</app-badge>`)}</div>
      <span>覆盖率 ${(b.coverage * 100).toFixed(0)}% · ${b.quality.reason}</span>
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
  @state() result: SemanticResult | null = null;
  @state() error = '';
  @state() busy = false;
  private generation = 0;
  override updated(changes: Map<string, unknown>) {
    if (['resourceId', 'resourceType', 'from', 'to'].some(k => changes.has(k))) { this.result = null; void this.load(); }
  }
  override disconnectedCallback() { this.generation++; super.disconnectedCallback(); }
  async load() {
    const generation = ++this.generation;
    this.busy = true; this.error = '';
    try {
      const response = await authFetch('/api/metrics-v2/query', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: { type: this.resourceType, id: this.resourceId }, view: 'all', ...(this.from && this.to ? { from: this.from, to: this.to } : {}) }) });
      if (generation !== this.generation) return;
      if (!response.ok) { if ([401, 403, 404].includes(response.status)) this.result = null; throw new Error(errors(response.status)); }
      const result = await response.json();
      if (generation === this.generation) this.result = result;
    } catch (e) { if (generation === this.generation) this.error = e instanceof Error ? e.message : errors(503); }
    finally { if (generation === this.generation) this.busy = false; }
  }
  override render() {
    return html`<style>${sharedBtnStyles}
      :host { display:block; color:var(--text); } .actions { display:flex; gap:var(--space-sm); margin-block:var(--space-md); }
      .error { color:var(--danger); } .skeleton { min-height:4rem; background:var(--border); } p,strong { overflow-wrap:anywhere; } .quality-badges { display:flex; flex-wrap:wrap; gap:var(--space-xs); } app-data-table { display:block; max-width:100%; overflow-x:auto; }
    </style><div class="actions"><button class="btn" .disabled=${this.busy} @click=${this.load}>刷新标准指标</button>
      ${this.result ? html`<span>${this.result.window.from} — ${this.result.window.to}</span>` : nothing}</div>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${this.busy && !this.result ? html`<div class="skeleton" aria-label="正在读取指标"></div>` : nothing}
      ${['canonical', 'extension'].map(category => html`<app-card><span slot="header">${category === 'canonical' ? '标准指标与能力' : '模板扩展指标'}</span>
        ${this.result?.metrics.filter(m => m.definition.category === category).length ? html`<app-data-table
          .columns=${[{ key: 'metric', label: '指标与口径' }, { key: 'value', label: '观测与质量' }]}
          .rows=${this.result.metrics.filter(m => m.definition.category === category).map(m => ({ metric: html`<strong>${m.definition.id}</strong><p>${m.definition.meaning}</p>`, value: renderMetricValue(m) }))}></app-data-table>`
          : html`<app-empty-state title="暂无指标证据" description="未配置或无法读取不代表无异常。"></app-empty-state>`}
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
  override updated(changes: Map<string, unknown>) { if (changes.has('resources') || changes.has('resourceType')) void this.load(); }
  override disconnectedCallback() { this.generation++; super.disconnectedCallback(); }
  private async load() {
    const generation = ++this.generation, to = new Date().toISOString();
    const rows: Record<string, unknown>[] = [];
    // Bound concurrent requests and keep every row, including failed resources.
    for (const resource of this.resources) {
      if (generation !== this.generation) return;
      const row: Record<string, unknown> = { resource: resource.name || resource.label || resource.host || String(resource.id) };
      try {
        const response = await authFetch('/api/metrics-v2/query', { method: 'POST', headers: { 'Content-Type': 'application/json' },
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
