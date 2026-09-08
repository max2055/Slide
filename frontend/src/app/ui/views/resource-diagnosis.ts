import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { permissionMatches } from '../settings-navigation.js';
import '../components/app-form-field.js';
import '../components/app-empty-state.js';
import '../components/app-badge.js';

type ResourceType = 'instance' | 'server' | 'network_device';
interface ResourceRef { type: ResourceType; id: number }
interface ResourceDetail { resource: ResourceRef; label: string; status: string; attributes: Record<string, unknown> }
interface EvidenceItem {
  id: string; kind: string; status: string; quality: string; observedAt: string | null; validUntil: string | null;
  source: string; correlationId: string; provenance: unknown; dimensions?: Record<string, string>;
  payload: { metricId?: string; value?: number | null; statement?: string; reason?: string };
}
interface EvidenceBundle { generatedAt: string; facts: EvidenceItem[]; inferences: EvidenceItem[]; hypotheses: EvidenceItem[]; gaps: string[]; truncated: boolean }
interface DiagnosticPack { relations: Array<{ source: ResourceRef; target: ResourceRef; relationType: string; provenance: string }>; relatedEvidence: Array<{ resource: ResourceDetail }>; gaps: Array<{ scope: string; code: string }>; truncated: boolean }
const resourceLabels: Record<ResourceType, string> = { instance: '数据库', server: '服务器', network_device: '网络设备' };
const key = (ref: ResourceRef) => `${ref.type}:${ref.id}`;

@customElement('resource-diagnosis-page')
export class ResourceDiagnosisPage extends LitElement {
  @state() private resources: ResourceDetail[] = [];
  @state() private selected: ResourceRef | null = null;
  @state() private evidence: EvidenceBundle | null = null;
  @state() private pack: DiagnosticPack | null = null;
  @state() private loading = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private agentResult: unknown = null;
  @state() private search = '';
  @state() private permissions: Set<string> = new Set();
  private requestVersion = 0;
  private readonly onPopState = () => { this.readSelection(); void this.loadEvidence(); };
  private readonly onPermissions = () => { this.readPermissions(); };

  static styles = [sharedBtnStyles, css`
    :host { display: block; min-width: 0; color: var(--text); }
    h1 { font-size: 22px; color: var(--text-strong); margin: 0; }
    h2 { font-size: 16px; margin: 0 0 var(--space-md); }
    header, .actions, .metadata { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); }
    header { justify-content: space-between; margin-bottom: var(--space-lg); }
    .picker { display: grid; grid-template-columns: 1fr 2fr; gap: var(--space-md); }
    select, input { box-sizing: border-box; width: 100%; min-width: 0; padding: var(--space-sm); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit; }
    section { border-top: 1px solid var(--border); padding: var(--space-lg) 0; }
    .metadata, time { color: var(--muted); font-size: 12px; }
    details { padding: var(--space-md) 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
    summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: baseline; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
    code, p, a { overflow-wrap: anywhere; }
    a { color: var(--accent); }
    svg { width: 16px; height: 16px; }
    .skeleton { height: 100px; background: var(--border); opacity: .4; }
    .error { color: var(--danger); }
    @media (max-width: 640px) { .picker { grid-template-columns: minmax(0, 1fr); } }
  `];

