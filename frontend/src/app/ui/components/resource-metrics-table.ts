import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { collectionLabels, collectionState, metricSummary, diskSummary, type MetricRow } from './resource-metric-summary.js';
import type { SemanticResult } from './semantic-metrics.js';
import type { Column } from './app-data-table.js';
import './app-data-table.js';
import './app-form-field.js';
import './app-empty-state.js';
import './app-badge.js';
export interface ResourceEntry { id: number; type?: string | null; version?: string | null; model?: string | null; [key: string]: unknown }
const unknown = (value: unknown) => value == null || value === '' ? '未知' : String(value);
@customElement('resource-metrics-table')
export class ResourceMetricsTable extends LitElement {
  @property() resourceType = 'instance';
  @property({ attribute: false }) entries: ResourceEntry[] = [];
  @property({ attribute: false }) columns: Column[] = [];
  @state() private filters: Record<string, string> = { type: '', version: '', model: '' };
  @state() private collection = '';
  @state() private page = 1;
  @state() private rows = new Map<number, MetricRow>();
  @state() private pending = false;
  private generation = 0;
  private identity = '';
  private pageSize = 20;
  private restoredType = '';
  private restorePreferences() {
    if (this.restoredType === this.resourceType) return;
    this.restoredType = this.resourceType;
    try {
      const saved = JSON.parse(sessionStorage.getItem(`resource-list:${this.resourceType}`) ?? 'null');
      if (saved) { this.filters = saved.filters; this.collection = saved.collection; this.page = Math.max(1, Number(saved.page) || 1); this.hiddenColumns = saved.hiddenColumns ?? []; }
    } catch { /* Storage may be unavailable; navigation still works. */ }
  }
  @state() private hiddenColumns: string[] = [];
  override updated() {
    this.restorePreferences();
    try { sessionStorage.setItem(`resource-list:${this.resourceType}`, JSON.stringify({ filters: this.filters, collection: this.collection, page: this.page, hiddenColumns: this.hiddenColumns })); } catch { /* Optional preference storage. */ }
    const identity = `${this.resourceType}:${this.entries.map(e => [e.id, e.type, e.version, e.model].join(':')).join(',')}`;
    if (identity !== this.identity) { this.identity = identity; this.rows = new Map(); void this.load(); }
  }
  override disconnectedCallback() { this.generation++; super.disconnectedCallback(); }
  private get candidates() { return this.entries.filter(e => Object.entries(this.filters).every(([k,v]) => !v || unknown(e[k]) === v)); }
  private get filtered() { return this.candidates.filter(e => !this.collection || this.rows.get(e.id)?.state === this.collection); }
  private get visible() { const filtered = this.filtered; const page = Math.min(this.page, Math.max(1, Math.ceil(filtered.length / this.pageSize))); return filtered.slice((page - 1) * this.pageSize, page * this.pageSize); }
  private changeFilter(key: string, value: string) {
    this.filters = { ...this.filters, [key]: value }; this.page = 1; void this.load();
  }
  async load(force = false) {
    const generation = ++this.generation;
    const type = this.resourceType;
    const targets = this.collection ? this.candidates : this.visible;
    this.page = Math.min(this.page, Math.max(1, Math.ceil(this.filtered.length / this.pageSize)));
    const queue = targets.filter(e => force || !this.rows.has(e.id));
    this.pending = queue.length > 0;
    
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length && generation === this.generation) {
        const entry = queue[cursor++];
        let row: MetricRow;
        try {
          const response = await authFetch('/api/metrics-v2/query', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resource: { type, id: entry.id }, view: 'core' }) });
          if (!response.ok) row = { state: response.status === 403 || response.status === 401 ? 'forbidden' : response.status === 404 ? 'unavailable' : 'query_failed' };
          else {
            const result: SemanticResult = await response.json();
            row = { result, state: collectionState(result) };
            if (generation !== this.generation) return;
            const attempts = await authFetch(`/api/metrics-v2/config/resources/${type}/${entry.id}/attempts`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
            if (attempts && (attempts.status === 401 || attempts.status === 403 || attempts.status === 404)) row = { state: attempts.status === 404 ? 'unavailable' : 'forbidden' };
            else if (attempts?.ok) {
              const history: Array<{ status: string; ended_at?: string }> = await attempts.json();
              row.lastSuccess = history.filter(a => a.status === 'succeeded' && a.ended_at).map(a => a.ended_at!).sort().at(-1);
            } else row.timeUnavailable = true;
          }
        } catch { row = { state: 'query_failed' }; }
        if (generation !== this.generation) return;
        this.rows = new Map(this.rows).set(entry.id, row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    if (generation === this.generation) this.pending = false;
  }
  private metric(entry: ResourceEntry, id: string) {
    const row = this.rows.get(entry.id);
    return html`<button class="btn-ghost" @click=${() => {
      const url = new URL(location.href); url.searchParams.set('metricResource', `${this.resourceType}:${entry.id}`); url.searchParams.set('metric', id);
      if (row?.result) { url.searchParams.set('metricFrom', row.result.window.from); url.searchParams.set('metricTo', row.result.window.to); }
      window.history.replaceState(window.history.state, '', url);
      this.dispatchEvent(new CustomEvent('resource-metric-open', { detail: { id: entry.id, metric: id }, bubbles: true, composed: true }));
    }}>${row ? row.result ? id === 'host.filesystem.used_bytes' ? diskSummary(row.result) : metricSummary(row.result, id) : collectionLabels[row.state] : '正在读取'}</button>`;
  }
  render() {
    const metricColumns = this.resourceType === 'instance' ? [{ key: 'uptime', label: '运行时长' }] : this.resourceType === 'server'
      ? [{ key: 'disk', label: '磁盘（挂载点）' }, { key: 'network', label: '网络速率（逐接口）' }]
      : [{ key: 'interfaces', label: '接口摘要' }];
    const columns = [...this.columns.filter(c => c.key !== 'actions'), ...metricColumns, { key: 'collection', label: '采集状态 / 最近成功时间' }, ...this.columns.filter(c => c.key === 'actions')];
    const rows = this.visible.map(entry => {
      const row = this.rows.get(entry.id);
      return { ...entry, ...(['forbidden', 'unavailable'].includes(row?.state ?? '') ? { cpu: '无可用权限或资源', memory: '无可用权限或资源', capacity: '无可用权限或资源' } : {}), type: unknown(entry.type), version: unknown(entry.version), model: unknown(entry.model),
        uptime: this.metric(entry, 'db.uptime_seconds'), disk: this.metric(entry, 'host.filesystem.used_bytes'),
        network: this.metric(entry, 'host.network.bytes_total'), interfaces: this.metric(entry, 'network.interface.oper_up'),
        collection: html`<span>${collectionLabels[row?.state ?? 'loading'] ?? '待验证'}</span><small>${row?.lastSuccess ? html`<time title=${new Date(row.lastSuccess).toString()} datetime=${row.lastSuccess}>${new Date(row.lastSuccess).toLocaleString('zh-CN')}</time>` : row?.timeUnavailable ? '成功时间暂不可用' : '近期无成功采集记录'}</small>
          ${row && ['query_failed', 'forbidden', 'unavailable'].includes(row.state) ? html`<button class="btn-ghost" @click=${() => { this.rows.delete(entry.id); void this.load(); }}>重试</button>` : nothing}` };
    });
    return html`<style>${sharedBtnStyles}
      :host { display:block; min-width:0; max-width:100%; color:var(--text); } .filters,.pages { display:flex; gap:var(--space-sm); flex-wrap:wrap; align-items:center; margin-block:var(--space-md); }
      .scroll { max-width:100%; overflow:auto; } app-data-table { min-width:65rem; } .actions { display:flex; gap:var(--space-xs); flex-wrap:wrap; } details label { display:block; } .link-button { color:var(--accent); background:none; border:none; cursor:pointer; font:inherit; } small { display:block; color:var(--muted); } .btn-ghost { text-align:left; white-space:normal; overflow-wrap:anywhere; } select { max-width:15rem; color:var(--text); background:var(--bg); padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); } :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    </style><div class="filters">
      ${['type', ...(this.resourceType === 'network_device' ? ['model'] : []), 'version'].map(key => html`<app-form-field label=${({ type: '类型', model: '型号', version: '版本' }[key])!}><select aria-label=${({ type: '类型', model: '型号', version: '版本' }[key])!} .value=${this.filters[key]} @change=${(e: Event) => this.changeFilter(key, (e.target as HTMLSelectElement).value)}><option value="">全部</option>
        ${[...new Set(this.entries.filter(e => key !== 'version' || !this.filters.type || unknown(e.type) === this.filters.type).map(e => unknown(e[key])))].sort().map(v => html`<option value=${v}>${v}</option>`)}</select></app-form-field>`)}
      <app-form-field label="采集状态"><select aria-label="采集状态" .value=${this.collection} @change=${(e: Event) => { this.collection = (e.target as HTMLSelectElement).value; this.page = 1; void this.load(); }}><option value="">全部</option>${Object.entries(collectionLabels).filter(([k]) => k !== 'loading').map(([k,v]) => html`<option value=${k}>${v}</option>`)}</select></app-form-field>
      <button class="btn" @click=${() => { this.filters = { type: '', model: '', version: '' }; this.collection = ''; this.page = 1; void this.load(); }}>清除筛选</button>
      <button class="btn" .disabled=${this.pending} @click=${() => this.load(true)}>刷新指标</button>
      <details><summary>列设置</summary>${columns.filter(c => !['actions', 'name', 'host', 'device'].includes(c.key)).map(c => html`<label><input type="checkbox" .checked=${!this.hiddenColumns.includes(c.key)} @change=${(e: Event) => { this.hiddenColumns = (e.target as HTMLInputElement).checked ? this.hiddenColumns.filter(k => k !== c.key) : [...this.hiddenColumns, c.key]; }}>${c.label}</label>`)}<button class="btn" @click=${() => { this.hiddenColumns = []; }}>恢复默认</button></details>
    </div>
    ${this.pending && this.collection ? html`<p role="status">正在检查全部筛选资源的采集状态，结果尚未完整。</p>` : nothing}
    ${this.filters.version && !this.entries.some(e => (!this.filters.type || unknown(e.type) === this.filters.type) && unknown(e.version) === this.filters.version) ? html`<p role="status">当前类型下没有所选版本，请清除版本筛选。</p>` : nothing}
    <div class="scroll" tabindex="0" aria-label="资源表格，可横向滚动"><app-data-table .striped=${false} .dense=${true} .columns=${columns.filter(c => !this.hiddenColumns.includes(c.key))} .rows=${rows} emptyMessage="没有符合条件的资源"></app-data-table></div>
    <div class="pages"><span>筛选结果 ${this.filtered.length} / ${this.entries.length}</span><button class="btn" .disabled=${this.page <= 1} @click=${() => { this.page--; void this.load(); }}>上一页</button><span>第 ${Math.min(this.page, Math.max(1, Math.ceil(this.filtered.length / this.pageSize)))} 页</span><button class="btn" .disabled=${this.page * this.pageSize >= this.filtered.length} @click=${() => { this.page++; void this.load(); }}>下一页</button></div>`;
  }
}
