import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { collectionLabels, collectionState, metricSummary, diskSummary, databaseSizeMetric, databaseSizeSummary, type MetricRow } from './resource-metric-summary.js';
import { readCollectionStatus, statusLabel } from './metric-api.js';
import type { SemanticResult } from './semantic-metrics.js';
import type { Column } from './app-data-table.js';
import { freshness, runState, type OverviewItem } from '../views/dashboard-model.js';
import { evidenceTime, evidenceTimeState } from '../views/health-score-state.js';
import './app-data-table.js';
import './app-dialog.js';
import './app-empty-state.js';
import './app-badge.js';
import './metric-bulk-dialog.js';
import { bulkSelection, type BulkResource } from './metric-bulk-selection.js';
import type { MetricBulkDialog } from './metric-bulk-dialog.js';
export interface ResourceEntry { id: number; type?: string | null; version?: string | null; model?: string | null; searchValues?: unknown[]; [key: string]: unknown }
const unknown = (value: unknown) => value == null || value === '' ? '未知' : String(value);
@customElement('resource-metrics-table')
export class ResourceMetricsTable extends LitElement {
  @property() resourceType = 'instance';
  @property({ attribute: false }) entries: ResourceEntry[] = [];
  @property({ attribute: false }) columns: Column[] = [];
  @property() search = '';
  @property({ type: Number }) refreshVersion = 0;
  openColumnSettings() { this.columnsOpen = true; }
  async focusEditAction(id: number) {
    await this.updateComplete;
    const layout = '.desktop-resources';
    await Promise.all([...this.renderRoot.querySelectorAll<LitElement>(`${layout} app-data-table`)].map(table => table.updateComplete));
    this.renderRoot.querySelector<HTMLButtonElement>(`${layout} [data-resource-edit-id="${id}"]`)?.focus();
  }
  @state() private columnsOpen = false;
  @state() private observations = new Map<number, OverviewItem>();
  private observationGeneration = 0;
  private previousSearch = '';
  @state() private page = 1;
  @state() private rows = new Map<number, MetricRow>();
  @state() private pending = false;
  private generation = 0;
  private identity = '';
  private pageSize = 20;
  private readonly selectionChanged = () => this.requestUpdate();
  private bulkResource(entry: ResourceEntry): BulkResource {
    return { type: this.resourceType as BulkResource['type'], id: entry.id,
      label: String(entry.searchValues?.find(value => typeof value === 'string' && value.length) ?? `${this.resourceType} #${entry.id}`) };
  }
  private restoredType = '';
  private readonly accessChanged = () => {
    this.generation++; this.observationGeneration++; this.observations = new Map();
    this.rows = new Map(this.entries.map(entry => [entry.id, { state: 'forbidden' as const }]));
    this.setPending(false);
  };
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.accessChanged);
    window.addEventListener('slide-session-expired', this.accessChanged);
    window.addEventListener('slide-bulk-selection-changed', this.selectionChanged);
    window.addEventListener('keydown', this.fullValueKeydown);
    window.addEventListener('resize', this.positionFullValue);
    window.addEventListener('scroll', this.positionFullValue, true);
  }
  private restorePreferences() {
    if (this.restoredType === this.resourceType) return;
    this.restoredType = this.resourceType;
    try {
      const saved = JSON.parse(sessionStorage.getItem(`resource-list:${this.resourceType}`) ?? 'null');
      if (saved) { this.page = Math.max(1, Number(saved.page) || 1); this.hiddenColumns = Array.isArray(saved.hiddenColumns) && saved.densityVersion === 2 ? saved.hiddenColumns : this.defaultHiddenColumns; }
    } catch { /* Storage may be unavailable; navigation still works. */ }
  }
  private get defaultHiddenColumns() { return ['type', 'site', 'binding', 'database_size', 'uptime', 'disk', 'network', 'interfaces']; }
  @state() private hiddenColumns: string[] = this.defaultHiddenColumns;
  override updated(changed: PropertyValues) {
    if (!this.isConnected) return;
    this.restorePreferences();
    try { sessionStorage.setItem(`resource-list:${this.resourceType}`, JSON.stringify({ page: this.page, hiddenColumns: this.hiddenColumns, densityVersion: 2 })); } catch { /* Optional preference storage. */ }
    const identity = `${this.resourceType}:${this.entries.map(e => [e.id, e.type, e.version, e.model].join(':')).join(',')}`;
    const entriesChanged = identity !== this.identity;
    const searchChanged = this.search !== this.previousSearch;
    this.previousSearch = this.search;
    if (searchChanged) this.page = 1;
    if (entriesChanged) { this.identity = identity; this.rows = new Map(); }
    if (entriesChanged || changed.has('refreshVersion')) void this.loadObservations();
    if (entriesChanged || searchChanged || changed.has('refreshVersion')) void this.load(changed.has('refreshVersion'));
  }
  override disconnectedCallback() {
    this.generation++; this.observationGeneration++; this.setPending(false);
    window.removeEventListener('slide-permissions-loaded', this.accessChanged);
    window.removeEventListener('slide-session-expired', this.accessChanged);
    window.removeEventListener('slide-bulk-selection-changed', this.selectionChanged);
    window.removeEventListener('keydown', this.fullValueKeydown);
    window.removeEventListener('resize', this.positionFullValue);
    window.removeEventListener('scroll', this.positionFullValue, true);
    this.closeFullValue();
    super.disconnectedCallback();
  }
  private async loadObservations() {
    if (this.resourceType === 'instance') return; // Database health also checks credential/configuration state in its page.
    const generation = ++this.observationGeneration;
    this.observations = new Map();
    try {
      const response = await authFetch('/api/resources/overview', { signal: AbortSignal.timeout(15000) });
      if (!response.ok) return;
      const body = await response.json();
      if (generation !== this.observationGeneration) return;
      this.observations = new Map((Array.isArray(body.items) ? body.items as OverviewItem[] : [])
        .filter(item => item.resource?.type === this.resourceType && Array.isArray(item.gaps))
        .map(item => [item.resource.id, item]));
    } catch { /* Missing observation evidence must remain unknown. */ }
  }
  private value(text: unknown, description = unknown(text)) {
    const full = description;
    return html`<span class="cell-value" tabindex="0" title=${full} aria-label=${full}><span class="truncated">${unknown(text)}</span><span class="full-value" aria-hidden="true">${full}</span></span>`;
  }
  private fullValue: HTMLElement | null = null;
  private fullValueSource: HTMLElement | null = null;
  private closeFullValue = () => {
    this.fullValue?.hidePopover();
    this.fullValue = this.fullValueSource = null;
  };
  private showFullValue(event: Event) {
    const source = (event.target as Element).closest<HTMLElement>('.cell-value, .resource-name');
    const focusedSource = this.shadowRoot?.activeElement?.closest('.cell-value, .resource-name');
    if (event.type === 'mouseover' && focusedSource && focusedSource !== source) return;
    const value = source?.querySelector<HTMLElement>('.full-value');
    if (!source || !value || this.fullValue === value) return;
    this.closeFullValue();
    // Native top-layer rendering escapes the table's overflow without moving
    // the DOM or focus. The original accessible name remains on the cell.
    value.popover = 'manual';
    value.showPopover();
    this.fullValue = value;
    this.fullValueSource = source;
    this.positionFullValue();
  }
  private positionFullValue = () => {
    const value = this.fullValue, source = this.fullValueSource;
    if (!value || !source) return;
    if (!source.isConnected) { this.closeFullValue(); return; }
    const anchor = source.getBoundingClientRect();
    // Horizontal scrolling may finish after keyboard focus has entered a cell.
    // Keep its full value readable and clamp it to the viewport.
    if (anchor.bottom <= 0 || anchor.top >= innerHeight) {
      this.closeFullValue(); return;
    }
    const gap = parseFloat(getComputedStyle(value).paddingTop);
    const bounds = value.getBoundingClientRect();
    const left = Math.max(gap, Math.min(anchor.left, innerWidth - bounds.width - gap));
    // Keep the surfaces adjacent so the pointer can enter the full value
    // without crossing a dismissal gap. The gap only bounds the viewport.
    const top = anchor.bottom + bounds.height <= innerHeight - gap ? anchor.bottom :
      Math.max(gap, anchor.top - bounds.height);
    value.style.left = `${left}px`;
    value.style.top = `${top}px`;
  };
  private leaveFullValue(event: FocusEvent | MouseEvent) {
    const source = this.fullValueSource;
    if (!source || source.contains(event.relatedTarget as Node | null)) return;
    // Pointer movement must not dismiss a keyboard user's current value.
    if (event.type === 'mouseout' && source.contains(this.shadowRoot?.activeElement ?? null)) return;
    this.closeFullValue();
  }
  private fullValueKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.fullValue) {
      event.preventDefault(); event.stopPropagation(); this.closeFullValue();
    }
  };
  private health(entry: ResourceEntry) {
    const item = this.observations.get(entry.id);
    const age = item ? freshness(item) : 'missing';
    const state = item ? runState(item) : 'unknown';
    const label = ({ normal: '健康', abnormal: '异常', unavailable: '不可用', unknown: '未知' })[state];
    const text = `${label}${age === 'stale' ? ' · 已过期' : ''}`;
    const full = `${text}；观测 ${evidenceTime(item?.observedAt)}；${evidenceTimeState(item?.observedAt)}`;
    return html`<span class="cell-value" tabindex="0" title=${full} aria-label=${full}><span class="truncated"><app-badge variant=${state === 'normal' ? 'ok' : state === 'unknown' ? 'muted' : 'danger'}>${text}</app-badge></span><span class="full-value" aria-hidden="true">${full}</span></span>`;
  }
  private get terms() { return this.search.trim().toLowerCase().split(/\s+/).filter(Boolean); }
  private isCollectionTerm(term: string) {
    return Object.entries(collectionLabels).some(([key, label]) => key !== 'loading' && (label.toLowerCase().includes(term) || key.includes(term)));
  }
  private matchesEntry(entry: ResourceEntry, term: string) {
    return [unknown(entry.type), unknown(entry.version), ...(this.resourceType === 'network_device' ? [unknown(entry.model)] : []), ...(entry.searchValues ?? [])]
      .some(value => String(value ?? '').toLowerCase().includes(term));
  }
  private get searchesCollection() { return this.terms.some(term => this.isCollectionTerm(term)); }
  private get candidates() {
    return this.entries.filter(entry => this.terms.every(term => this.matchesEntry(entry, term) || this.isCollectionTerm(term)));
  }
  private get filtered() {
    return this.candidates.filter(entry => this.terms.every(term => {
      const state = this.rows.get(entry.id)?.state;
      return this.matchesEntry(entry, term) || Boolean(state && [state, collectionLabels[state]].some(value => value?.toLowerCase().includes(term)));
    }));
  }
  private get visible() { const filtered = this.filtered; const page = Math.min(this.page, Math.max(1, Math.ceil(filtered.length / this.pageSize))); return filtered.slice((page - 1) * this.pageSize, page * this.pageSize); }
  async load(force = false) {
    const generation = ++this.generation;
    const type = this.resourceType;
    const targets = this.searchesCollection ? this.candidates : this.visible;
    this.page = Math.min(this.page, Math.max(1, Math.ceil(this.filtered.length / this.pageSize)));
    const queue = targets.filter(e => force || !this.rows.has(e.id));
    this.setPending(queue.length > 0);

    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length && generation === this.generation) {
        const entry = queue[cursor++];
        let row: MetricRow;
        try {
          const response = await authFetch('/api/metrics/query', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resource: { type, id: entry.id }, view: 'core', ...(type === 'instance' ? { latest_capacity: true } : {}) }) });
          if (!response.ok) row = { state: response.status === 403 || response.status === 401 ? 'forbidden' : response.status === 404 ? 'unavailable' : 'query_failed' };
          else {
            const result: SemanticResult = await response.json();
            row = { result, state: collectionState(result) };
          }
        } catch { row = { state: 'query_failed' }; }
        if (generation !== this.generation) return;
        if (!['forbidden', 'unavailable'].includes(row.state)) {
          try {
            const collection = await readCollectionStatus(type, entry.id);
            row.collection = collection; row.lastSuccess = collection.collection.last_success_at ?? undefined;
          } catch (e) {
            if (e instanceof Error && ['401', '403', '404'].includes(e.message)) row = { state: e.message === '404' ? 'unavailable' : 'forbidden' };
            else { row.bindingError = '绑定状态暂不可用'; row.timeUnavailable = true; }
          }
        }
        if (generation !== this.generation) return;
        this.rows = new Map(this.rows).set(entry.id, row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    if (generation === this.generation) this.setPending(false);
  }
  private setPending(value: boolean) {
    this.pending = value;
    this.dispatchEvent(new CustomEvent('resource-metrics-loading', { detail: value, bubbles: true, composed: true }));
  }
  private metric(entry: ResourceEntry, id: string) {
    const row = this.rows.get(entry.id);
    return html`<button class="btn-ghost" @click=${() => {
      const url = new URL(location.href); url.searchParams.set('metricResource', `${this.resourceType}:${entry.id}`); url.searchParams.set('metric', id);
      if (row?.result) { url.searchParams.set('metricFrom', row.result.window.from); url.searchParams.set('metricTo', row.result.window.to); }
      window.history.replaceState(window.history.state, '', url);
      this.dispatchEvent(new CustomEvent('resource-metric-open', { detail: { id: entry.id, metric: id }, bubbles: true, composed: true }));
    }}>${row ? row.result ? id === 'host.filesystem.used_bytes' ? diskSummary(row.result) : metricSummary(row.result, id, row.collection) : collectionLabels[row.state] : '正在读取'}</button>`;
  }
  @state() private sizeHelpOpen = false;
  private databaseSize(entry: ResourceEntry) {
    const row = this.rows.get(entry.id), metric = databaseSizeMetric(row?.result);
    const summary = !row ? '正在读取' : !row.result ? collectionLabels[row.state] : databaseSizeSummary(row.result, row.collection);
    const full = `${summary}；采集 ${evidenceTime(metric?.observed_at)}；${metric?.definition.meaning ?? '容量支持范围见列标题说明'}`;
    return html`${this.value(summary, full)}${metric?.observed_at ? html`<time class="size-observed" datetime=${metric.observed_at} aria-label=${`数据量采集时间 ${evidenceTime(metric.observed_at)}`}></time>` : nothing}`;
  }
  render() {
    const metricColumns = this.resourceType === 'instance' ? [{ key: 'database_size', label: '数据库大小', help: '支持范围与统计口径' }, { key: 'uptime', label: '运行时长' }] : this.resourceType === 'server'
      ? [{ key: 'disk', label: '磁盘（挂载点）' }, { key: 'network', label: '网络速率（逐接口）' }]
      : [{ key: 'interfaces', label: '接口摘要' }];
    const baseKeys = new Set(['bulk_select', 'row_number', ...this.columns.map(c => c.key), 'collection', 'last_collection']);
    const optionalColumns = [...metricColumns, { key: 'binding', label: '模板绑定' }].filter(c => !baseKeys.has(c.key));
    const extraColumns = optionalColumns.filter(c => !this.hiddenColumns.includes(c.key));
    const columns = [{ key: 'bulk_select', label: '选择', width: '2.5rem' }, { key: 'row_number', label: '序号', width: '3.5rem' }, ...this.columns.filter(c => c.key !== 'actions'), { key: 'collection', label: '采集状态', width: '8rem' }, { key: 'last_collection', label: '最近采集时间', width: '10.5rem' }, ...this.columns.filter(c => c.key === 'actions'), ...extraColumns];
    const offset = (Math.min(this.page, Math.max(1, Math.ceil(this.filtered.length / this.pageSize))) - 1) * this.pageSize;
    const rows = this.visible.map((entry, index) => {
      const row = this.rows.get(entry.id);
      const ref = this.bulkResource(entry);
      return { ...entry, bulk_select: html`<input type="checkbox" aria-label=${`选择${ref.label}用于批量绑定`} .checked=${bulkSelection.has(ref)} .disabled=${!bulkSelection.has(ref) && bulkSelection.values().length >= 100} @change=${() => bulkSelection.toggle(ref)}>`, row_number: offset + index + 1, ...(['forbidden', 'unavailable'].includes(row?.state ?? '') ? { cpu: '无可用权限或资源', memory: '无可用权限或资源', capacity: '无可用权限或资源' } : {}), type: unknown(entry.type), version: this.value(entry.version), model: this.value(entry.model), address: this.value(entry.address), ...(this.resourceType !== 'instance' ? { health: this.health(entry) } : {}),
        database_size: this.databaseSize(entry), uptime: this.metric(entry, 'db.uptime_seconds'), disk: this.metric(entry, 'host.filesystem.used_bytes'),
        network: this.metric(entry, 'host.network.bytes_total'), interfaces: this.metric(entry, 'network.interface.oper_up'),
        binding: html`<span>${row?.collection ? statusLabel(row.collection.binding.state) : row?.bindingError || (row ? ['forbidden', 'unavailable'].includes(row.state) ? collectionLabels[row.state] : '绑定状态未知' : '正在读取')}</span>`,
        collection: this.value(row?.bindingError ? '当前采集状态暂不可用' : row?.collection?.blockers.length ? row.collection.blockers.map(b => statusLabel(b)).join('；') : row?.collection?.effective_enabled.enabled === false ? '已停用' : row?.collection?.binding.application === 'failed' ? '应用失败' : row?.collection ? statusLabel(row.collection.collection.in_flight ? 'running' : row.collection.collection.state) : collectionLabels[row?.state ?? 'loading'] ?? '待验证'),
        last_collection: row?.lastSuccess && Number.isFinite(Date.parse(row.lastSuccess)) ? html`<time datetime=${row.lastSuccess}>${this.value(new Date(row.lastSuccess).toLocaleString('zh-CN'))}</time>` : this.value(row?.timeUnavailable ? '时间暂不可用' : '无成功采集记录') };
    });
    const selected = bulkSelection.values().length;
    return html`<style>${sharedBtnStyles}
      :host { display:block; box-sizing:border-box; min-width:0; max-width:100%; padding:var(--space-lg); color:var(--text); } .pages { display:flex; gap:var(--space-sm); flex-wrap:wrap; align-items:center; margin:0 0 var(--space-md); } .pages { margin:var(--space-md) 0 0; } @media(max-width:640px) { :host { padding:var(--space-md); } }
      .scroll { max-width:100%; overflow:auto; border:1px solid var(--border); border-radius:var(--radius-sm); }
      app-data-table .data-table { table-layout:fixed; }
      app-data-table .data-table th, app-data-table .data-table td { white-space:nowrap; vertical-align:middle; }
      .actions { display:flex; gap:var(--space-xs); flex-wrap:nowrap; align-items:center; }
      .actions > button { white-space:nowrap; flex-shrink:0; }
      .cell-value, .resource-name { display:block; position:relative; min-width:0; max-width:100%; }
      .truncated, .resource-name > button { display:block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; box-sizing:border-box; }
      .resource-name > button { font-weight:600; }
      .full-value { display:none; position:fixed; inset:auto; margin:0; width:max-content; box-sizing:border-box; max-width:min(26rem,calc(100vw - 2 * var(--space-md))); max-height:calc(100dvh - 2 * var(--space-md)); overflow:auto; white-space:normal; overflow-wrap:anywhere; padding:var(--space-sm); background:var(--bg-elevated); color:var(--text-strong); border:1px solid var(--border); border-radius:var(--radius-sm); box-shadow:var(--shadow-md); font-size:var(--text-sm); }
      .full-value:popover-open { display:block; }
      .column-choice { display:flex; align-items:center; gap:var(--space-sm); padding-block:var(--space-xs); }
      small { display:block; color:var(--muted); }
      :focus-visible { outline:2px solid var(--text-strong); outline-offset:2px; }
      .scroll app-data-table .column-help:focus-visible { outline:2px solid var(--text-strong); outline-offset:2px; }
      .bulk-tools { margin:0 0 var(--space-md); }
      .scroll-hint { color:var(--muted); font-size:var(--text-sm); margin:0 0 var(--space-sm); }
      @media(max-width:640px) { :host { padding:var(--space-sm) var(--space-md); } .actions > button, .bulk-tools button { min-height:44px; box-sizing:border-box; } }

    </style>
    ${this.resourceType === 'instance' ? html`<app-dialog .open=${this.sizeHelpOpen} size="lg" title="数据库大小：支持范围与统计口径" @app-dialog-close=${() => { this.sizeHelpOpen = false; }}>
      <p>单位使用 B / KiB / MiB / GiB（1024 进制）。读取最近一次已发布采集结果；刷新和翻页只读取指标存储。过期值保留并标注采集时间。</p>
      <p>MySQL 5.7 / 8.0 / 8.4：可见非系统库的表 data_length + index_length，属于估算分配空间；受账号元数据可见范围限制。</p>
      <p>PostgreSQL 16.4：当前连接数据库的 pg_database_size，包含物理文件，保留数据库名称维度。</p>
      <p>Oracle 19.3 / 达梦 8.1：当前容器/数据库 DBA_DATA_FILES 的永久数据文件已分配空间（包含系统表空间），不含临时文件、日志与备份；需查询该视图的权限。</p>
      <p>其他引擎暂不支持。Redis 内存不计为磁盘大小。版本与权限需通过采集验证；未配置时请在指标配置中选择包含容量的采集包并按现有流程发布。Oracle/达梦和 MySQL 基础包的容量能力从 1.1.0 起提供。</p>
      <div slot="footer"><button class="btn" @click=${() => { this.sizeHelpOpen = false; }}>关闭</button></div>
    </app-dialog>` : nothing}
    <app-dialog .open=${this.columnsOpen} size="sm" title="列设置" @app-dialog-close=${() => { this.columnsOpen = false; }}>
      <p>${this.resourceType === 'instance' ? '九' : '八'}个业务列始终显示。可按需增加指标列；窄屏左右滚动查看。</p>
      ${optionalColumns.map(c => html`<label class="column-choice"><input type="checkbox" .checked=${!this.hiddenColumns.includes(c.key)} @change=${(e: Event) => { this.hiddenColumns = (e.target as HTMLInputElement).checked ? this.hiddenColumns.filter(k => k !== c.key) : [...this.hiddenColumns, c.key]; }}>${c.label}</label>`)}
      <div slot="footer"><button class="btn" @click=${() => { this.hiddenColumns = this.defaultHiddenColumns; }}>恢复默认</button> <button class="btn-primary" @click=${() => { this.columnsOpen = false; }}>完成</button></div>
    </app-dialog>
    ${this.pending && this.searchesCollection ? html`<p role="status">正在检查全部搜索资源的采集状态，结果尚未完整。</p>` : nothing}
    <div class="pages bulk-tools" aria-label="批量采集配置">${selected ? html`<span role="status">已选 ${selected} 个对象（可跨类型，最多 100 个）</span>` : nothing}
      <button class="btn" @click=${() => { const refs = this.visible.map(entry => this.bulkResource(entry)); const all = refs.every(ref => bulkSelection.has(ref)); refs.filter(ref => all || !bulkSelection.has(ref)).forEach(ref => bulkSelection.toggle(ref)); }}>${this.visible.length && this.visible.every(entry => bulkSelection.has(this.bulkResource(entry))) ? '取消当前页' : '选择当前页'}</button>
      ${selected ? html`
      <button class="btn" .disabled=${!bulkSelection.values().length} @click=${() => { bulkSelection.clear(); void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>('.bulk-tools button')?.focus()); }}>清空选择</button>
      <button class="btn-primary" .disabled=${!bulkSelection.values().length} @click=${() => this.renderRoot.querySelector<MetricBulkDialog>('metric-bulk-dialog')?.show(bulkSelection.values())}>批量绑定采集模板</button>` : nothing}
      <button class="btn-ghost" @click=${() => this.renderRoot.querySelector<MetricBulkDialog>('metric-bulk-dialog')?.show([])}>查看批量任务</button></div>
    <metric-bulk-dialog></metric-bulk-dialog>
    <div class="desktop-resources"><p class="scroll-hint" id="resource-scroll-help">左右滚动查看全部列；也可聚焦表格后按左右方向键。聚焦截断内容可查看全文。</p><div class="scroll" @scroll=${this.positionFullValue} @focusin=${this.showFullValue} @focusout=${this.leaveFullValue} @mouseover=${this.showFullValue} @mouseout=${this.leaveFullValue} role="region" tabindex="0" aria-label="资源表格，可横向滚动" aria-describedby="resource-scroll-help"><app-data-table style=${`min-width:${(this.resourceType === 'instance' ? 72 : 68) + extraColumns.length * 12}rem`} @app-table-column-help=${() => { this.sizeHelpOpen = true; }} .striped=${false} .dense=${true} .columns=${columns} .rows=${rows} emptyMessage="没有符合条件的资源"></app-data-table></div></div>
    <div class="pages"><span>筛选结果 ${this.filtered.length} / ${this.entries.length}</span><button class="btn" .disabled=${this.page <= 1} @click=${() => { this.page--; void this.load(); }}>上一页</button><span>第 ${Math.min(this.page, Math.max(1, Math.ceil(this.filtered.length / this.pageSize)))} 页</span><button class="btn" .disabled=${this.page * this.pageSize >= this.filtered.length} @click=${() => { this.page++; void this.load(); }}>下一页</button></div>`;
  }
}