  override connectedCallback() {
    super.connectedCallback();
    this.readPermissions(); this.readSelection();
    window.addEventListener('popstate', this.onPopState);
    window.addEventListener('slide-permissions-loaded', this.onPermissions);
    void this.load();
  }
  override disconnectedCallback() {
    this.requestVersion++;
    window.removeEventListener('popstate', this.onPopState);
    window.removeEventListener('slide-permissions-loaded', this.onPermissions);
    super.disconnectedCallback();
  }
  private readPermissions() {
    try { this.permissions = new Set(JSON.parse(localStorage.getItem('permissions') ?? '[]')); } catch { this.permissions = new Set(); }
  }
  private readSelection() {
    const params = new URL(location.href).searchParams;
    const type = params.get('resourceType') as ResourceType;
    const id = Number(params.get('resourceId'));
    this.selected = Object.hasOwn(resourceLabels, type) && Number.isSafeInteger(id) && id > 0 ? { type, id } : null;
  }
  private async load() {
    this.loading = true; this.error = '';
    try {
      const response = await authFetch('/api/resources');
      if (!response.ok) throw new Error(`资源加载失败 (${response.status})`);
      this.resources = (await response.json()).items;
      await this.loadEvidence();
    } catch (error) { this.error = String(error); } finally { this.loading = false; }
  }
  private async loadEvidence() {
    const version = ++this.requestVersion;
    this.evidence = null; this.pack = null; this.agentResult = null; this.error = ''; this.busy = false;
    if (!this.selected) { this.loading = false; return; }
    this.loading = true;
    try {
      const response = await authFetch(`/api/resources/${this.selected.type}/${this.selected.id}/evidence`);
      if (!response.ok) throw new Error(`证据加载失败 (${response.status})`);
      const evidence = await response.json();
      if (version === this.requestVersion) this.evidence = evidence;
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.loading = false; }
  }
  private selectResource(value: string) {
    const [type, id] = value.split(':');
    const url = new URL(location.href);
    url.searchParams.set('resourceType', type); url.searchParams.set('resourceId', id);
    history.pushState({}, '', url); this.readSelection(); void this.loadEvidence();
  }
  private async diagnose(agent = false) {
    if (!this.selected || this.busy) return;
    const version = this.requestVersion;
    this.busy = true; this.error = '';
    try {
      const response = await authFetch(`/api/resources/${this.selected.type}/${this.selected.id}/${agent ? 'diagnose-agent' : 'diagnose'}`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `诊断失败 (${response.status})`);
      if (version !== this.requestVersion) return;
      if (agent) this.agentResult = result; else this.pack = result;
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.busy = false; }
  }
  private resourceHref(ref: ResourceRef) {
    const url = new URL(location.href);
    url.searchParams.set('resourceType', ref.type); url.searchParams.set('resourceId', String(ref.id));
    if (this.selected) url.searchParams.set('returnResource', key(this.selected));
    return `${url.pathname}${url.search}`;
  }
  private renderItem(item: EvidenceItem) {
    const observed = item.observedAt ? Date.parse(item.observedAt) : NaN;
    const expiry = item.validUntil ? Date.parse(item.validUntil) : NaN;
    const freshness = !Number.isFinite(observed) || observed > Date.now() ? '时间未知' : !Number.isFinite(expiry) ? '有效期未知' : expiry <= Date.now() ? '已过期' : '新鲜';
    return html`<details data-evidence-id=${item.id}><summary><code>${item.id}</code><span>${item.payload.metricId ?? item.payload.statement ?? item.kind}</span><app-badge>${item.quality}</app-badge><span>${freshness}</span><time>${item.observedAt ?? '无观测时间'}</time></summary>
      <p>${item.payload.value === null ? '未知' : item.payload.value ?? ''} ${item.payload.reason ?? ''}</p>
      <div class="metadata"><span>状态 ${item.status}</span><span>有效期 ${item.validUntil ?? '未知'}</span><span>来源 ${item.source}</span><span>关联 ID ${item.correlationId}</span></div>
      <pre>${JSON.stringify({ provenance: item.provenance, dimensions: item.dimensions, payload: item.payload }, null, 2)}</pre></details>`;
  }
  override render() {
    const filtered = this.resources.filter(item => `${item.label} ${key(item.resource)}`.toLowerCase().includes(this.search.toLowerCase()) || (this.selected && key(item.resource) === key(this.selected)));
    const selectedListed = this.resources.some(item => this.selected && key(item.resource) === key(this.selected));
    const returnResource = new URL(location.href).searchParams.get('returnResource');
    return html`
      <header><h1>跨资源诊断</h1><button class="btn" title="刷新" aria-label="刷新" .disabled=${this.loading} @click=${this.load}>${icons['refresh-cw']}</button></header>
      <div class="picker"><app-form-field label="搜索资源"><input aria-label="搜索资源" type="search" .value=${this.search} @input=${(event: Event) => { this.search = (event.target as HTMLInputElement).value; }}></app-form-field>
      <app-form-field label="资源"><select aria-label="资源" .value=${this.selected ? key(this.selected) : ''} @change=${(event: Event) => this.selectResource((event.target as HTMLSelectElement).value)}><option value="" .disabled=${true}>选择资源</option>
        ${this.selected && !selectedListed ? html`<option .selected=${true} value=${key(this.selected)}>${resourceLabels[this.selected.type]} #${this.selected.id}</option>` : nothing}
        ${Object.entries(resourceLabels).map(([type, label]) => html`<optgroup label=${label}>${filtered.filter(item => item.resource.type === type).map(item => html`<option .selected=${this.selected !== null && key(item.resource) === key(this.selected)} value=${key(item.resource)}>${item.label} · ${item.status} · #${item.resource.id}</option>`)}</optgroup>`)}</select></app-form-field></div>
      ${returnResource && /^(instance|server|network_device):[1-9]\d*$/.test(returnResource) ? html`<button class="btn-ghost" @click=${() => { const url = new URL(location.href); url.searchParams.delete('returnResource'); history.replaceState({}, '', url); this.selectResource(returnResource); }}>${icons['chevron-left']} 返回 ${returnResource}</button>` : nothing}
      ${this.selected ? html`<div class="actions"><button class="btn" .disabled=${this.busy || this.loading} @click=${() => this.diagnose()}>${icons.search} 获取关联证据</button>${permissionMatches(this.permissions, 'ai:manage') ? html`<button class="btn-primary" .disabled=${this.busy || this.loading} @click=${() => this.diagnose(true)}>${icons.bot} Agent 诊断</button>` : nothing}</div>` : nothing}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${this.loading ? html`<div class="skeleton" aria-label="加载证据"></div>` : !this.selected ? html`<app-empty-state title="选择诊断资源" icon="search"></app-empty-state>` : nothing}
      ${this.evidence ? html`<p class="metadata">${this.evidence.generatedAt}</p>${this.evidence.truncated ? html`<p role="status">证据已截断</p>` : nothing}
        ${this.evidence.gaps.length ? html`<section><h2>证据缺口</h2>${this.evidence.gaps.map(gap => html`<p><code>${gap}</code></p>`)}</section>` : nothing}
        ${(['facts', 'inferences', 'hypotheses'] as const).map((kind, index) => html`<section data-kind=${kind}><h2>${['事实', '推论', '假设'][index]} (${this.evidence![kind].length})</h2>${this.evidence![kind].length ? [...this.evidence![kind]].sort((a, b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? '')).map(item => this.renderItem(item)) : html`<app-empty-state title="暂无证据"></app-empty-state>`}</section>`)}` : nothing}
      ${this.pack ? html`<section><h2>关联资源</h2>${this.pack.relations.map(relation => html`<p><a href=${this.resourceHref(relation.source)}>${key(relation.source)}</a> ${relation.relationType} <a href=${this.resourceHref(relation.target)}>${key(relation.target)}</a> <span>${relation.provenance}</span></p>`)}${this.pack.relatedEvidence.map(item => html`<p><a href=${this.resourceHref(item.resource.resource)}>${resourceLabels[item.resource.resource.type]} · ${item.resource.label}</a></p>`)}${this.pack.gaps.map(gap => html`<p>${gap.scope}: ${gap.code}</p>`)}${this.pack.truncated ? html`<p>关联证据已截断</p>` : nothing}</section>` : nothing}
      ${this.agentResult ? html`<section><h2>Agent 诊断</h2><pre>${JSON.stringify(this.agentResult, null, 2)}</pre></section>` : nothing}
    `;
  }
}
