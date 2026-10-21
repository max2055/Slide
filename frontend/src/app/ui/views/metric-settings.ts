import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { packageGroups, directoryMetricName, packageMetrics, packagePurpose, templateName, scopeLabel, compatibilityLabel, applicabilityLabel, type Release, type PackageEvidence } from '../components/metric-package-directory.js';
import type { RecommendationResult, CollectionStatus } from '../components/metric-api.js';
import { showToast } from '../components/app-toast-container.js';
import { metricRequest, metricError, type Catalog, type Overrides } from '../components/metric-configuration.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import '../components/resource-collection-section.js';
import type { PolicyGroup } from '../components/metric-api.js';
import { authFetch } from '../../../api/index.js';
import { metricName, packageName, resourceLabels } from '../components/resource-metric-summary.js';
import { numericFields } from '../components/metric-policy-fields.js';
import '../components/app-notice.js';

@customElement('metric-settings')
export class MetricSettings extends LitElement {
  @property() view = 'catalog';
  @state() private catalog: Catalog | null = null;
  @state() private error = '';
  @state() private catalogError = '';
  @state() private type = 'instance';
  @state() private search = '';
  @state() private category = '';
  @state() private packageSearch = '';
  @state() private packageType = '';
  @state() private packageDetail = '';
  @state() private packageResource = '';
  @state() private packageEvidence: PackageEvidence[] = [];
  @state() private compatibilityLoading = false;
  @state() private compatibilityError = '';
  private compatibilityGeneration = 0;
  @state() private packageBindings: CollectionStatus[] = [];
  @state() private bindingsLoading = false;
  @state() private bindingsIncomplete = true;
  private bindingsGeneration = 0;

