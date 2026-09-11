import { LitElement, html, nothing } from 'lit';
import { live } from 'lit/directives/live.js';
import { customElement, state } from 'lit/decorators.js';
import * as echarts from 'echarts';
import { authFetch } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { t, I18nController } from '../../i18n/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { permissionMatches } from '../settings-navigation.js';
import { dashboardStyles } from './dashboard-styles.js';
import { collectionRisk, compareRisk, freshness, isRisk, latestMetric, metricConfig, resourceKey, resourceTypes, runState, scopedItems, summarize, usableMetric, type Overview, type OverviewItem, type Ref, type ResourceType, type RunState, type Scope } from './dashboard-model.js';
import '../components/app-card.js';
import '../components/app-badge.js';
import '../components/app-data-table.js';
import '../components/app-empty-state.js';
import '../components/app-form-field.js';
import '../../../components/stat-card.js';
const o = (key: string) => t(`operationsOverview.${key}`);
const stateVariant = { normal: 'ok', abnormal: 'warn', unavailable: 'danger', unknown: 'muted' };
type DetailFilter = '' | RunState | 'alerts' | 'collection' | 'fresh' | 'risk' | 'attention';
interface Capacity { current_total_gb: number | null; trend: Array<{ time: string; total_size_gb: number | null; instance_count?: number }> }

@customElement('dashboard-page')
export class DashboardPage extends LitElement {
  static override styles = [sharedBtnStyles, dashboardStyles];
  private readonly _i18n = new I18nController(this);
  @state() private resourceOverview: Overview | null = null;
  @state() private resourceScope: Scope = 'all';
  @state() private search = '';
  @state() private engine = '';
  @state() private detailFilter: DetailFilter = '';
  @state() private detailType: ResourceType | '' = '';
  @state() private page = 1;
  @state() private selectedRisk = '';
  @state() private loading = false;
  @state() private error = '';
  @state() private permissions = new Set<string>();
  @state() private selectedMetric = '';
  @state() private selectedInstanceId: number | null = null;
  @state() private selectedHours = 168;
  @state() private customDates = false;
  @state() private startDate = '';
  @state() private endDate = '';
  @state() private capacityTrend: Capacity | null = null;
  @state() private trendLoading = false;
  @state() private trendError = '';
  @state() private trendTime = '';
  @state() private backupDevice: number | null = null;
  @state() private backup: { collectedAt: string; versionNo: number; redactionStatus: string } | null = null;
  @state() private backupMessage = '';
  @state() private backupLoading = false;
  private backupVersion = 0;
  private overviewVersion = 0;
  private trendVersion = 0;
  private trendQuery = '';
  private trendCache = new Map<string, { data: Capacity; time: string }>();
  private chart: echarts.EChartsType | null = null;
  private resize: ResizeObserver | null = null;
  private trendElement: Element | null = null;
  private restorePosition = true;
  private readonly onPopState = () => { this.readUrl(); void this.loadTrend(); };
  private readonly onPermissions = () => this.readPermissions();

