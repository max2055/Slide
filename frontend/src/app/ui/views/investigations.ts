import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.ts';
import type { DirectGatewayClient } from '../direct-gateway.ts';
import { InvestigationsController } from '../controllers/investigations.ts';
import { renderInvestigationDetail, lifecycleLabels } from './investigation-detail.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { displayTime } from './diagnosis-presentation.ts';
import { icons } from '../../../icons.ts';
import { hasSlidePermission } from '../app-settings.ts';
import '../components/app-card.ts';
import '../components/app-form-field.ts';
import '../components/app-dialog.ts';
import '../components/app-data-table.ts';
import '../components/app-empty-state.ts';
import '../components/investigation-create.ts';

// The existing compact nav is fixed at tablet widths; reserve its visible rail.
const workspaceShellStyles = `@media(max-width:1100px) {
  .shell--workspace.shell--nav-collapsed:not(.shell--nav-drawer-open) {
    grid-template-columns:var(--shell-nav-rail-width) minmax(0,1fr);
    grid-template-areas:"nav topbar" "nav content";
  }
  :root[data-sidebar-position="right"] .shell--workspace.shell--nav-collapsed:not(.shell--nav-drawer-open) {
    grid-template-columns:minmax(0,1fr) var(--shell-nav-rail-width);
    grid-template-areas:"topbar nav" "content nav";
  }
}`;

