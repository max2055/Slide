import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { metricRequest, metricError, type Catalog, type Overrides } from '../components/metric-configuration.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './metric-registry.js';
import { authFetch } from '../../../api/index.js';
import { metricName, packageName, resourceLabels } from '../components/resource-metric-summary.js';
import { numericFields } from '../components/metric-policy-fields.js';

@customElement('metric-settings')
export class MetricSettings extends LitElement {
  @property() view = 'catalog';
  @state() private catalog: Catalog | null = null;
  @state() private error = '';
  @state() private type = 'instance';
  @state() private search = '';
  @state() private category = '';
  @state() private policyTab = 'resource';
  @state() private resources: Array<{ resource: { type: string; id: number }; label: string; attributes?: Record<string, unknown> }> = [];
  @state() private resourceNotice = '';
  @state() private resourceId = 0;
  @state() private groupId = '';
  @state() private groupRevision = 0;
  @state() private groupOverrides: Overrides = {};
  @state() private groupPreview: { affected_resources: number; requests_per_hour_before: number; requests_per_hour_after: number } | null = null;
  @state() private busy = false;
  @state() private groupLoaded = false;
  @state() private groupManage = false;
  static componentStyles = [sharedBtnStyles, css`
    :host { display:block; min-width:0; } .scroll { overflow:auto; max-width:100%; } app-data-table { min-width:48rem; }
    input,select,textarea { box-sizing:border-box; max-width:100%; width:100%; padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); background:var(--bg); }
    .actions { display:flex; flex-wrap:wrap; gap:var(--space-sm); margin-block:var(--space-md); }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; }
  `];
  override connectedCallback() { super.connectedCallback(); void this.load(); void this.loadResources(); }
  private async loadResources() {
    try {
      const response = await authFetch('/api/resources');
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json(); this.resources = data.items;
      this.resourceNotice = data.truncated || data.unavailableTypes?.length ? '资源列表不完整；可从资源详情进入采集配置。' : '';
    } catch (e) { this.resources = []; this.resourceNotice = metricError(e); }
  }
  private async load() { try { this.catalog = await metricRequest<Catalog>('config/catalog'); } catch (e) { this.error = metricError(e); } }
  private async group(operation: 'load' | 'preview' | 'publish') {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.groupId) || this.busy) return;
    if (operation !== 'load' && (!this.canEditGroup() || operation === 'publish' && !this.groupPreview)) return;
    this.busy = true; this.error = '';
    try {
      const path = `policy/groups/${this.groupId}`;
      if (operation === 'load') {
        this.groupManage = false;
        const access = await metricRequest<{ can_manage: boolean }>(`${path}/access`);
        const group = await metricRequest<{ revision: number; overrides: unknown }>(path).catch(e => { if (e.message === '404') return { revision: 0, overrides: {} }; throw e; });
        this.groupManage = access.can_manage; this.groupRevision = group.revision; this.groupOverrides = group.overrides as Overrides; this.groupLoaded = true; this.groupPreview = null;
      } else {
        const result = await metricRequest<NonNullable<MetricSettings['groupPreview']>>(`${path}/${operation}`, { expected_revision: this.groupRevision, overrides: this.groupOverrides });
        this.groupPreview = operation === 'preview' ? result : null;
        if (operation === 'publish') { this.groupLoaded = false; this.groupRevision++; }
      }
    } catch (e) { this.groupPreview = null; this.groupLoaded = false; this.error = metricError(e); }
    finally { this.busy = false; }
  }
  private canEditGroup() { return this.groupManage && this.groupLoaded; }
  render() {
    const c = this.catalog;
    return html`<style>${MetricSettings.componentStyles.map(s => s.cssText).join('\n')}
      small { display:block;color:var(--muted);overflow-wrap:anywhere; } :focus-visible { outline:2px solid var(--accent); }
    </style>${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
    ${this.view === 'legacy' ? html`<metric-registry-viewer></metric-registry-viewer>` : this.view === 'policies' ? this.renderPolicies() : this.view === 'packages' ? html`
      <app-card><h2 slot="header">采集包</h2><p>采集包版本不可变；同一采集包升级保留覆盖值，标准指标定义保持不变。</p>
      ${c?.packages.map(p => html`<details><summary>${packageName(p.package.id)} · ${p.package.version} · ${resourceLabels[p.package.resource_type]}</summary>
        <p>标识：${p.package.id}</p><h3>包含指标</h3>${p.package.collectors?.flatMap(c => c.mappings ?? []).map(m => html`<p>${metricName(m.metric.id)}<small>${m.metric.id}</small></p>`)}
        <h3>所需权限与发现范围</h3>${p.documentation.map(d => html`<p>${d.permissions?.join('；')}</p><p>${d.discovery}</p>`)}
        <h3>推荐配置</h3>${Object.entries(p.recommendations).map(([k,v]) => html`<p>${numericFields[k as keyof typeof numericFields] ?? (k === 'enabled' ? '采集开关' : k)}：${k.endsWith('_ms') ? Number(v) / 1000 : typeof v === 'boolean' ? v ? '启用' : '停用' : v}</p>`)}
        <details><summary>高级版本与适用条件</summary><pre>${JSON.stringify(p, null, 2)}</pre></details></details>`)}
      </app-card>` : html`<app-card><h2 slot="header">指标目录</h2><p>标准指标定义只读；扩展指标由采集包提供。修改采集行为请进入资源采集策略。</p>
        <app-form-field label="搜索名称或标识"><input aria-label="搜索指标" .value=${this.search} @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; }}></app-form-field>
        <app-form-field label="资源类型"><select aria-label="指标资源类型" .value=${this.type} @change=${(e: Event) => { this.type = (e.target as HTMLSelectElement).value; }}><option value="">全部</option>${Object.entries(resourceLabels).map(([k,v]) => html`<option value=${k}>${v}</option>`)}</select></app-form-field>
        <app-form-field label="来源"><select .value=${this.category} @change=${(e: Event) => { this.category = (e.target as HTMLSelectElement).value; }}><option value="">全部</option><option value="canonical">标准指标</option><option value="extension">扩展指标</option></select></app-form-field>
        <div class="scroll"><app-data-table .loading=${!c && !this.error} .columns=${[{ key: 'name', label: '名称' }, { key: 'resource', label: '适用资源' }, { key: 'unit', label: '单位' }, { key: 'kind', label: '指标类型' }, { key: 'category', label: '来源' }, { key: 'detail', label: '详情' }]}
          .rows=${c?.metrics.filter(m => (!this.type || m.resource_type === this.type) && (!this.category || m.category === this.category) && `${metricName(m.id)} ${m.id}`.toLowerCase().includes(this.search.toLowerCase())).map(m => ({ name: html`${metricName(m.id)}<small>${m.id}</small>`, resource: resourceLabels[m.resource_type], unit: m.unit, kind: m.kind === 'counter' ? '累计计数' : '瞬时值', category: m.category === 'canonical' ? '标准指标' : '扩展指标', detail: html`<details><summary>定义与版本</summary><p>语义版本 ${m.semantic_version}</p><pre>${JSON.stringify(m, null, 2)}</pre></details>` })) ?? []}></app-data-table></div></app-card>`}`;
  }
  private changeResource(action: () => void) {
    const config = this.renderRoot.querySelector('metric-configuration') as import('../components/metric-configuration.js').MetricConfiguration | null;
    if (config) config.confirmDiscard(action); else action();
  }
  private renderPolicies() {
    return html`<div class="actions"><button class="btn" .disabled=${this.policyTab === 'resource'} @click=${() => { this.policyTab = 'resource'; }}>资源策略</button><button class="btn" .disabled=${this.policyTab === 'group'} @click=${() => { this.changeResource(() => { this.policyTab = 'group'; }); }}>策略组</button></div>
      ${this.policyTab === 'resource' ? html`<app-card><h2 slot="header">资源采集策略</h2>
        <app-form-field label="资源类型"><select .value=${this.type} @change=${(e: Event) => { const select = e.target as HTMLSelectElement, type = select.value; select.value = this.type; this.changeResource(() => { this.type = type; this.resourceId = 0; }); }}>${Object.entries(resourceLabels).map(([k,v]) => html`<option value=${k}>${v}</option>`)}</select></app-form-field>
        <app-form-field label="搜索资源"><input aria-label="搜索资源" .value=${this.search} @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; }}></app-form-field>
        <app-form-field label="资源"><select aria-label="资源" .value=${String(this.resourceId)} @change=${(e: Event) => { const select = e.target as HTMLSelectElement, id = Number(select.value); select.value = String(this.resourceId); this.changeResource(() => { this.resourceId = id; }); }}><option value="0">请选择资源</option>${this.resources.filter(r => r.resource.type === this.type && (r.resource.id === this.resourceId || `${r.label} ${r.attributes?.host ?? ''}`.toLowerCase().includes(this.search.toLowerCase()))).map(r => html`<option value=${String(r.resource.id)}>${r.label} · ${r.attributes?.host ?? resourceLabels[r.resource.type]}</option>`)}</select></app-form-field>
        <p role="status">${this.resourceNotice}</p>${this.resourceNotice ? html`<button class="btn" @click=${this.loadResources}>重试资源列表</button>` : nothing}
        ${this.resourceId > 0 ? html`<metric-configuration .resourceType=${this.type} .resourceId=${this.resourceId}></metric-configuration>` : html`<app-empty-state title="选择资源后管理采集配置"></app-empty-state>`}</app-card>` : html`
      <app-card><h2 slot="header">策略组</h2><p>当前服务尚未提供策略组枚举接口。已有绑定可在资源配置查看；按标识管理属于高级操作。</p>
        <app-form-field label="策略组标识"><input .value=${this.groupId} .disabled=${this.busy} @input=${(e: Event) => { this.groupId = (e.target as HTMLInputElement).value; this.groupLoaded = false; this.groupPreview = null; }}></app-form-field>
        <button class="btn" .disabled=${this.busy} @click=${() => this.group('load')}>读取策略组</button><p>发布版本 ${this.groupRevision}；未覆盖字段继承采集包与平台值。</p>
        <metric-policy-fields .overrides=${this.groupOverrides} .disabled=${this.busy || !this.canEditGroup()} @policy-change=${(e: CustomEvent<Overrides>) => { this.groupOverrides = e.detail; this.groupPreview = null; }}></metric-policy-fields>
        ${this.canEditGroup() ? html`<div class="actions"><button class="btn" .disabled=${this.busy} @click=${() => this.group('preview')}>预览组影响</button><button class="btn-primary" .disabled=${this.busy || !this.groupPreview} @click=${() => this.group('publish')}>发布策略组</button></div>` : nothing}
        ${this.groupPreview ? html`<p>影响 ${this.groupPreview.affected_resources} 个资源，每小时逻辑读取 ${this.groupPreview.requests_per_hour_before} → ${this.groupPreview.requests_per_hour_after}</p>` : nothing}</app-card>`}`;
  }
}
