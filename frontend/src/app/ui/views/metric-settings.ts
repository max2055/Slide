import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { metricRequest, metricError, type Catalog, type Overrides } from '../components/metric-configuration.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './metric-registry.js';

@customElement('metric-settings')
export class MetricSettings extends LitElement {
  @property() view = 'catalog';
  @state() private catalog: Catalog | null = null;
  @state() private error = '';
  @state() private type = 'instance';
  @state() private resourceId = 0;
  @state() private groupId = '';
  @state() private groupRevision = 0;
  @state() private groupOverrides: Overrides = {};
  @state() private groupPreview: { affected_resources: number; requests_per_hour_before: number; requests_per_hour_after: number } | null = null;
  @state() private busy = false;
  @state() private groupLoaded = false;
  @state() private groupManage = false;
  static styles = [sharedBtnStyles, css`
    :host { display:block; min-width:0; } .scroll { overflow:auto; max-width:100%; } app-data-table { min-width:48rem; }
    input,select,textarea { box-sizing:border-box; max-width:100%; width:100%; padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); background:var(--bg); }
    .actions { display:flex; flex-wrap:wrap; gap:var(--space-sm); margin-block:var(--space-md); }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; }
  `];
  override connectedCallback() { super.connectedCallback(); void this.load(); }
  private async load() { try { this.catalog = await metricRequest<Catalog>('config/catalog'); } catch (e) { this.error = metricError(e); } }
  private async group(operation: 'load' | 'preview' | 'publish') {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.groupId) || this.busy) return;
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
    return html`${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.view === 'legacy' ? html`<metric-registry-viewer></metric-registry-viewer>` : this.view === 'packages' ? html`
        <app-card><h2 slot="header">采集包</h2><p>不可变模板版本；仅允许同 ID 升级，覆盖值会保留。不能修改 Canonical 或 CoreProfile。</p>
        <div class="scroll"><app-data-table .loading=${!c} .columns=${[{ key: 'id', label: 'ID' }, { key: 'version', label: '模板版本' }, { key: 'resource_type', label: '资源类型' }, { key: 'applicability', label: '适用条件' }]} .rows=${c?.packages.map(p => ({ ...p.package, applicability: JSON.stringify(p.package.applicability) })) ?? []}></app-data-table></div>
        ${c?.packages.map(p => html`<details><summary>${p.package.id} @ ${p.package.version}</summary><p>权限、固定采集器及发现范围</p><pre>${JSON.stringify(p.documentation, null, 2)}</pre><p>推荐策略</p><pre>${JSON.stringify(p.recommendations, null, 2)}</pre></details>`)}
        </app-card>` : this.view === 'policies' ? html`
        <app-card><h2 slot="header">资源采集策略</h2><app-form-field label="资源类型"><select .value=${this.type} @change=${(e: Event) => { this.type = (e.target as HTMLSelectElement).value; this.resourceId = 0; }}><option value="instance">数据库实例</option><option value="server">主机</option><option value="network_device">网络设备</option></select></app-form-field>
        <app-form-field label="资源 ID"><input type="number" min="1" .value=${this.resourceId ? String(this.resourceId) : ''} @change=${(e: Event) => { this.resourceId = Number((e.target as HTMLInputElement).value); }}></app-form-field>
        ${this.resourceId > 0 ? html`<metric-configuration .resourceType=${this.type} .resourceId=${this.resourceId}></metric-configuration>` : html`<app-empty-state title="选择资源后管理采集配置"></app-empty-state>`}</app-card>
        <app-card><h2 slot="header">策略组</h2><app-form-field label="策略组 ID"><input .value=${this.groupId} .disabled=${this.busy} @input=${(e: Event) => { this.groupId = (e.target as HTMLInputElement).value; this.groupLoaded = false; this.groupPreview = null; }}></app-form-field>
        <button class="btn" .disabled=${this.busy} @click=${() => this.group('load')}>读取策略组</button>
        <p>Revision ${this.groupRevision}；未覆盖的字段继承包与平台值。发布前请预览受影响资源。</p>
        <metric-policy-fields .overrides=${this.groupOverrides} .disabled=${this.busy || !this.groupLoaded || !this.canEditGroup()} @policy-change=${(e: CustomEvent<Overrides>) => { this.groupOverrides = e.detail; this.groupPreview = null; }}></metric-policy-fields>
        ${this.canEditGroup() ? html`<div class="actions"><button class="btn" .disabled=${this.busy || !this.groupLoaded} @click=${() => this.group('preview')}>预览组影响</button><button class="btn-primary" .disabled=${this.busy || !this.groupPreview} @click=${() => this.group('publish')}>发布策略组</button></div>` : nothing}
        ${this.groupPreview ? html`<p>影响 ${this.groupPreview.affected_resources} 个资源，每小时逻辑读取 ${this.groupPreview.requests_per_hour_before} → ${this.groupPreview.requests_per_hour_after}</p>` : nothing}</app-card>
      ` : html`<app-card><h2 slot="header">指标目录</h2><p>Canonical 为产品固定语义；Extension 是包提供的扩展指标。核心列不受模板重排。</p><div class="scroll"><app-data-table .loading=${!c} .columns=${[{ key: 'id', label: 'ID' }, { key: 'category', label: 'Canonical / Extension' }, { key: 'semantic_version', label: '语义版本' }, { key: 'unit', label: '单位' }, { key: 'kind', label: 'Kind' }, { key: 'resource_type', label: '资源范围' }]} .rows=${c?.metrics ?? []}></app-data-table></div></app-card>`}`;
  }
}