@customElement('investigations-page')
export class InvestigationsPage extends LitElement {
  @property({ attribute: false }) client: DirectGatewayClient | null = null;
  @property({ attribute: false }) permissions: Set<string> | null = null;
  @state() private createOpen = false;
  @state() private evidenceOpen = false;
  @state() private query = new URL(location.href).searchParams.get('query') ?? '';
  @state() private lifecycle = new URL(location.href).searchParams.get('state') ?? '';
  @state() private profile = new URL(location.href).searchParams.get('profile') ?? '';
  @state() private resource = '';
  @state() private draft = '';
  @state() private resources: string[] = new URL(location.href).searchParams.getAll('resource');
  @state() private resourceFilterOpen = !!(this.profile || this.resources.length);
  controller = new InvestigationsController(() => this.refreshControllerView(), null);
  private refreshControllerView() {
    if (this.controller.forbidden) { this.draft = ''; this.evidenceOpen = false; this.createOpen = false; }
    this.requestUpdate();
  }
  private popState = () => {
    const url = new URL(location.href); this.query = url.searchParams.get('query') ?? ''; this.lifecycle = url.searchParams.get('state') ?? '';
    this.profile = url.searchParams.get('profile') ?? ''; this.resources = url.searchParams.getAll('resource'); this.resource = '';
    void this.filter(false); const id = url.searchParams.get('investigation');
    if (id) void this.openInvestigation(id, false); else { this.controller.deselect(); this.draft = ''; this.evidenceOpen = false; }
  };
  private permissionsChanged = (e: Event) => {
    this.permissions = new Set((e as CustomEvent<{ permissions: string[] }>).detail.permissions);
    this.controller.clearSensitive(); this.draft = ''; this.evidenceOpen = false; this.createOpen = false; this.resources = []; this.resource = '';
    if (this.canView) this.reload(); this.requestUpdate();
  };
  private sessionExpired = () => { this.controller.clearSensitive(); this.draft = ''; this.evidenceOpen = false; this.createOpen = false; this.resources = []; this.resource = ''; this.requestUpdate(); };
  createRenderRoot() { return this; }
  get canView() { return hasSlidePermission(this.permissions, 'chat:view'); }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('popstate', this.popState);
    window.addEventListener('slide-permissions-loaded', this.permissionsChanged);
    window.addEventListener('slide-session-expired', this.sessionExpired);
  }
  disconnectedCallback() {
    this.controller.dispose();
    window.removeEventListener('popstate', this.popState);
    window.removeEventListener('slide-permissions-loaded', this.permissionsChanged);
    window.removeEventListener('slide-session-expired', this.sessionExpired);
    super.disconnectedCallback();
  }
  protected updated(changed: Map<string, unknown>) {
    if (changed.has('client')) {
      this.controller.dispose(); this.controller = new InvestigationsController(() => this.refreshControllerView(), this.client);
      if (this.canView) this.reload();
    } else if (changed.has('permissions')) {
      if (!this.canView) this.sessionExpired();
      else if (!this.controller.detail && !this.controller.loading) this.reload();
    }
  }
  private reload() {
    this.controller.forbidden = false; void this.filter();
    const id = new URL(location.href).searchParams.get('investigation');
    if (id) void this.openInvestigation(id, false);
  }
  private filter(push = true) {
    const query = new URLSearchParams();
    if (this.query.trim()) query.set('query', this.query.trim());
    if (this.lifecycle) query.set('state', this.lifecycle);
    if (this.profile) query.set('profile', this.profile);
    const resources = [...new Set([...this.resources, ...this.resource.split(',').map(value => value.trim()).filter(Boolean)])];
    if (resources.some(ref => !/^(instance|server|network_device):[1-9]\d*$/.test(ref) || !Number.isSafeInteger(Number(ref.split(':')[1])))) {
      this.controller.error = '请填写有效资源标识，例如 instance:1, server:3。'; this.requestUpdate(); return;
    }
    if (push) {
      const url = new URL(location.href);
      for (const key of ['query', 'state', 'profile', 'resource']) url.searchParams.delete(key);
      query.forEach((value, key) => url.searchParams.set(key, value)); resources.forEach(ref => url.searchParams.append('resource', ref));
      if (url.href !== location.href) history.pushState({}, '', url);
    }
    return this.controller.loadList(query.toString(), false, resources);
  }
  private async openInvestigation(id: string, push = true) {
    this.draft = ''; this.evidenceOpen = false;
    if (push) { const url = new URL(location.href); url.searchParams.set('investigation', id); history.pushState({}, '', url); }
    await this.controller.select(id);
  }
  render() {
    const c = this.controller;
    const filtered = !!(this.query.trim() || this.lifecycle || this.profile || this.resources.length || this.resource.trim());
    const advancedCount = Number(!!this.profile) + this.resources.length + Number(!!this.resource.trim());
    const firstUse = c.listLoaded && !c.loading && !c.listError && !c.error && !c.list.items.length && !filtered && !c.detail && !c.detailLoading;
    return html`<style>${sharedBtnStyles.cssText}${workspaceShellStyles}
      investigations-page { display:block; min-width:0; }
      investigations-page .workspace { display:grid; grid-template-columns:minmax(180px, 240px) minmax(0, 1fr) minmax(240px, 320px); gap:var(--space-md); align-items:start; }
      investigations-page .workspace > * { min-width:0; }
      investigations-page .workspace-main { display:grid; gap:var(--space-md); }
      investigations-page .workspace-header, investigations-page .workspace-actions { display:flex; align-items:center; justify-content:space-between; gap:var(--space-sm); flex-wrap:wrap; margin-bottom:var(--space-md); }
      investigations-page h1 { margin:0; font-size:calc(var(--text-lg) * 1.5); font-weight:600; line-height:1.35; color:var(--text-strong); }
      investigations-page h2 { font-size:calc(var(--text-lg) * 1.5); font-weight:600; line-height:1.4; margin:var(--space-sm) 0 var(--space-md); color:var(--text-strong); }
      investigations-page h3 { font-size:var(--text-md); font-weight:600; color:var(--text-strong); margin:0 0 var(--space-sm); }
      investigations-page .workspace-header { margin-bottom:var(--space-lg); }
      investigations-page .workspace-header p { color:var(--muted); font-size:14px; margin:var(--space-xs) 0 0; }
      investigations-page .workspace-filters { margin-bottom:var(--space-md); }
      investigations-page .workspace-filter-common { display:flex; align-items:center; flex-wrap:wrap; gap:var(--space-sm); padding-bottom:var(--space-lg); }
      investigations-page .workspace-search { flex:1 1 180px; max-width:380px; min-width:0; }
      investigations-page .workspace-status { flex:0 1 140px; min-width:0; }
      investigations-page .workspace-filter-common input, investigations-page .workspace-filter-common select { min-height:36px; }
      investigations-page .workspace-filter-common .btn, investigations-page .workspace-filter-common .btn-ghost { min-height:36px; font-size:var(--text-sm); }
      investigations-page .workspace-advanced-toggle { gap:var(--space-xs); }
      investigations-page .workspace-advanced-toggle svg { width:14px; height:14px; transition:transform .15s; }
      investigations-page .workspace-advanced-toggle[aria-expanded=true] svg { transform:rotate(90deg); }
      investigations-page .workspace-filter-advanced { padding:var(--space-lg); margin-bottom:var(--space-md); border:1px solid var(--border); border-radius:var(--radius-md); background:var(--panel); }
      investigations-page .workspace-filter-advanced app-form-field { max-width:720px; margin-bottom:var(--space-md); }
      investigations-page .workspace-filter-advanced app-form-field:last-child { margin-bottom:0; }
      investigations-page .workspace-filter-advanced .workspace-profile { max-width:220px; }
      investigations-page .workspace-filter-advanced investigation-resource-picker { max-width:720px; margin:var(--space-md) 0; }
      investigations-page .workspace-filter-advanced h3 { font-size:var(--text-sm); }
      investigations-page .workspace-filter-label { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
      investigations-page app-card::part(header) { font-size:var(--text-lg); font-weight:600; }
      investigations-page .workspace-start { display:grid; grid-template-columns:minmax(0,1fr) 276px; gap:var(--space-lg); align-items:start; }
      investigations-page .workspace-start app-card::part(footer), investigations-page .start-intro::part(header) { display:none; }
      investigations-page .start-panel { padding:calc(var(--space-xl) + var(--space-md)) calc(var(--space-xl) + var(--space-sm)); max-width:720px; }
      investigations-page .start-signature { display:flex; gap:var(--space-sm); align-items:center; color:var(--muted); font-size:12px; }
      investigations-page .start-signature svg { width:18px; height:18px; color:var(--accent); }
      investigations-page .start-panel > p { max-width:510px; font-size:14px; line-height:1.7; color:var(--muted); margin-bottom:var(--space-lg); }
      investigations-page .start-steps { display:grid; gap:var(--space-xl); list-style:none; padding:0; margin:var(--space-lg) 0; }
      investigations-page .start-steps li { display:flex; gap:var(--space-md); align-items:start; }
      investigations-page .step-number { display:grid; place-items:center; width:26px; height:26px; flex-shrink:0; color:var(--accent-text); background:var(--accent-subtle); border-radius:var(--radius-sm); font-size:12px; }
      investigations-page .start-steps p, investigations-page .start-note p { color:var(--muted); font-size:12px; line-height:1.7; margin:0; }
      investigations-page .start-steps p { margin:var(--space-md) 0 var(--space-lg); }
      investigations-page .start-note + .start-note { border-top:1px solid var(--border); margin-top:var(--space-md); padding-top:var(--space-md); }
      investigations-page .workspace-list-count { font-size:12px; color:var(--muted); margin:0; }
      @media(max-width:850px) { investigations-page .workspace-start { grid-template-columns:minmax(0,1fr); } }
      @media(max-width:600px) { investigations-page .start-panel { padding:var(--space-xl) 0; } investigations-page .workspace-search { flex-basis:100%; max-width:none; } investigations-page .workspace-status { flex:1 1 130px; } }
      investigations-page input, investigations-page select, investigations-page textarea { box-sizing:border-box; width:100%; min-width:0; background:var(--input-bg); color:var(--text); font:inherit; font-size:var(--text-md); padding:var(--space-sm); border:1px solid var(--border-strong); border-radius:var(--radius-sm); }
      investigations-page input:focus-visible, investigations-page select:focus-visible, investigations-page textarea:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
      investigations-page .investigation-list { display:grid; gap:var(--space-sm); }
      investigations-page .investigation-list button { display:block; white-space:normal; text-align:left; width:100%; overflow-wrap:anywhere; }
      investigations-page .investigation-list [aria-current=true] { border-color:var(--accent); }
      investigations-page .investigation-states { display:flex; flex-wrap:wrap; gap:var(--space-md); }
      investigations-page dt, investigations-page .muted { color:var(--muted); font-size:var(--text-sm); }
      investigations-page dd { margin:var(--space-xs) 0; }
      investigations-page p, investigations-page .investigation-messages { overflow-wrap:anywhere; }
      investigations-page .investigation-messages { min-width:0; }
      investigations-page .investigation-result-summary { white-space:pre-wrap; line-height:1.7; }
      investigations-page details summary { cursor:pointer; color:var(--accent); padding:var(--space-sm) 0; }
      investigations-page details dd { overflow-wrap:anywhere; }
      investigations-page .investigation-messages .chat-group { max-width:100%; }
      investigations-page .investigation-messages pre { max-width:100%; overflow:auto; }
      investigations-page .evidence-toggle { display:none; }
      investigations-page .workspace-error { margin:var(--space-md) 0; color:var(--danger); }
      @media(max-width:1439px) { investigations-page .workspace { grid-template-columns:minmax(160px, 220px) minmax(0, 1fr); } investigations-page .workspace-context { display:none; } investigations-page .evidence-toggle { display:inline-flex; } }
      @media(max-width:767px) { investigations-page .workspace { grid-template-columns:minmax(0,1fr); } investigations-page .investigation-list { max-height:220px; overflow:auto; } }
    </style>
    ${!this.canView ? html`<app-empty-state title="无访问权限" description="需要对话读取权限。"></app-empty-state>` : html`
      <div class="workspace-header"><div><h1>AI 工作空间</h1><p>明确范围，保留过程，用证据支持判断。</p></div><button class="btn-primary" @click=${() => this.createOpen = true}>创建手动调查</button></div>
      ${c.error ? html`<div class="workspace-error" role="alert">${c.error}${c.acceptanceUnknown ? html`<button class="btn" ?disabled=${c.busy} @click=${() => void c.retryPending()}>核对原请求</button>` : nothing}<button class="btn" @click=${this.reload}>重试读取</button></div>` : nothing}
      <form class="workspace-filters" aria-label="调查筛选" @submit=${(e: Event) => { e.preventDefault(); void this.filter(); }}>
        <div class="workspace-filter-common">
          <label class="workspace-search"><span class="workspace-filter-label">搜索调查</span><input aria-label="搜索调查" placeholder="按调查名称查找" .value=${this.query} @input=${(e: Event) => this.query = (e.target as HTMLInputElement).value}></label>
          <label class="workspace-status"><span class="workspace-filter-label">调查状态</span><select aria-label="调查状态" .value=${this.lifecycle} @change=${(e: Event) => { this.lifecycle = (e.target as HTMLSelectElement).value; void this.filter(); }}><option value="">全部状态</option><option value="open">开放</option><option value="waiting">等待处理</option><option value="closed">已关闭</option><option value="archived">归档</option></select></label>
          <button class="btn" type="submit" ?disabled=${c.loading}>筛选</button>
          <button class="btn-ghost workspace-advanced-toggle" type="button" aria-expanded=${this.resourceFilterOpen} aria-controls="workspace-advanced-filters" @click=${() => this.resourceFilterOpen = !this.resourceFilterOpen}>${icons['chevron-right']}高级筛选${advancedCount ? ` · ${advancedCount}` : ''}</button>
          ${filtered ? html`<button class="btn-ghost" type="button" @click=${() => { this.query = ''; this.lifecycle = ''; this.profile = ''; this.resources = []; this.resource = ''; void this.filter(); }}>清除筛选</button>` : nothing}
          <p class="workspace-list-count" aria-live="polite">${c.loading ? '正在加载调查…' : c.listError ? '调查列表读取失败' : !c.listLoaded ? '等待读取调查' : c.multiResourceFilter ? `已加载 ${c.list.items.length} 项匹配调查${c.list.nextCursor ? '，可继续加载' : ''}（多资源去重）` : `${c.list.authorizedCounts.total} 项可访问调查`}</p>
        </div>
        <div id="workspace-advanced-filters" class="workspace-filter-advanced" ?hidden=${!this.resourceFilterOpen}>
          <app-form-field class="workspace-profile" label="Profile 筛选"><select aria-label="Profile 筛选" .value=${this.profile} @change=${(e: Event) => { this.profile = (e.target as HTMLSelectElement).value; void this.filter(); }}><option value="">全部 Profile</option><option value="ops">Ops</option><option value="system">System</option></select></app-form-field>
          <h3>按资源名称 / 类型筛选${this.resources.length ? ` · 已选 ${this.resources.length} 项（匹配任一）` : ''}</h3>
          ${this.resourceFilterOpen ? html`<investigation-resource-picker .value=${this.resources} @resource-selection-change=${(e: CustomEvent<{ value: string[] }>) => { this.resources = e.detail.value; void this.filter(); }}></investigation-resource-picker>` : nothing}
          <app-form-field label="高级资源筛选" hint="instance:ID / server:ID / network_device:ID，逗号分隔；与所选资源合并。"><input aria-label="资源筛选" .value=${this.resource} @input=${(e: Event) => this.resource = (e.target as HTMLInputElement).value}></app-form-field>
        </div>
      </form>
      ${firstUse ? html`<div class="workspace-start"><app-card class="start-intro"><div class="start-panel">
        <div class="start-signature">${icons.activity}<span>从一个具体问题开始</span></div>
        <h2>让资源证据，汇成可追溯的调查。</h2><p>选择需要关注的资源，描述你观察到的现象。调查将保留执行过程、证据与结论，便于后续核对。</p>
        <button class="btn-primary" @click=${() => this.createOpen = true}>创建第一项调查</button>
        <ol class="start-steps">${[['选择范围', '按名称选择一个或多个有权限的资源。'], ['说明问题', '补充现象与时间窗口，避免泛泛地分析一切。'], ['核对证据', '区分事实、推断与缺口，再决定下一步。']].map(([title, text], index) => html`<li><span class="step-number">${index + 1}</span><div><h3>${title}</h3><p>${text}</p></div></li>`)}</ol>
      </div></app-card><aside><app-card><span slot="header">创建前，先明确范围</span>
        ${[['调查与对话', '临时交流可进入对话；需要保留过程与证据时，创建调查。'], ['不会扩大资源权限', '仅显示当前可读取的资源，提交时仍需核验当前授权与操作权限。'], ['没有证据，不代表正常', '缺失、失效和未知结果会单独提示。']].map(([title, text]) => html`<div class="start-note"><h3>${title}</h3><p>${text}</p></div>`)}
      </app-card></aside></div>` : html`<div class="workspace">
        <aside aria-label="调查导航"><app-card><span slot="header">调查列表</span>
          <div class="investigation-list">${c.list.items.map(row => html`<button class="btn" aria-current=${row.id === c.detail?.id ? 'true' : 'false'} @click=${() => void this.openInvestigation(row.id)}>${row.title}<br><span class="muted">${row.profileId === 'system' ? '平台调查' : '资源调查'} · ${lifecycleLabels[row.lifecycle]}</span></button>`)}</div>
          ${c.listLoaded && !c.loading && !c.listError && !c.list.items.length ? html`<app-empty-state title="暂无匹配调查" description="更换名称、状态或资源筛选；也可清除筛选查看全部调查。"></app-empty-state>` : nothing}
          ${c.list.nextCursor ? html`<button class="btn" ?disabled=${c.loading} @click=${() => void c.loadList(undefined, true)}>加载更多调查</button>` : nothing}
        </app-card></aside>
        <section class="workspace-main" aria-label="执行协作">${renderInvestigationDetail(c, { draft: this.draft, onDraft: v => this.draft = v,
          onContinue: () => void c.continue(this.draft).then(result => { if (result) this.draft = ''; }), onEvidence: () => this.evidenceOpen = true })}</section>
        <aside class="workspace-context" aria-label="证据成果"><investigation-context .results=${c.results} .evidence=${c.evidence} .onMore=${() => void c.loadResults()}></investigation-context></aside>
      </div>`}
      <app-dialog .open=${this.evidenceOpen && !c.forbidden} title="证据与成果" size="lg" @app-dialog-close=${() => this.evidenceOpen = false}>
        <investigation-context .results=${c.results} .evidence=${c.evidence} .onMore=${() => void c.loadResults()}></investigation-context>
      </app-dialog>
      ${c.forbidden ? nothing : html`<investigation-create .open=${this.createOpen} .client=${this.client} @investigation-create-close=${() => this.createOpen = false}
        @investigation-created=${(e: CustomEvent<{ id: string }>) => { void this.openInvestigation(e.detail.id); void c.loadList(); }}></investigation-create>`}
    `}`;
  }
}