  @state() private policyTab = 'resource';
  @state() private resources: Array<{ resource: { type: string; id: number }; label: string; attributes?: Record<string, unknown> }> = [];
  @state() private resourceNotice = '';
  @state() private resourceId = 0;
  @state() private groups: PolicyGroup[] = [];
  @state() private groupSearch = '';
  @state() private groupError = '';
  @state() private groupId = '';
  @state() private groupRevision = 0;
  @state() private groupOverrides: Overrides = {};
  @state() private groupPreview: { affected_resources: number; requests_per_hour_before: number; requests_per_hour_after: number } | null = null;
  @state() private busy = false;
  @state() private groupLoaded = false;
  @state() private groupManage = false;
  @state() private audits: Array<{ action: string; revision: number; at: string; configuration: unknown }> = [];
  @state() private auditLoading = false;
  @state() private auditError = '';
  private auditGeneration = 0;
  private accessGeneration = 0;
  private groupsGeneration = 0;
  private groupSearchTimer?: ReturnType<typeof setTimeout>;
  private readonly accessChanged = () => {
    this.bindingsGeneration++; this.packageBindings = []; this.bindingsLoading = false; this.bindingsIncomplete = true;
    this.accessGeneration++; this.auditGeneration++; this.groupsGeneration++;
    clearTimeout(this.groupSearchTimer);
    this.packageDetail = ''; this.packageResource = ''; this.packageEvidence = [];
    this.compatibilityGeneration++; this.compatibilityLoading = false; this.compatibilityError = '';
    this.catalog = null; this.resources = []; this.resourceId = 0; this.groups = []; this.audits = [];
    this.groupId = ''; this.groupLoaded = false; this.groupManage = false; this.groupOverrides = {};
    this.groupPreview = null; this.busy = false; this.auditLoading = false;
    this.error = '权限或登录状态已变更，请重新打开设置后读取配置';
  };
  override willUpdate(changes: Map<string, unknown>) {
    if (changes.has('view') && this.view === 'packages' && this.resources.length) void this.loadPackageBindings();
    if (['view', 'resourceId', 'type'].some(k => changes.has(k))) {
      this.audits = []; this.auditError = ''; this.auditGeneration++;
      if (this.view === 'audit' && this.resourceId) void this.loadAudit();
    }
  }
  override disconnectedCallback() {
    this.bindingsGeneration++;
    this.accessGeneration++; this.auditGeneration++; this.groupsGeneration++; this.compatibilityGeneration++; clearTimeout(this.groupSearchTimer);
    window.removeEventListener('slide-permissions-loaded', this.accessChanged);
    window.removeEventListener('slide-session-expired', this.accessChanged);
    super.disconnectedCallback();
  }
  private async loadAudit() {
    const generation = ++this.auditGeneration;
    this.auditLoading = true; this.auditError = '';
    try {
      const rows = await metricRequest<MetricSettings['audits']>(`policy/resources/${this.type}/${this.resourceId}/audit`);
      if (generation === this.auditGeneration) this.audits = rows;
    } catch (e) { if (generation === this.auditGeneration) { this.audits = []; this.auditError = metricError(e); } }
    finally { if (generation === this.auditGeneration) this.auditLoading = false; }
  }
  private renderAudit() {
    return html`<h3>最近变更审计（最多 100 条）</h3><button class="btn btn-refresh" ?disabled=${this.auditLoading} @click=${this.loadAudit}>刷新审计</button>
      ${this.auditError ? html`<p role="alert">${this.auditError}</p>` : html`<div class="scroll"><app-data-table .loading=${this.auditLoading}
        .columns=${[{ key: 'action', label: '操作' }, { key: 'revision', label: '发布版本' }, { key: 'at', label: '时间' }, { key: 'detail', label: '变更详情' }]}
        .rows=${this.audits.map(a => ({ action: a.action === 'binding.publish' ? '发布资源配置' : a.action === 'group.publish' ? '发布策略组' : a.action,
          revision: a.revision, at: new Date(a.at).toLocaleString('zh-CN'), detail: html`<details><summary>配置与覆盖</summary><pre>${JSON.stringify(a.configuration, null, 2)}</pre></details>` }))}
        emptyMessage="暂无配置变更记录"></app-data-table></div>`}`;
  }
  static componentStyles = [sharedBtnStyles, css`
    :host { display:block; min-width:0; } .scroll { overflow:auto; max-width:100%; } app-data-table { min-width:48rem; }
    input,select,textarea { box-sizing:border-box; max-width:100%; width:100%; padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); background:var(--bg); }
    .actions { display:flex; flex-wrap:wrap; gap:var(--space-sm); margin-block:var(--space-md); }
    .filter-toolbar { display:flex; flex-wrap:wrap; gap:var(--space-md); margin-block:var(--space-lg); }
    .filter-toolbar app-form-field { flex:1 1 10rem; min-width:0; margin-bottom:0; }
    .filter-toolbar app-form-field:first-child { flex:2 1 16rem; }
    .filter-toolbar button { align-self:end; }
    .filter-toolbar{padding-inline:var(--space-lg)}.table-foot{padding:var(--space-md) var(--space-lg);color:var(--muted);font-size:12px;border-top:1px solid var(--border)}.template-note{margin-block:var(--space-xl);font-size:12px;color:var(--muted)}
    .package-entry { border-top:1px solid var(--border); padding-block:var(--space-md); overflow-wrap:anywhere; }
    summary { cursor:pointer; color:var(--text-strong); }
    .package-summary { display:inline-grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--space-sm) var(--space-md); width:calc(100% - 1.5em); vertical-align:top; }
    .package-table { min-width:60rem; } .package-table .data-table { table-layout:fixed; } .package-table td { overflow-wrap:anywhere; }
    .version-list { margin-top:var(--space-sm); } .version-list li { margin-block:var(--space-sm); }
    .directory-context { padding:var(--space-md) var(--space-lg); border-top:1px solid var(--border); }
    .directory-context p { margin-block:var(--space-sm); }
    .package-meta { color:var(--muted); font-size:var(--text-sm); }
    .package-sections { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr)); gap:var(--space-md); margin-block:var(--space-lg); }
    .package-sections h3 { margin-top:0; font-size:var(--text-base); }
    .package-sections ul { padding-left:var(--space-lg); margin:0; }
    .package-sections li + li { margin-top:var(--space-sm); }
    .package-sections p { margin-block:var(--space-sm); }
    .skeleton { height:4rem; margin-block:var(--space-md); border-radius:var(--radius-sm); background:var(--bg-hover); }
    @media (max-width:720px) {
      .package-summary { grid-template-columns:minmax(0,1fr); }
      .package-table { min-width:0; }
      .package-table .data-table, .package-table tbody, .package-table tr, .package-table td { display:block; width:100%; box-sizing:border-box; }
      .package-table thead { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
      .package-table tr { border-bottom:1px solid var(--border); padding-block:var(--space-sm); }
      .package-table td { border:0; padding:var(--space-sm) var(--space-lg); }
      .package-table td:nth-child(3)::before { content:'适用范围：'; color:var(--muted); }
      .package-table td:nth-child(4)::before { content:'指标覆盖与绑定'; display:block; color:var(--muted); }
      .package-table td small { display:block; }
    }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; }
  `];
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.accessChanged);
    window.addEventListener('slide-session-expired', this.accessChanged);
    void this.load(); void this.loadResources(); void this.loadGroups();
  }
  private searchGroups(value: string) {
    this.groupSearch = value; this.groupsGeneration++; clearTimeout(this.groupSearchTimer);
    this.groupSearchTimer = setTimeout(() => void this.loadGroups(), 250);
  }
  private async loadGroups() {
    const generation = ++this.groupsGeneration;
    this.groupError = '';
    try {
      const result = await metricRequest<{ groups: PolicyGroup[] }>(`policy/groups${this.groupSearch.trim() ? `?query=${encodeURIComponent(this.groupSearch.trim())}` : ''}`);
      if (generation !== this.groupsGeneration) return;
      const selected = this.groups.find(g => g.id === this.groupId);
      this.groups = selected && !result.groups.some(g => g.id === selected.id) ? [selected, ...result.groups] : result.groups;
    } catch (e) { if (generation === this.groupsGeneration) { this.groups = []; this.groupError = metricError(e); } }
  }
  private async loadResources() {
    const generation = this.accessGeneration;
    try {
      const response = await authFetch('/api/resources');
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json(); if (generation !== this.accessGeneration) return; this.resources = data.items;
      this.resourceNotice = data.truncated || data.unavailableTypes?.length ? '资源列表不完整；可从资源详情进入采集配置。' : '';
      if (this.view === 'packages') void this.loadPackageBindings();
    } catch (e) { if (generation === this.accessGeneration) { this.resources = []; this.resourceNotice = metricError(e); } }
  }
  // Counts cover only readable resources, with a bounded number of status reads.
  private async loadPackageBindings() {
    const generation = ++this.bindingsGeneration;
    this.packageBindings = []; this.bindingsLoading = true; this.bindingsIncomplete = !!this.resourceNotice || this.resources.length > 50;
    const targets = this.resources.slice(0, 50), statuses: CollectionStatus[] = [];
    let cursor = 0, incomplete = this.bindingsIncomplete;
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
      while (cursor < targets.length && generation === this.bindingsGeneration) {
        const { resource } = targets[cursor++];
        try {
          const status = await metricRequest<CollectionStatus>(`config/resources/${resource.type}/${resource.id}/status`);
          if (!['bound', 'unbound'].includes(status.binding?.state)) { incomplete = true; continue; }
          statuses.push(status);
        } catch { incomplete = true; }
      }
    }));
    if (generation !== this.bindingsGeneration) return;
    this.packageBindings = statuses; this.bindingsIncomplete = incomplete; this.bindingsLoading = false;
  }
  private bindingLabel(p: Release) {
    if (this.bindingsLoading) return '正在读取可见资源绑定数';
    const count = this.packageBindings.filter(s => s.binding.state === 'bound' && s.binding.package?.digest === p.package.digest).length;
    return `可见资源绑定 ${this.bindingsIncomplete ? '至少 ' : ''}${count} 个${this.bindingsIncomplete ? '（统计不完整）' : ''}`;
  }
  private compatibilityReason(p: Release) {
    const evidence = this.evidence(p);
    if (!evidence) return '选择参考资源后可核对引擎、版本等适用条件。';
    return evidence.checks.length ? evidence.checks.map(c => `${applicabilityLabel(c.attribute)}：${c.value ?? '未知'}；支持 ${c.supported_values.join(' / ') || '未提供'}；${c.status === 'supported' ? '符合' : c.status === 'unsupported' ? '不符合' : '待确认'}`).join('。')
      : '服务端未提供适用条件明细，请核对模板范围与资源能力。';
  }
  private async load() {
    const generation = this.accessGeneration; this.catalogError = '';
    try { const catalog = await metricRequest<Catalog>('config/catalog'); if (generation === this.accessGeneration) this.catalog = catalog; }
    catch (e) { if (generation === this.accessGeneration) this.catalogError = metricError(e); }
  }
  private async group(operation: 'load' | 'preview' | 'publish') {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.groupId) || this.busy) return;
    if (operation !== 'load' && (!this.canEditGroup() || operation === 'publish' && !this.groupPreview)) return;
    this.busy = true; this.error = '';
    const generation = this.accessGeneration;
    try {
      const path = `policy/groups/${this.groupId}`;
      if (operation === 'load') {
        this.groupManage = false;
        const access = await metricRequest<{ can_manage: boolean }>(`${path}/access`);
        const group = await metricRequest<{ revision: number; overrides: unknown }>(path).catch(e => { if (e.message === '404') return { revision: 0, overrides: {} }; throw e; });
        if (generation !== this.accessGeneration) return;
        this.groupManage = access.can_manage; this.groupRevision = group.revision; this.groupOverrides = group.overrides as Overrides; this.groupLoaded = true; this.groupPreview = null;
      } else {
        const result = await metricRequest<NonNullable<MetricSettings['groupPreview']>>(`${path}/${operation}`, { expected_revision: this.groupRevision, overrides: this.groupOverrides });
        if (generation !== this.accessGeneration) return;
        this.groupPreview = operation === 'preview' ? result : null;
        if (operation === 'publish') { this.groupLoaded = false; this.groupRevision++; }
      }
    } catch (e) { if (generation === this.accessGeneration) { this.groupPreview = null; this.groupLoaded = false; this.error = metricError(e); } }
    finally { if (generation === this.accessGeneration) this.busy = false; }
  }
  private canEditGroup() { return this.groupManage && this.groupLoaded; }
  render() {
    const c = this.catalog;
    return html`<style>${sharedFieldStyles}${MetricSettings.componentStyles.map(s => s.cssText).join('\n')}
      small { display:block;color:var(--muted);overflow-wrap:anywhere; } :focus-visible { outline:2px solid var(--accent); }
      .metric-page-header h1 { margin:0 0 var(--space-sm); font-size:var(--text-xl); color:var(--text-strong); }
    </style><header class="metric-page-header"><h1>${({ catalog: "指标目录", packages: "指标与采集", policies: "采集策略", audit: "采集审计" } as Record<string, string>)[this.view] ?? "指标与采集"}</h1></header>${this.error ? html`<app-notice role="alert">${this.error}</app-notice>` : nothing}
    ${['policies', 'audit'].includes(this.view) ? this.renderPolicies() : this.view === 'packages' ? this.renderPackages() : html`<app-card><p>标准指标定义只读；扩展指标由采集包提供。修改采集行为请进入资源采集策略。</p>
        <div class="filter-toolbar" role="group" aria-label="指标目录筛选">
        <app-form-field label="搜索名称或标识"><input aria-label="搜索指标" .value=${this.search} @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; }}></app-form-field>
        <app-form-field label="资源类型"><select aria-label="指标资源类型" .value=${this.type} @change=${(e: Event) => { this.type = (e.target as HTMLSelectElement).value; }}><option value="" .selected=${!this.type}>全部</option>${Object.entries(resourceLabels).map(([k,v]) => html`<option value=${k} .selected=${this.type === k}>${v}</option>`)}</select></app-form-field>
        <app-form-field label="来源"><select aria-label="指标来源" .value=${this.category} @change=${(e: Event) => { this.category = (e.target as HTMLSelectElement).value; }}><option value="">全部</option><option value="canonical">标准指标</option><option value="extension">扩展指标</option></select></app-form-field>
        </div>${this.renderCatalogError()}
        ${this.catalogError ? nothing : html`<div class="scroll"><app-data-table .loading=${!c} .columns=${[{ key: 'name', label: '名称' }, { key: 'resource', label: '适用资源' }, { key: 'unit', label: '单位' }, { key: 'kind', label: '指标类型' }, { key: 'category', label: '来源' }, { key: 'detail', label: '详情' }]}
          .rows=${c?.metrics.filter(m => (!this.type || m.resource_type === this.type) && (!this.category || m.category === this.category) && `${metricName(m.id)} ${m.id}`.toLowerCase().includes(this.search.trim().toLowerCase())).map(m => ({ name: html`${metricName(m.id)}<small>${m.id}</small>`, resource: resourceLabels[m.resource_type] ?? m.resource_type, unit: m.unit, kind: m.kind === 'counter' ? '累计计数' : '瞬时值', category: m.category === 'canonical' ? '标准指标' : '扩展指标', detail: html`<details><summary>定义与版本</summary><p>语义版本 ${m.semantic_version}</p><pre>${JSON.stringify(m, null, 2)}</pre></details>` })) ?? []}></app-data-table></div>`}</app-card>`}`;
  }
  private renderCatalogError() {
    return this.catalogError ? html`<app-notice role="alert">${this.catalogError}<button class="btn" @click=${this.load}>重新加载目录</button></app-notice>` : nothing;
  }
  private async loadCompatibility(value: string) {
    const generation = ++this.compatibilityGeneration;
    this.packageResource = value; this.packageEvidence = []; this.compatibilityError = ''; this.packageDetail = '';
    this.compatibilityLoading = !!value;
    if (!value) return;
    const resource = this.resources.find(r => `${r.resource.type}:${r.resource.id}` === value)?.resource;
    if (!resource) { this.compatibilityLoading = false; return; }
    try {
      const result = await metricRequest<RecommendationResult>(`config/resources/${resource.type}/${resource.id}/recommendations`);
      if (generation === this.compatibilityGeneration) this.packageEvidence = result.packages;
    } catch (e) { if (generation === this.compatibilityGeneration) this.compatibilityError = metricError(e); }
    finally { if (generation === this.compatibilityGeneration) this.compatibilityLoading = false; }
  }
  private evidence(p: Release) { return this.packageEvidence.find(e => e.release.package.digest === p.package.digest); }
  private async copyIdentity(p: Release) {
    try { await navigator.clipboard.writeText(`${p.package.id}@${p.package.version}\n${p.package.digest}`); showToast('已复制模板标识', 'success'); }
    catch { showToast('复制失败，请展开技术标识手动复制', 'error'); }
  }
  private openResourceConfiguration() {
    const resource = this.resources.find(r => `${r.resource.type}:${r.resource.id}` === this.packageResource)?.resource;
    this.packageDetail = ''; this.type = resource?.type ?? 'instance'; this.resourceId = resource?.id ?? 0; this.policyTab = 'resource';
    this.view = 'policies';
    const url = new URL(window.location.href); url.searchParams.set('view', 'policies');
    window.history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate'));
  }
  private renderCoverage(p: Release) {
    const metrics = packageMetrics(p), evidence = this.evidence(p);
    const named = metrics.map(directoryMetricName).filter(name => name !== '扩展指标（名称未提供）');
    const unnamed = metrics.length - named.length;
    return html`<strong>${metrics.length} 项指标</strong><small>${named.slice(0, 3).join('、') || (metrics.length ? '扩展指标，技术定义见详情' : '未提供指标映射')}${unnamed && named.length ? `；另有 ${unnamed} 项扩展指标` : ''}</small>
      <small>${evidence ? evidence.missing_core_metrics.length ? `核心缺口 ${evidence.missing_core_metrics.length} 项：${evidence.missing_core_metrics.map(directoryMetricName).join('、')}`
        : '未报告核心指标缺口；样本质量需另行确认' : '核心指标缺口待资源兼容检查确认'}</small>`;
  }
  private renderPackages() {
    const c = this.catalog, query = this.packageSearch.trim().toLowerCase();
    const groups = packageGroups(c?.packages ?? [], this.packageEvidence);
    const filtered = groups.filter(g => (!this.packageType || g.primary.package.resource_type === this.packageType)
      && `${templateName(g.id)} ${g.id} ${g.versions.map(scopeLabel).join(' ')}`.toLowerCase().includes(query));
    const detail = c?.packages.find(p => p.package.digest === this.packageDetail);
    return html`<p>管理共享模板与策略组；对象绑定统一在资源编辑或批量操作中完成。</p>
      <app-card .compact=${true}><div class="filter-toolbar" role="group" aria-label="采集包筛选">
        <app-form-field label="搜索名称或标识"><input type="search" aria-label="搜索采集包" placeholder="搜索模板名称、引擎" .value=${this.packageSearch} @input=${(e: Event) => { this.packageSearch = (e.target as HTMLInputElement).value; }}></app-form-field>
        <app-form-field label="资源类型"><select aria-label="采集包资源类型" .value=${this.packageType} @change=${(e: Event) => { this.packageType = (e.target as HTMLSelectElement).value; }}><option value="">全部</option>${Object.entries(resourceLabels).map(([k,v]) => html`<option value=${k}>${v}</option>`)}</select></app-form-field>
        <button class="btn" .disabled=${!this.packageSearch && !this.packageType} @click=${() => { this.packageSearch = ''; this.packageType = ''; }}>清空筛选</button>
      </div><div class="directory-context">
        <app-form-field label="兼容性参考资源（可选）"><select aria-label="兼容性参考资源" .value=${this.packageResource} @change=${(e: Event) => void this.loadCompatibility((e.target as HTMLSelectElement).value)}>
          <option value="">全局浏览 · 未指定资源</option>${this.resources.map(r => html`<option value=${`${r.resource.type}:${r.resource.id}`}>${r.label} · ${resourceLabels[r.resource.type] ?? r.resource.type}</option>`)}</select></app-form-field>
        ${this.resourceNotice ? html`<p role="status">${this.resourceNotice}<button class="btn btn-sm" @click=${this.loadResources}>重试资源列表</button></p>` : nothing}
        <p role="status">${this.compatibilityLoading ? '正在检查资源兼容性，暂不提供推荐' : this.compatibilityError ? '兼容性暂不可确认，目录版本不代表推荐。' : this.packageResource ? '按服务端兼容性证据展示版本；浏览不会改变既有绑定。' : '未指定资源：按版本顺序展示目录，最高版本不代表兼容或推荐。'}</p>
        ${this.compatibilityError ? html`<app-notice role="alert">兼容性检查失败：${this.compatibilityError}<button class="btn" @click=${() => void this.loadCompatibility(this.packageResource)}>重试兼容检查</button></app-notice>` : nothing}
      </div>${this.renderCatalogError()}
      ${this.catalogError ? nothing : html`<div class="scroll" role="region" aria-label="采集模板目录" tabindex="0"><app-data-table class="package-table" .loading=${!c} .columns=${[{ key: 'name', label: '模板与用途', width: '12rem' }, { key: 'version', label: '展示版本', width: '12rem' }, { key: 'scope', label: '适用范围', width: '12rem' }, { key: 'coverage', label: '指标覆盖与缺口', width: '16rem' }, { key: 'actions', label: '操作', width: '6rem' }]}
        .rows=${filtered.map(g => ({
          name: html`<strong>${templateName(g.id)}</strong><small>${packagePurpose(g.primary)}</small><details><summary>模板标识</summary><small>${g.id}</small></details>`,
          version: html`v${g.primary.package.version}<small>${compatibilityLabel(this.evidence(g.primary))}</small><small>${this.compatibilityReason(g.primary)}</small>${g.others.length ? html`<details class="version-list"><summary>其他与历史版本（${g.others.length}）</summary><ul>${g.others.map(p => html`<li>v${p.package.version} · ${compatibilityLabel(this.evidence(p))}<small>${scopeLabel(p)} · ${packageMetrics(p).length} 项指标</small><small>${this.bindingLabel(p)}</small><button class="btn btn-sm btn-ghost" aria-label=${`查看 ${templateName(g.id)} ${p.package.version}`} @click=${() => { this.packageDetail = p.package.digest; }}>查看此版本</button></li>`)}</ul></details>` : nothing}`,
          scope: scopeLabel(g.primary), coverage: html`${this.renderCoverage(g.primary)}<small>${this.bindingLabel(g.primary)}</small>`,
          actions: html`<button class="btn btn-sm btn-ghost" @click=${() => { this.packageDetail = g.primary.package.digest; }}>查看模板</button>`,
        }))} emptyMessage=${c?.packages.length ? '没有符合条件的采集包' : '暂无采集包'}></app-data-table></div>`}
      ${this.catalogError ? nothing : html`<p class="table-foot" role="status" aria-label=${!c ? '正在读取采集包' : nothing}>${c ? `显示 ${filtered.length} / ${groups.length} 个模板 · 共 ${c.packages.length} 个不可变版本` : '正在读取采集包'}</p>`}
      </app-card><section class="template-note"><h3>一个标准，保留有意义的版本</h3><p>历史版本用于追溯、兼容检查与回滚；基础包与诊断包独立保留，不自动替换既有绑定。目录覆盖不代表已有正式样本。</p>
        <button class="btn" @click=${this.openResourceConfiguration}>${this.packageResource ? '管理此资源的采集配置' : '选择资源并检查、试采'}</button></section>
      <app-dialog .open=${!!detail} title="采集模板详情" size="lg" @app-dialog-close=${() => { this.packageDetail = ''; }}>
        ${detail ? keyed(detail.package.digest, this.renderPackage(detail)) : nothing}<div slot="footer"><button class="btn" @click=${() => { this.packageDetail = ''; }}>关闭</button><button class="btn-primary" @click=${this.openResourceConfiguration}>${this.packageResource ? '管理此资源的采集配置' : '选择资源并检查、试采'}</button></div>
      </app-dialog>`;
  }
  private renderPackage(p: Catalog['packages'][number]) {
    const metrics = packageMetrics(p);
    const applicability = p.package.applicability ?? [];
    const engines = applicability.filter(a => ['db.engine', 'os.family'].includes(a.attribute)).flatMap(a => a.values);
    const attributeLabel = applicabilityLabel;
    return html`<details class="package-entry" open><summary><span class="package-summary">
      <span><strong>${templateName(p.package.id)}</strong><small>${packagePurpose(p)}</small></span>
      <span class="package-meta">${resourceLabels[p.package.resource_type] ?? p.package.resource_type}${engines.length ? ` · ${engines.join(' / ')}` : ''} · v${p.package.version} · ${metrics.length} 项指标</span>
    </span></summary><p>${compatibilityLabel(this.evidence(p))} · 此处查看版本不会修改任何资源配置</p><p>${this.compatibilityReason(p)}</p><p>${this.bindingLabel(p)}</p>
      ${this.renderCoverage(p)}
      <details><summary>技术标识（可复制）</summary><p>${p.package.id}@${p.package.version}</p><p>${p.package.digest}</p><button class="btn btn-sm" @click=${() => void this.copyIdentity(p)}>复制模板标识</button></details>
      <div class="package-sections">
      <section><h3>包含指标</h3>${metrics.length ? html`<ul>${metrics.map(id => html`<li>${directoryMetricName(id)}<details><summary>指标技术标识</summary><small>${id}</small></details></li>`)}</ul>` : html`<p>未提供指标映射</p>`}</section>
      <section><h3>适用范围</h3><p>${resourceLabels[p.package.resource_type] ?? p.package.resource_type}</p>${applicability.length ? applicability.map(a => html`<p>${attributeLabel(a.attribute)}：${a.values.join(' / ')}</p>`) : html`<p>未提供适用条件</p>`}</section>
      <section><h3>所需权限</h3>${p.documentation.length ? p.documentation.map(d => html`<p>${d.collector_id ? html`<small>${d.collector_id}</small>` : nothing}${d.permissions?.join('；') || '未提供权限说明'}</p>`) : html`<p>未提供权限说明</p>`}</section>
      <section><h3>发现方式</h3>${p.documentation.length ? p.documentation.map(d => html`<p>${d.collector_id ? html`<small>${d.collector_id}</small>` : nothing}${d.discovery || '未提供发现方式'}</p>`) : html`<p>未提供发现方式</p>`}</section>
      <section><h3>推荐周期与配置</h3>${Object.keys(p.recommendations).length ? Object.entries(p.recommendations).map(([k,v]) => html`<p>${numericFields[k as keyof typeof numericFields] ?? (k === 'enabled' ? '采集开关' : k)}：${k.endsWith('_ms') ? Number(v) / 1000 : typeof v === 'boolean' ? v ? '启用' : '停用' : v}</p>`) : html`<p>未提供推荐配置</p>`}</section>
    </div><details><summary>高级详情：原始 JSON</summary><pre>${JSON.stringify(p, null, 2)}</pre></details></details>`;
  }
  private changeResource(action: () => void) {
    const config = this.renderRoot.querySelector('resource-collection-section') as import('../components/resource-collection-section.js').ResourceCollectionSection | null;
    if (config) config.confirmDiscard(action); else action();
  }
  private renderPolicies() {
    return html`${this.view !== 'audit' ? html`<div class="actions"><button class="btn" .disabled=${this.policyTab === 'resource'} @click=${() => { this.policyTab = 'resource'; }}>资源策略</button><button class="btn" .disabled=${this.policyTab === 'group'} @click=${() => { this.changeResource(() => { this.policyTab = 'group'; }); }}>策略组</button></div>` : nothing}
      ${this.view === 'audit' || this.policyTab === 'resource' ? html`<app-card><h2 slot="header">资源采集策略</h2>
        <app-form-field label="资源类型"><select .value=${this.type} @change=${(e: Event) => { const select = e.target as HTMLSelectElement, type = select.value; select.value = this.type; this.changeResource(() => { this.type = type; this.resourceId = 0; }); }}>${Object.entries(resourceLabels).map(([k,v]) => html`<option value=${k} .selected=${this.type === k}>${v}</option>`)}</select></app-form-field>
        <app-form-field label="搜索资源"><input aria-label="搜索资源" .value=${this.search} @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; }}></app-form-field>
        <app-form-field label="资源"><select aria-label="资源" .value=${String(this.resourceId)} @change=${(e: Event) => { const select = e.target as HTMLSelectElement, id = Number(select.value); select.value = String(this.resourceId); this.changeResource(() => { this.resourceId = id; }); }}><option value="0" .selected=${!this.resourceId}>请选择资源</option>${this.resources.filter(r => r.resource.type === this.type && (r.resource.id === this.resourceId || `${r.label} ${r.attributes?.host ?? ''}`.toLowerCase().includes(this.search.toLowerCase()))).map(r => html`<option value=${String(r.resource.id)} .selected=${this.resourceId === r.resource.id}>${r.label} · ${r.attributes?.host ?? resourceLabels[r.resource.type]}</option>`)}</select></app-form-field>
        <p role="status">${this.resourceNotice}</p>${this.resourceNotice ? html`<button class="btn" @click=${this.loadResources}>重试资源列表</button>` : nothing}
        ${this.resourceId > 0 ? this.view === 'audit' ? this.renderAudit() : html`<resource-collection-section .resourceType=${this.type} .resourceId=${this.resourceId}></resource-collection-section>` : html`<app-empty-state title="选择资源后管理采集配置"></app-empty-state>`}</app-card>` : html`
      <app-card><h2 slot="header">策略组</h2><p>选择可见策略组，预览影响后发布。未覆盖字段保留继承。</p>
        ${this.groupError ? html`<p role="alert">${this.groupError}</p><button class="btn" @click=${this.loadGroups}>重试策略组列表</button>` : nothing}
        <app-form-field label="搜索策略组"><input type="search" aria-label="搜索策略组" .value=${this.groupSearch} @input=${(e: Event) => this.searchGroups((e.target as HTMLInputElement).value)}></app-form-field>
        <app-form-field label="策略组"><select aria-label="策略组" .value=${this.groupId} ?disabled=${this.busy} @change=${(e: Event) => { this.groupId = (e.target as HTMLSelectElement).value; this.groupLoaded = false; this.groupPreview = null; this.groupManage = false; }}>
          <option value="">请选择策略组</option>${this.groups.filter(g => g.id === this.groupId || `${g.label ?? ''} ${g.id}`.toLowerCase().includes(this.groupSearch.trim().toLowerCase())).map(g => html`<option value=${g.id}>${g.label || g.id}</option>`)}</select></app-form-field>
        ${!this.groupError && !this.groups.length ? html`<app-empty-state title="暂无可见策略组"></app-empty-state>` : nothing}
        <button class="btn" .disabled=${this.busy} @click=${() => this.group('load')}>读取策略组</button><p>发布版本 ${this.groupRevision}；未覆盖字段继承采集包与平台值。</p>
        <metric-policy-fields .overrides=${this.groupOverrides} .disabled=${this.busy || !this.canEditGroup()} @policy-change=${(e: CustomEvent<Overrides>) => { this.groupOverrides = e.detail; this.groupPreview = null; }}></metric-policy-fields>
        ${this.canEditGroup() ? html`<div class="actions"><button class="btn" .disabled=${this.busy} @click=${() => this.group('preview')}>预览组影响</button><button class="btn-primary" .disabled=${this.busy || !this.groupPreview} @click=${() => this.group('publish')}>发布策略组</button></div>` : nothing}
        ${this.groupPreview ? html`<p>影响 ${this.groupPreview.affected_resources} 个资源，每小时逻辑读取 ${this.groupPreview.requests_per_hour_before} → ${this.groupPreview.requests_per_hour_after}</p>` : nothing}</app-card>`}`;
  }
}