  override connectedCallback() {
    super.connectedCallback(); this.readPermissions(); this.readUrl();
    window.addEventListener('popstate', this.onPopState);
    window.addEventListener('slide-permissions-loaded', this.onPermissions);
    void this.loadDashboardData();
  }
  override disconnectedCallback() {
    this.overviewVersion++; this.trendVersion++; this.backupVersion++; this.disposeChart();
    window.removeEventListener('popstate', this.onPopState);
    window.removeEventListener('slide-permissions-loaded', this.onPermissions);
    super.disconnectedCallback();
  }
  private readPermissions() {
    try { this.permissions = new Set(JSON.parse(localStorage.getItem('permissions') ?? '[]')); } catch { this.permissions = new Set(); }
  }
  private readUrl() {
    const params = new URL(location.href).searchParams;
    const scope = params.get('scope') ?? 'all';
    this.resourceScope = ['all', ...resourceTypes].includes(scope) ? scope as Scope : 'all';
    this.search = (params.get('q') ?? '').slice(0, 200);
    this.engine = this.resourceScope === 'instance' ? (params.get('engine') ?? '').slice(0, 64) : '';
    const filter = params.get('state') ?? '';
    this.detailFilter = ['', 'normal', 'abnormal', 'unavailable', 'unknown', 'alerts', 'collection', 'fresh', 'risk', 'attention'].includes(filter) ? filter as DetailFilter : '';
    const detailType = params.get('detailType');
    this.detailType = resourceTypes.includes(detailType as ResourceType) ? detailType as ResourceType : '';
    const page = Number(params.get('page'));
    this.page = Number.isSafeInteger(page) && page > 0 ? Math.min(page, 500) : 1;
    const hours = Number(params.get('hours'));
    this.selectedHours = [24, 168, 720].includes(hours) ? hours : 168;
    const id = Number(params.get('capacityInstance'));
    this.selectedInstanceId = Number.isSafeInteger(id) && id > 0 ? id : null;
    this.startDate = params.get('start') ?? ''; this.endDate = params.get('end') ?? '';
    this.customDates = this.validDates();
    if (!this.customDates) { this.startDate = ''; this.endDate = ''; }
    this.selectedRisk = params.get('risk') ?? '';
  }
  private saveUrl() {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({ scope: this.resourceScope, q: this.search, engine: this.engine, state: this.detailFilter, detailType: this.detailType, page: this.page > 1 ? String(this.page) : '', hours: String(this.selectedHours), capacityInstance: this.selectedInstanceId ? String(this.selectedInstanceId) : '', start: this.customDates ? this.startDate : '', end: this.customDates ? this.endDate : '', risk: this.selectedRisk })) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    history.replaceState(history.state, '', url);
  }
  private async loadDashboardData() {
    const version = ++this.overviewVersion;
    this.loading = true; this.error = '';
    try {
      const response = await authFetch('/api/resources/overview');
      if (!response.ok) { if (response.status === 403 && version === this.overviewVersion) this.resourceOverview = null; throw new Error(response.status === 403 ? o('permission') : `${o('unavailableData')} (${response.status})`); }
      const data = await response.json();
      if (!Array.isArray(data.items)) throw new Error(o('unavailableData'));
      if (version !== this.overviewVersion) return;
      for (const item of data.items as OverviewItem[]) {
        const previous = this.resourceOverview?.items.find(old => resourceKey(old.resource) === resourceKey(item.resource));
        if (item.gaps.includes('ALERTS_UNAVAILABLE') && previous) {
          item.unresolvedAlerts = previous.unresolvedAlerts; item.alertIds = previous.alertIds; item.alertSeverity = previous.alertSeverity; item.alertsObservedAt = previous.alertsObservedAt;
        } else if (!item.gaps.includes('ALERTS_UNAVAILABLE')) item.alertsObservedAt = data.collectedAt;
      }
      const unavailable = data.unavailableTypes ?? [];
      if (unavailable.length) {
        data.items = [...data.items, ...(this.resourceOverview?.items ?? []).filter(item => unavailable.includes(item.resource.type))];
        this.error = `${unavailable.map((type: string) => o(type)).join(' / ')}: ${o('unavailableData')}`;
      }
      this.resourceOverview = data;
      this.normalizeSelection();
      await this.loadTrend();
    } catch (error) { if (version === this.overviewVersion) this.error = error instanceof Error ? error.message : o('failure'); }
    finally { if (version === this.overviewVersion) this.loading = false; }
  }
  private normalizeSelection() {
    const databases = this._visibleResourceItems().filter(item => item.resource.type === 'instance');
    if (!databases.some(item => item.resource.id === this.selectedInstanceId)) this.selectedInstanceId = databases[0]?.resource.id ?? null;
  }
  private _visibleResourceItems() { return scopedItems(this.resourceOverview, this.resourceScope, this.search, this.engine); }
  private switchScope(scope: Scope) {
    this.backupVersion++; this.backupLoading = false; this.backup = null; this.backupMessage = '';
    this.resourceScope = scope; this.search = ''; this.engine = ''; this.detailFilter = ''; this.detailType = ''; this.selectedRisk = ''; this.selectedMetric = ''; this.page = 1;
    this.normalizeSelection(); this.saveUrl(); void this.loadTrend();
  }
  private changeScopeFilter(event: Event, kind: 'search' | 'engine') {
    this[kind] = (event.target as HTMLInputElement).value;
    this.backupVersion++; this.backupLoading = false; this.backupDevice = null; this.backup = null; this.backupMessage = '';
    this.page = 1; this.selectedRisk = ''; this.normalizeSelection(); this.saveUrl(); void this.loadTrend();
  }
  private selectDetail(filter: DetailFilter, type: ResourceType | '' = '') { this.detailFilter = filter; this.detailType = type; this.page = 1; this.saveUrl(); }
  private clearFilters() { this.search = ''; this.engine = ''; this.selectDetail(''); this.normalizeSelection(); this.saveUrl(); void this.loadTrend(); }
  private keydownTab(event: KeyboardEvent, index: number) {
    const scopes: Scope[] = ['all', ...resourceTypes];
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : event.key === 'ArrowRight' ? (index + 1) % 4 : event.key === 'ArrowLeft' ? (index + 3) % 4 : -1;
    if (next < 0) return;
    event.preventDefault(); this.switchScope(scopes[next]);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>(`#scope-${scopes[next]}`)?.focus());
  }
  private icon(type: Scope) { return type === 'all' ? icons['layout-dashboard'] : type === 'instance' ? icons.database : type === 'server' ? icons.server : icons.network; }
  private label(item: OverviewItem) { return item.label.trim() || `${o(item.resource.type)} #${item.resource.id}`; }
  private time(value: string | null) {
    const stamp = Date.parse(value ?? '');
    if (!Number.isFinite(stamp)) return o('unknown');
    if (stamp > Date.now()) return o('timeInvalid');
    return new Date(stamp).toLocaleString();
  }
  private detailHref(ref: Ref, diagnosis = false) {
    const url = new URL(diagnosis ? '/resource-diagnosis' : ref.type === 'instance' ? '/instance-detail' : ref.type === 'server' ? '/server-detail' : '/network-device-detail', location.origin);
    if (diagnosis) { url.searchParams.set('resourceType', ref.type); url.searchParams.set('resourceId', String(ref.id)); }
    else url.searchParams.set(ref.type === 'network_device' ? 'networkDeviceId' : 'id', String(ref.id));
    url.searchParams.set('returnTo', '/dashboard' + location.search);
    return url.pathname + url.search;
  }
  private scrollingParent(): Element {
    let node: Element | null = this;
    while (node) {
      if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
      node = node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
    }
    return document.scrollingElement ?? document.documentElement;
  }
  private savePosition() { try { sessionStorage.setItem('slide.overview.scroll', String(this.scrollingParent().scrollTop)); } catch { /* Storage is optional. */ } }
  private renderActions(item: OverviewItem) {
    return html`<div class="actions"><a class="btn-ghost" href=${this.detailHref(item.resource)} @click=${this.savePosition}>${o('viewResource')}</a><a class="btn-ghost" href=${this.detailHref(item.resource, true)} @click=${this.savePosition}>${o('evidence')}</a>${permissionMatches(this.permissions, 'ai:manage') ? html`<a class="btn-ghost" href=${this.detailHref(item.resource, true)} @click=${this.savePosition}>${o('diagnose')}</a>` : html`<button class="btn-ghost" .disabled=${true} title=${o('noAi')}>${o('diagnose')}</button>`}</div>`;
  }
  private renderState(item: OverviewItem) { const state = runState(item); return html`<app-badge variant=${stateVariant[state]} title=${`${o('previous')}: ${item.status}`}>${o(state === 'unavailable' && item.resource.type === 'network_device' ? 'unreachable' : state)}</app-badge>`; }
  private renderFreshness(item: OverviewItem) { const value = freshness(item); return html`<app-badge variant=${value === 'fresh' ? 'ok' : value === 'stale' ? 'warn' : 'muted'}>${o(value)}</app-badge>`; }
  private alertCount(item: OverviewItem) { return item.gaps.includes('ALERTS_UNAVAILABLE') ? `${o('unavailableData')}${item.alertsObservedAt ? ` (${o('retained')}: ${item.unresolvedAlerts} · ${this.time(item.alertsObservedAt)})` : ''}` : `${item.alertsTruncated ? o('atLeast') + ' ' : ''}${item.unresolvedAlerts}`; }
  private renderKpis(items: OverviewItem[]) {
    const s = summarize(items); const totalIncomplete = this.resourceOverview?.truncated || this.resourceOverview?.unavailableTypes?.some(type => this.resourceScope === 'all' || type === this.resourceScope);
    const cards = [
      { label: o(this.resourceScope === 'all' ? 'resources' : this.resourceScope === 'instance' ? 'instances' : this.resourceScope), value: `${totalIncomplete ? o('atLeast') + ' ' : ''}${s.total}`, hint: o('dedup'), filter: '' },
      { label: o(this.resourceScope === 'server' ? 'unavailableServers' : this.resourceScope === 'network_device' ? 'unreachableDevices' : this.resourceScope === 'instance' ? 'abnormalInstances' : 'abnormalResources'), value: `${totalIncomplete || s.alertsUnavailable ? o('atLeast') + ' ' : ''}${['server', 'network_device'].includes(this.resourceScope) ? s.unavailable : s.abnormal}`, hint: o('dedup'), filter: ['server', 'network_device'].includes(this.resourceScope) ? 'unavailable' : 'attention' },
      { label: o('alerts'), value: s.alertsUnavailable ? '—' : `${s.alertsIncomplete || totalIncomplete ? o('atLeast') + ' ' : ''}${s.alerts}`, hint: o(s.alertsUnavailable ? 'alertUnavailable' : 'acknowledged'), filter: 'alerts' },
      { label: o(this.resourceScope === 'all' ? 'collectionRisk' : 'coverage'), value: this.resourceScope === 'all' ? `${totalIncomplete ? o('atLeast') + ' ' : ''}${s.collection}` : !s.total || totalIncomplete ? '—' : `${Math.round(s.fresh / s.total * 100)}%`, hint: `${o('freshCoverage')} ${s.fresh}/${s.total}`, filter: this.resourceScope === 'all' ? 'collection' : 'fresh' },
    ];
    return html`<div class="dashboard__stat-cards">${cards.map(card => html`<stat-card tabindex="0" role="button" aria-label=${`${card.label} ${card.value}`} .label=${card.label} .value=${card.value} .hint=${card.hint} @click=${() => this.selectDetail(card.filter as DetailFilter)} @keydown=${(event: KeyboardEvent) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); this.selectDetail(card.filter as DetailFilter); } }}></stat-card>`)}</div>`;
  }
  private renderRiskQueue(items: OverviewItem[]) {
    const risks = items.filter(isRisk).sort(compareRisk);
    return html`<app-card><div slot="header" class="toolbar"><h2>${o('riskQueue')} · ${risks.length}</h2><button class="btn-ghost" @click=${() => { this.selectDetail('risk'); this.renderRoot.querySelector('#resource-details')?.scrollIntoView({ block: 'start' }); }}>${o('allRisks')}</button></div>
      <small>${o('topFive')}</small>${risks.slice(0, 5).map(item => html`<article class="risk-row" data-resource=${resourceKey(item.resource)}>
        <div class="actions"><span aria-hidden="true">${this.icon(item.resource.type)}</span><a class="resource-name" href=${this.detailHref(item.resource)} @click=${this.savePosition}>${this.label(item)}</a>${this.renderState(item)}${this.renderFreshness(item)}</div>
        <div class="metadata"><span>${item.gaps.includes('ALERTS_UNAVAILABLE') ? o('alertUnavailable') : item.unresolvedAlerts ? `${o('alerts')}: ${this.alertCount(item)}` : o(runState(item) === 'unavailable' ? 'unavailable' : freshness(item) === 'fresh' ? 'qualityGap' : freshness(item))}</span><time title=${item.observedAt ?? ''}>${o('observed')}: ${this.time(item.observedAt)}</time><button class="btn-ghost" @click=${() => { this.selectedRisk = resourceKey(item.resource); this.saveUrl(); }}>${o('relations')} ${item.gaps.includes('RELATIONS_UNAVAILABLE') ? '—' : item.impactScope.length}</button></div>
        ${this.renderActions(item)}</article>`)}
      ${!risks.length ? html`<app-empty-state title=${o(items.some(item => runState(item) === 'unknown') ? 'unknownHealth' : 'noRisks')} description=${`${o('freshCoverage')} ${summarize(items).fresh}/${items.length}`}></app-empty-state>` : nothing}
    </app-card>`;
  }
  private renderHealth(items: OverviewItem[]) {
    return html`<app-card><h2 slot="header">${o('health')}</h2>${resourceTypes.filter(type => this.resourceScope === 'all' || this.resourceScope === type).map(type => {
      const subset = items.filter(item => item.resource.type === type);
      return html`<div class="health-row"><strong>${o(type)} · ${subset.length}</strong><div class="health-bar" aria-hidden="true">${(['normal', 'abnormal', 'unavailable', 'unknown'] as RunState[]).map(state => html`<span class=${state} style=${`width:${subset.length ? subset.filter(item => runState(item) === state).length / subset.length * 100 : 0}%`}></span>`)}</div><div class="health-track">${(['normal', 'abnormal', 'unavailable', 'unknown'] as RunState[]).map(state => html`<button class=${`btn-ghost ${state}`} @click=${() => this.selectDetail(state, type)}>${o(state === 'unavailable' && type === 'network_device' ? 'unreachable' : state)} ${subset.filter(item => runState(item) === state).length}</button>`)}</div></div>`;
    })}</app-card>`;
  }
  private renderRelations(items: OverviewItem[]) {
    const selected = items.find(item => resourceKey(item.resource) === this.selectedRisk);
    return html`<app-card><h2 slot="header">${o('relations')}</h2><p>${o('relationHint')}</p>${!selected ? html`<small>${o('selectRisk')}</small>` : html`<strong>${this.label(selected)}</strong>${selected.gaps.includes('RELATIONS_UNAVAILABLE') ? html`<p>${o('relationUnavailable')}</p>` : !selected.impactScope.length ? html`<p>${o('noRelations')}</p>` : selected.impactScope.map(ref => {
      const item = this.resourceOverview?.items.find(item => resourceKey(item.resource) === resourceKey(ref));
      return html`<p><a href=${this.detailHref(ref, true)} @click=${this.savePosition}>${o(ref.type)} · ${item ? this.label(item) : '#' + ref.id}</a></p>`;
    })}<a href=${this.detailHref(selected.resource, true)} @click=${this.savePosition}>${o('evidence')}</a>`}</app-card>`;
  }
  private metricText(item: OverviewItem, metricId: string): string {
    const metric = latestMetric(item, metricId);
    if (metric?.reason?.includes('unsupported')) return o('unsupported');
    if (usableMetric(metric)) return `${Math.round(metric.value * 10) / 10}${this.unit(metricId)}`;
    if (!metric || metric.value === null) return o('missing');
    if (!['good', 'degraded'].includes(metric.quality)) return o(metric.quality === 'invalid' ? 'invalid' : 'unknown');
    return o('stale');
  }
  private unit(metric: string) { return metric.includes('temperature') ? ' °C' : ['connections', 'qps'].includes(metric) ? '' : '%'; }
  private renderMetrics(items: OverviewItem[]) {
    if (this.resourceScope === 'all') return nothing;
    const metrics = metricConfig[this.resourceScope];
    const id = metrics.includes(this.selectedMetric) ? this.selectedMetric : metrics[0];
    const groups = this.resourceScope === 'instance' ? [...new Set(items.map(item => String(item.attributes?.dbType ?? 'unknown')))] : [this.resourceScope];
    return html`<app-card><h2 slot="header">${o('metrics')}</h2><div class="filters"><app-form-field label=${o('metric')}><select aria-label=${o('metric')} .value=${id} @change=${(event: Event) => { this.selectedMetric = (event.target as HTMLSelectElement).value; }}>${metrics.map(metric => html`<option value=${metric} .selected=${live(metric === id)}>${o(metric)}</option>`)}</select></app-form-field></div>
      <p class="metadata">${o('latestOnly')} · ${o('comparable')}</p>${groups.map(group => {
        const subset = this.resourceScope === 'instance' ? items.filter(item => String(item.attributes?.dbType ?? 'unknown') === group) : items;
        const valid = subset.filter(item => usableMetric(latestMetric(item, id))).sort((a, b) => latestMetric(b, id)!.value! - latestMetric(a, id)!.value! || resourceKey(a.resource).localeCompare(resourceKey(b.resource)));
        const unsupported = subset.filter(item => latestMetric(item, id)?.reason?.includes('unsupported')).length;
        const max = /usage|percent/.test(id) ? 100 : Math.max(1, ...valid.map(item => latestMetric(item, id)!.value!));
        const aggregate = valid.reduce((sum, item) => sum + latestMetric(item, id)!.value!, 0);
        return html`<p><strong>${this.resourceScope === 'instance' ? group : o(this.resourceScope)}</strong> · ${o('effective')} ${valid.length} · ${o('unsupported')} ${unsupported} ${valid.length ? html`· ${o(['connections', 'qps'].includes(id) ? 'sum' : 'mean')} ${(aggregate / (['connections', 'qps'].includes(id) ? 1 : valid.length)).toFixed(1)}${this.unit(id)}` : nothing}</p>
          ${valid.slice(0, 5).map(item => html`<div class="metric-row"><a href=${this.detailHref(item.resource)} @click=${this.savePosition}>${this.label(item)}<br><small>${this.time(latestMetric(item, id)!.observedAt)}</small></a><meter min="0" max=${max} value=${latestMetric(item, id)!.value!} aria-label=${`${this.label(item)} ${o(id)}`}></meter><strong>${this.metricText(item, id)}</strong></div>`)}
          ${!valid.length ? html`<app-empty-state title=${o('noMetric')}></app-empty-state>` : nothing}`;
      })}${this.resourceScope === 'network_device' ? html`<p class="metadata">${o('backup')}</p>` : nothing}</app-card>`;
  }
  private async loadBackup() {
    const id = this.backupDevice ?? this._visibleResourceItems()[0]?.resource.id;
    if (!id || this.resourceScope !== 'network_device' || this.backupLoading) return;
    this.backupDevice = id; this.backupLoading = true; this.backupMessage = '';
    const version = ++this.backupVersion;
    try {
      const response = await authFetch(`/api/network-devices/${id}/config-backups`);
      if (!response.ok) throw new Error(response.status === 403 ? o('permission') : o('unavailableData'));
      const body = await response.json();
      if (!Array.isArray(body.backups)) throw new Error(o('unavailableData'));
      if (version !== this.backupVersion) return;
      this.backup = [...body.backups].sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt))[0] ?? null;
      this.backupMessage = this.backup ? '' : o('noBackup');
    } catch (error) { if (version === this.backupVersion) this.backupMessage = error instanceof Error ? error.message : o('unavailableData'); }
    finally { if (version === this.backupVersion) this.backupLoading = false; }
  }
  private renderBackups(items: OverviewItem[]) {
    if (this.resourceScope !== 'network_device') return nothing;
    const id = items.some(item => item.resource.id === this.backupDevice) ? this.backupDevice : items[0]?.resource.id;
    return html`<app-card><h2 slot="header">${o('backupTitle')}</h2><p class="metadata">${o('backupScope')}</p><div class="filters"><app-form-field label=${o('network_device')}><select aria-label=${o('backupDevice')} .value=${String(id ?? '')} @change=${(event: Event) => { this.backupVersion++; this.backupLoading = false; this.backupDevice = Number((event.target as HTMLSelectElement).value); this.backup = null; this.backupMessage = ''; }}>${items.map(item => html`<option value=${item.resource.id} .selected=${live(item.resource.id === id)}>${this.label(item)}</option>`)}</select></app-form-field><button class="btn" .disabled=${this.backupLoading} @click=${() => { this.backupDevice = id ?? null; void this.loadBackup(); }}>${o(this.backupLoading ? 'refreshing' : 'readBackup')}</button></div>
      ${this.backupMessage ? html`<p role="status">${this.backupMessage}</p>` : nothing}${this.backup && id === this.backupDevice ? html`<p>${o('savedBackup')} v${this.backup.versionNo} · ${this.time(this.backup.collectedAt)} · ${o(this.backup.redactionStatus === 'failed' ? 'backupRedactionFailed' : this.backup.redactionStatus === 'redacted' ? 'backupRedacted' : 'backupUnredacted')}</p>` : nothing}${id ? html`<a href=${this.detailHref({ type: 'network_device', id })} @click=${this.savePosition}>${o('viewResource')}</a>` : nothing}</app-card>`;
  }
  private renderDetails(items: OverviewItem[]) {
    const filtered = items.filter(item => (!this.detailType || item.resource.type === this.detailType) && (!this.detailFilter || (this.detailFilter === 'alerts' ? item.unresolvedAlerts > 0 : this.detailFilter === 'collection' ? collectionRisk(item) : this.detailFilter === 'fresh' ? freshness(item) === 'fresh' : this.detailFilter === 'risk' ? isRisk(item) : this.detailFilter === 'attention' ? ['abnormal', 'unavailable'].includes(runState(item)) : runState(item) === this.detailFilter))).sort(compareRisk);
    const pages = Math.max(1, Math.ceil(filtered.length / 10)); const page = Math.min(this.page, pages);
    const rows = filtered.slice((page - 1) * 10, page * 10).map(item => ({
      name: html`<a href=${this.detailHref(item.resource)} @click=${this.savePosition}>${this.label(item)}</a><br><small>${o(item.resource.type)} · ${item.attributes?.host ?? resourceKey(item.resource)}</small>`,
      engine: String(item.attributes?.dbType ?? '—'), model: String(item.attributes?.model ?? '—'),
      status: this.renderState(item), freshness: this.renderFreshness(item), alerts: html`<a class="btn-ghost" href=${this.detailHref(item.resource, true)} @click=${this.savePosition}>${this.alertCount(item)}</a>`,
      cpu: this.metricText(item, 'cpu_usage'), memory: this.metricText(item, 'memory_usage'), disk: this.metricText(item, 'disk_usage'),
      observed: html`<time title=${item.observedAt ?? ''}>${this.time(item.observedAt)}</time>`, actions: this.renderActions(item),
    }));
    const columns = [{ key: 'name', label: o('name') }, ...(this.resourceScope === 'instance' ? [{ key: 'engine', label: o('engine') }] : this.resourceScope === 'network_device' ? [{ key: 'model', label: o('model') }] : []), { key: 'status', label: o('runtime') }, ...(this.resourceScope === 'server' ? [{ key: 'cpu', label: 'CPU' }, { key: 'memory', label: o('memory_usage') }, { key: 'disk', label: o('disk_usage') }] : []), { key: 'freshness', label: o('collected') }, { key: 'alerts', label: o('alerts') }, { key: 'observed', label: o('observed') }, { key: 'actions', label: o('actions') }];
    return html`<app-card id="resource-details"><div slot="header" class="toolbar"><h2>${o('details')} · ${filtered.length}</h2>${this.detailFilter || this.detailType ? html`<div class="actions"><app-badge>${o('selectedFilter')}: ${o(this.detailFilter === 'attention' ? 'abnormalResources' : this.detailFilter === 'collection' ? 'collectionRisk' : this.detailFilter === 'risk' ? 'riskQueue' : this.detailFilter || this.detailType)}</app-badge><button class="btn-ghost" @click=${() => this.selectDetail('')}>${o('clear')}</button></div>` : nothing}</div><div class="table-scroll"><app-data-table .columns=${columns} .rows=${rows} .emptyMessage=${o('noMatch')} .dense=${true}></app-data-table></div><div slot="footer" class="actions"><button class="btn" .disabled=${page <= 1} @click=${() => { this.page = page - 1; this.saveUrl(); }}>${o('prev')}</button><span>${page}/${pages} ${o('page')}</span><button class="btn" .disabled=${page >= pages} @click=${() => { this.page = page + 1; this.saveUrl(); }}>${o('next')}</button></div></app-card>`;
  }
  private validDates() {
    return /^\d{4}-\d{2}-\d{2}$/.test(this.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(this.endDate) && Number.isFinite(Date.parse(this.startDate)) && Number.isFinite(Date.parse(this.endDate)) && new Date(this.startDate).toISOString().slice(0, 10) === this.startDate && new Date(this.endDate).toISOString().slice(0, 10) === this.endDate && this.startDate <= this.endDate && Date.parse(this.endDate) <= Date.now();
  }
  private async loadTrend() {
    const version = ++this.trendVersion;
    if (this.resourceScope !== 'instance' || !this.selectedInstanceId) { this.capacityTrend = null; this.trendLoading = false; return; }
    const id = this.selectedInstanceId;
    const params = new URLSearchParams({ instance_id: String(id) });
    if (this.customDates && this.validDates()) { params.set('start_date', this.startDate); params.set('end_date', this.endDate); }
    else params.set('hours', String(this.selectedHours));
    const query = params.toString();
    if (query !== this.trendQuery) { const cached = this.trendCache.get(query); this.capacityTrend = cached?.data ?? null; this.trendTime = cached?.time ?? ''; }
    this.trendQuery = query; this.trendLoading = true; this.trendError = '';
    try {
      const response = await authFetch(`/api/dashboard/capacity-trend?${params}`);
      if (!response.ok) throw new Error(`${o('capacity')}: ${response.status === 403 ? o('permission') : o('unavailableData')}`);
      const result = await response.json();
      if (!Array.isArray(result.trend)) throw new Error(o('unavailableData'));
      if (version !== this.trendVersion) return;
      this.capacityTrend = result; this.trendTime = new Date().toISOString();
      this.trendCache.set(query, { data: result, time: this.trendTime });
      if (this.trendCache.size > 12) this.trendCache.delete(this.trendCache.keys().next().value!);
    } catch (error) { if (version === this.trendVersion) this.trendError = error instanceof Error ? error.message : o('failure'); }
    finally { if (version === this.trendVersion) this.trendLoading = false; }
  }
  private renderDatabase(items: OverviewItem[]) {
    if (this.resourceScope !== 'instance') return nothing;
    const engines = [...new Set(items.map(item => String(item.attributes?.dbType ?? 'unknown')))].map(name => ({ name, count: items.filter(item => String(item.attributes?.dbType ?? 'unknown') === name).length })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return html`<app-card><h2 slot="header">${o('dbTypes')}</h2>${engines.map(({ name, count }) => html`<div class="engine-row"><button class="btn-ghost" @click=${() => { this.engine = name; this.page = 1; this.normalizeSelection(); this.saveUrl(); void this.loadTrend(); }}>${name}</button><meter min="0" max=${items.length} value=${count} aria-label=${name}></meter><span>${count} · ${Math.round(count / items.length * 100)}%</span></div>`)}</app-card>
      <app-card><h2 slot="header">${o('capacity')}</h2><p class="metadata">${o('localFilter')} · ${o('dataTime')}: ${this.time(this.trendTime)}</p><div class="filters"><app-form-field label=${o('chooseInstance')}><select aria-label=${o('chooseInstance')} .value=${String(this.selectedInstanceId ?? '')} @change=${(event: Event) => { this.selectedInstanceId = Number((event.target as HTMLSelectElement).value); this.saveUrl(); void this.loadTrend(); }}>${items.map(item => html`<option value=${item.resource.id} .selected=${live(item.resource.id === this.selectedInstanceId)}>${this.label(item)}</option>`)}</select></app-form-field>${[24, 168, 720].map((hours, index) => html`<button class=${!this.customDates && this.selectedHours === hours ? 'btn-primary' : 'btn'} @click=${() => { this.customDates = false; this.selectedHours = hours; this.saveUrl(); void this.loadTrend(); }}>${['24h', '7d', '30d'][index]}</button>`)}<button class="btn" aria-expanded=${String(this.customDates)} @click=${() => { this.customDates = !this.customDates; }}>${o('custom')}</button></div>
      ${this.customDates ? html`<div class="filters"><app-form-field label=${o('start')}><input type="date" aria-label=${o('start')} .value=${this.startDate} @input=${(event: Event) => { this.startDate = (event.target as HTMLInputElement).value; }}></app-form-field><app-form-field label=${o('end')}><input type="date" aria-label=${o('end')} .value=${this.endDate} @input=${(event: Event) => { this.endDate = (event.target as HTMLInputElement).value; }}></app-form-field><button class="btn" @click=${() => { if (!this.validDates()) { this.trendError = o('invalidDates'); return; } this.saveUrl(); void this.loadTrend(); }}>${o('apply')}</button></div>` : nothing}
      ${this.trendError ? html`<p class="notice" role="alert">${this.trendError} <button class="btn" @click=${this.loadTrend}>${o('retry')}</button></p>` : nothing}
      ${this.trendLoading && !this.capacityTrend ? html`<div class="skeleton large" aria-label=${o('refreshing')}></div>` : this.capacityTrend?.trend.length ? html`<p>${o('capacity')}: ${this._formatBytes(this.capacityTrend.trend.at(-1)!.total_size_gb)} · ${this.capacityTrend.trend[0].time} → ${this.capacityTrend.trend.at(-1)!.time} · ${this.capacityTrend.trend.length} samples</p><div class="trend-chart-container" role="img" aria-label=${`${o('capacity')} GB`}></div>` : html`<app-empty-state title=${o('noCapacity')}></app-empty-state>`}<p class="metadata">${o('capacityGaps')}</p></app-card>`;
  }
  private _formatBytes(value: number | null) { return value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(2)} GB`; }
  private disposeChart() { this.resize?.disconnect(); this.chart?.dispose(); this.chart = null; this.resize = null; this.trendElement = null; }
  override updated(changes: Map<string, unknown>) {
    const container = this.renderRoot.querySelector<HTMLElement>('.trend-chart-container');
    if (!container) this.disposeChart();
    else if (container !== this.trendElement || changes.has('capacityTrend')) {
      this.disposeChart(); this.trendElement = container;
      this.chart = echarts.init(container, undefined, { renderer: 'svg' });
      const style = getComputedStyle(this);
      const text = style.getPropertyValue('--text').trim(); const accent = style.getPropertyValue('--accent').trim();
      const points: Array<[string, number | null]> = [];
      for (const point of this.capacityTrend?.trend ?? []) {
        const previous = points.at(-1);
        if (previous && Date.parse(point.time) - Date.parse(previous[0]) > 3_600_000) points.push([new Date(Date.parse(previous[0]) + 3_600_000).toISOString(), null]);
        points.push([point.time, point.total_size_gb]);
      }
      this.chart.setOption({ textStyle: { color: text }, tooltip: { trigger: 'axis' }, grid: { left: 55, right: 20, top: 30, bottom: 40 }, xAxis: { type: 'time', axisLabel: { color: text } }, yAxis: { type: 'value', name: 'GB', axisLabel: { color: text } }, series: [{ type: 'line', name: o('capacity'), data: points, connectNulls: false, smooth: false, lineStyle: { color: accent }, itemStyle: { color: accent } }] });
      this.resize = new ResizeObserver(() => this.chart?.resize()); this.resize.observe(container);
    }
    if (this.restorePosition && this.resourceOverview && !this.loading) {
      this.restorePosition = false;
      try { const top = Number(sessionStorage.getItem('slide.overview.scroll')); if (top > 0) this.scrollingParent().scrollTop = top; } catch { /* Optional restoration. */ }
    }
  }
  override render() {
    const items = this._visibleResourceItems();
    const scopeInventory = scopedItems(this.resourceOverview, this.resourceScope);
    const engines = [...new Set(scopeInventory.map(item => String(item.attributes?.dbType ?? 'unknown')))];
    const s = summarize(items);
    const scopePermission = this.resourceScope === 'server' ? 'servers:view' : this.resourceScope === 'network_device' ? 'network_devices:view' : 'instance:view';
    const inventoryFailed = this.resourceOverview?.unavailableTypes?.some(type => this.resourceScope === 'all' || type === this.resourceScope);
    const noPermission = this.resourceScope !== 'all' && !permissionMatches(this.permissions, scopePermission);
    return html`<div class="dashboard-grid"><header class="toolbar"><h1>${o('title')}</h1><div class="metadata"><time title=${this.resourceOverview?.collectedAt ?? ''}>${o('dataTime')}: ${this.time(this.resourceOverview?.collectedAt ?? null)}</time><button class="btn" .disabled=${this.loading} @click=${this.loadDashboardData}><span aria-hidden="true">${icons['refresh-cw']}</span>${o(this.loading ? 'refreshing' : 'refresh')}</button></div></header>
      <div class="scope-switch" role="tablist" aria-label=${o('title')}>${(['all', ...resourceTypes] as Scope[]).map((scope, index) => html`<button id=${`scope-${scope}`} class="btn" role="tab" aria-selected=${String(this.resourceScope === scope)} aria-controls="overview-panel" tabindex=${this.resourceScope === scope ? '0' : '-1'} @keydown=${(event: KeyboardEvent) => this.keydownTab(event, index)} @click=${() => this.switchScope(scope)}><span aria-hidden="true">${this.icon(scope)}</span>${o(scope)}</button>`)}</div>
      <div class="filters"><app-form-field label=${o('scopeSearch')}><input type="search" aria-label=${o('scopeSearch')} .value=${this.search} @input=${(event: Event) => this.changeScopeFilter(event, 'search')}></app-form-field>${this.resourceScope === 'instance' ? html`<app-form-field label=${o('engine')}><select aria-label=${o('engine')} .value=${this.engine} @change=${(event: Event) => this.changeScopeFilter(event, 'engine')}><option value="">${o('allEngines')}</option>${engines.map(engine => html`<option value=${engine} .selected=${live(engine === this.engine)}>${engine} (${scopeInventory.filter(item => String(item.attributes?.dbType ?? 'unknown') === engine).length})</option>`)}</select></app-form-field>` : nothing}${this.search || this.engine ? html`<button class="btn-ghost" @click=${this.clearFilters}>${o('clear')}</button>` : nothing}</div>
      ${this.error ? html`<p class="notice" role="alert">${this.error} ${this.resourceOverview ? o('retained') : ''}<button class="btn" @click=${this.loadDashboardData}>${o('retry')}</button></p>` : nothing}
      ${this.resourceOverview?.truncated ? html`<p class="notice">${o('incomplete')}</p>` : nothing}
      <section id="overview-panel" role="tabpanel" aria-labelledby=${`scope-${this.resourceScope}`} class="dashboard-grid">
      ${!this.resourceOverview ? this.loading ? html`<div class="dashboard__stat-cards">${[0, 1, 2, 3].map(() => html`<div class="skeleton"></div>`)}</div><div class="skeleton large"></div>` : html`<app-empty-state title=${o('unavailableData')}></app-empty-state>` : !scopeInventory.length ? html`<app-empty-state title=${inventoryFailed ? o('unavailableData') : this.resourceOverview.truncated ? o('incomplete') : noPermission ? o('permission') : `${o('noManaged')} ${o(this.resourceScope === 'all' ? 'resources' : this.resourceScope)}`} description=${o('manageHint')}></app-empty-state>${!this.resourceOverview.truncated && !inventoryFailed && !noPermission && this.resourceScope !== 'all' && permissionMatches(this.permissions, this.resourceScope === 'network_device' ? 'network_devices:manage' : this.resourceScope === 'server' ? 'servers:manage' : 'instance:manage') ? html`<a class="btn" href=${this.resourceScope === 'network_device' ? '/network-devices' : this.resourceScope === 'server' ? '/servers' : '/instances-db'}>${o('manage')}</a>` : nothing}` : !items.length ? html`<app-empty-state title=${o('noMatch')}></app-empty-state><button class="btn" @click=${this.clearFilters}>${o('clear')}</button>` : html`
        ${!this.resourceOverview.truncated && (s.alertsIncomplete || items.some(item => item.gaps.includes('OBSERVATIONS_TRUNCATED'))) ? html`<p class="notice">${o('incomplete')}</p>` : nothing}${s.alertsUnavailable ? html`<p class="notice">${o('alertUnavailable')}</p>` : nothing}
        ${this.renderKpis(items)}<div class="dashboard__primary">${this.renderRiskQueue(items)}<div class="side-panels">${this.renderHealth(items)}${this.renderRelations(items)}</div></div>
        <details><summary>${o('collection')} · ${o('fresh')} ${s.fresh}/${s.total} · ${o('collectionRisk')} ${s.collection}</summary><div class="metadata">${['fresh', 'stale', 'missing', 'failed'].map(state => html`<span>${o(state)} ${items.filter(item => freshness(item) === state).length}</span>`)}<span>${o('qualityGap')} ${items.filter(item => item.quality !== 'good').length}</span></div></details>
        ${this.renderDatabase(items)}${this.renderMetrics(items)}${this.renderBackups(items)}${this.renderDetails(items)}`}
      </section></div>`;
  }
}