interface AttentionItem { id: string | number; title: string; severity: string; status: string; updated_at: string;
  instance_id?: number | null; instance_name?: string; created_at?: string; root_cause?: string | null;
  alert_count?: number; alerts?: Array<{ id: string | number; title: string; metric_name?: string }>;
}
const attentionStatus = (value: string) => ({ open: '待处理', investigating: '调查中', handled: '待验证', resolved: '已恢复', closed: '已关闭' })[value] ?? '未知状态（查看技术详情）';
const attentionSeverity = (value: string) => ({ critical: '严重', warning: '警告', info: '信息' })[value] ?? '未知严重度（查看技术详情）';
const attentionResource = (item: AttentionItem) => item.instance_name || (item.instance_id ? `数据库实例 #${item.instance_id}（名称未提供）` : '资源未提供');
const attentionSummary = (item: AttentionItem) => item.root_cause || (item.alert_count != null ? `聚合了 ${item.alert_count} 条告警；根因尚未确认` : '根因摘要尚未提供，请查看事件详情');
export function sortAttentionItems(items: AttentionItem[]) {
  const severity: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  return [...items].sort((a, b) => (severity[a.severity] ?? 3) - (severity[b.severity] ?? 3)
    || b.updated_at.localeCompare(a.updated_at) || String(a.id).localeCompare(String(b.id)));
}
@customElement('attention-page')
export class AttentionPage extends LitElement {
  @property({ attribute: false }) permissions: Set<string> | null = null;
  @state() private items: AttentionItem[] = [];
  @state() private readState: 'idle' | 'loading' | 'success' | 'error' | 'expired' = 'idle';
  @state() private error = '';
  @state() private query = '';
  @state() private statusFilter = '';
  @state() private selectedId: string | number | null = null;
  @state() private detail: AttentionItem | null = null;
  @state() private detailError = '';
  @state() private detailLoading = false;
  private detailGeneration = 0;
  private closeDetail() { this.detailGeneration++; this.selectedId = null; this.detail = null; this.detailError = ''; this.detailLoading = false; }
  private async openDetail(id: string | number) {
    if (!hasSlidePermission(this.permissions, 'alert:view') || this.readState === 'expired') return;
    this.closeDetail(); this.selectedId = id; this.detailLoading = true;
    const generation = this.detailGeneration;
    try {
      const response = await authFetch(`/api/alerts/events/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (generation !== this.detailGeneration) return;
      if (response.status === 401) { this.expired(); return; }
      if (!response.ok) throw new Error(response.status === 403 ? '无权访问此事件，请确认当前资源权限。' : response.status === 404 ? '事件不存在或已不可访问，请刷新事项。' : '事件详情读取失败，请重试。');
      const item = await response.json();
      if (generation !== this.detailGeneration) return;
      if (!item || String(item.id) !== String(id) || !['title', 'severity', 'status', 'updated_at'].every(key => typeof item[key] === 'string')) throw new Error('事件详情格式异常，请重试。');
      this.detail = item;
    } catch (error) { if (generation === this.detailGeneration) this.detailError = (error as Error).message; }
    finally { if (generation === this.detailGeneration) this.detailLoading = false; }
  }
  private get loading() { return this.readState === 'loading'; }
  private generation = 0;
  private invalidate() { this.closeDetail(); this.generation++; this.items = []; this.readState = 'idle'; this.error = ''; }
  private expired = () => { this.invalidate(); this.readState = 'expired'; };
  private permissionsChanged = (e: Event) => { this.invalidate(); this.permissions = new Set((e as CustomEvent<{ permissions: string[] }>).detail.permissions); };
  createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); window.addEventListener('slide-session-expired', this.expired); window.addEventListener('slide-permissions-loaded', this.permissionsChanged); }
  disconnectedCallback() { this.invalidate(); window.removeEventListener('slide-session-expired', this.expired); window.removeEventListener('slide-permissions-loaded', this.permissionsChanged); super.disconnectedCallback(); }
  protected updated(changed: Map<string, unknown>) { if (changed.has('permissions')) { this.invalidate(); if (hasSlidePermission(this.permissions, 'alert:view')) void this.load(); } }
  private async load() {
    if (!hasSlidePermission(this.permissions, 'alert:view') || this.readState === 'expired') return;
    this.closeDetail(); const generation = ++this.generation; this.readState = 'loading'; this.error = ''; this.items = [];
    let failureMessage = '事项读取失败，请重试。';
    try {
      const response = await authFetch('/api/alerts/events?limit=20&offset=0&status=open,investigating,handled', { cache: 'no-store' });
      if (generation !== this.generation) return;
      if (response.status === 401) { this.readState = 'expired'; return; }
      if (response.status === 403) failureMessage = '无权访问关注事项，请重新确认权限后重试。';
      if (!response.ok) throw new Error(failureMessage);
      const data = await response.json();
      if (generation !== this.generation) return;
      const items = Array.isArray(data) ? data : data?.items;
      failureMessage = '事项返回格式异常，请重试。';
      if (!Array.isArray(items) || !items.every(item => item
        && (typeof item.id === 'string' || typeof item.id === 'number')
        && ['title', 'severity', 'status', 'updated_at'].every(key => typeof item[key] === 'string'))) throw new Error(failureMessage);
      this.items = sortAttentionItems(items); this.readState = 'success';
    } catch { if (generation === this.generation) { this.items = []; this.error = failureMessage; this.readState = 'error'; } }
  }
  render() {
    const canView = hasSlidePermission(this.permissions, 'alert:view');
    const filtered = this.items.filter(item => (!this.statusFilter || item.status === this.statusFilter) &&
      [item.title, `#${item.id}`, attentionResource(item), attentionSummary(item)].join(' ').toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase()));
    return html`<style>${sharedBtnStyles.cssText}${workspaceShellStyles}
      attention-page { display:block; min-width:0; } attention-page .attention-actions { display:flex; gap:var(--space-sm); flex-wrap:wrap; margin-top:var(--space-lg); }
      attention-page app-data-table { display:block; overflow:auto; } attention-page td { overflow-wrap:anywhere; }
      attention-page .attention-copy { display:grid; gap:var(--space-xs); min-width:180px; }
      attention-page .attention-meta { color:var(--muted); font-size:var(--text-sm); }
      attention-page .attention-scroll-hint { color:var(--muted); font-size:var(--text-sm); }
      attention-page .attention-filters { display:flex; gap:var(--space-md); flex-wrap:wrap; margin-bottom:var(--space-md); }
      attention-page app-dialog p { overflow-wrap:anywhere; }
    </style>
      <app-card><span slot="header">关注事项</span>
        <p>最近 20 项待处理聚合事件，按严重度、更新时间与编号排序。筛选仅作用于这 20 项。</p>
        ${this.readState === 'expired' ? html`<p role="alert">登录已失效，请重新登录后读取关注事项。</p>` : this.permissions === null ? html`<p role="status">正在确认访问权限…</p>` : canView ? html`
          <div class="attention-filters">
            <app-form-field class="field" label="搜索事项"><input aria-label="搜索事项" placeholder="标题、资源名或事件编号" .value=${this.query} @input=${(e: Event) => this.query = (e.target as HTMLInputElement).value}></app-form-field>
            <app-form-field class="field" label="事项状态"><select aria-label="事项状态" .value=${this.statusFilter} @change=${(e: Event) => this.statusFilter = (e.target as HTMLSelectElement).value}><option value="">全部待处理状态</option><option value="open">待处理</option><option value="investigating">调查中</option><option value="handled">待验证</option></select></app-form-field>
          </div>
          ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
          <p class="attention-scroll-hint">表格可横向滚动查看全部信息与操作，也可用 Tab 定位“查看详情”。</p>
          ${this.loading || this.readState === 'success' ? html`<app-data-table tabindex="0" role="region" aria-label="关注事项，可横向滚动" .loading=${this.loading}
            .columns=${[{ key: 'identity', label: '事项与摘要' }, { key: 'resource', label: '资源与时间' }, { key: 'severityLabel', label: '严重度' }, { key: 'statusLabel', label: '状态' }, { key: 'action', label: '操作' }]}
            .rows=${filtered.map(item => ({ identity: html`<div class="attention-copy"><strong>${item.title}</strong><span class="attention-meta">事件 #${item.id}</span><span>${attentionSummary(item)}</span></div>`, resource: html`<div class="attention-copy"><span>${attentionResource(item)}</span><span class="attention-meta">更新于 ${displayTime(item.updated_at)}</span></div>`, severityLabel: attentionSeverity(item.severity), statusLabel: attentionStatus(item.status), action: html`<button class="btn btn-sm" aria-label=${`查看事件 #${item.id} 详情`} @click=${() => void this.openDetail(item.id)}>查看详情</button>` }))}
            emptyMessage=${this.query || this.statusFilter ? '暂无匹配事项' : '暂无关注事项'}></app-data-table>` : nothing}
          <div class="attention-actions"><button aria-busy=${String(this.loading)} class="btn btn-refresh" ?disabled=${this.loading} @click=${() => void this.load()}>刷新事项</button><button class="btn" @click=${() => window.dispatchEvent(new CustomEvent('slide-navigate', { detail: { tab: 'events' } }))}>打开事件中心</button></div>
        ` : html`<app-empty-state title="无访问权限" description="需要告警读取权限。"></app-empty-state>`}
      </app-card>
      <app-dialog .open=${canView && this.selectedId !== null} title=${`事件 #${this.selectedId ?? ''} 详情`} size="lg" @app-dialog-close=${() => this.closeDetail()}>
        ${this.detailLoading ? html`<p role="status">正在核验权限并读取事件详情…</p>` : this.detailError ? html`<p role="alert">${this.detailError}</p><button class="btn" @click=${() => this.selectedId !== null && void this.openDetail(this.selectedId)}>重试详情</button>` : this.detail ? html`
          <h2>${this.detail.title}</h2><p>事件 #${this.detail.id} · ${attentionResource(this.detail)}</p>
          <p>${attentionSeverity(this.detail.severity)} · ${attentionStatus(this.detail.status)}</p>
          <p>创建于 ${displayTime(this.detail.created_at)} · 更新于 ${displayTime(this.detail.updated_at)}</p>
          <h3>原因摘要</h3><p>${attentionSummary(this.detail)}</p>
          <h3>关联告警</h3>${this.detail.alerts?.length ? html`<ul>${this.detail.alerts.map(alert => html`<li>告警 #${alert.id}：${alert.title}</li>`)}</ul>` : html`<p>当前事件未返回关联告警；可在事件中心核对关联记录。</p>`}
          <details><summary>技术详情</summary><p>资源标识：${this.detail.instance_id ?? '未提供'} · 原始严重度：${this.detail.severity} · 原始状态：${this.detail.status}</p></details>
        ` : nothing}
        <button slot="footer" class="btn" @click=${() => this.closeDetail()}>返回关注事项</button>
      </app-dialog>`;
  }
}
