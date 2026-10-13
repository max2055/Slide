import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.ts';
import type { DirectGatewayClient } from '../direct-gateway.ts';
import { InvestigationsController } from '../controllers/investigations.ts';
import { renderInvestigationDetail } from './investigation-detail.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { hasSlidePermission } from '../app-settings.ts';
import '../components/app-card.ts';
import '../components/app-form-field.ts';
import '../components/app-dialog.ts';
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
  @state() private query = '';
  @state() private lifecycle = '';
  @state() private profile = '';
  @state() private resource = '';
  @state() private draft = '';
  controller = new InvestigationsController(() => this.requestUpdate(), null);
  private popState = () => { const id = new URL(location.href).searchParams.get('investigation'); if (id) void this.openInvestigation(id, false); };
  private permissionsChanged = (e: Event) => {
    this.permissions = new Set((e as CustomEvent<{ permissions: string[] }>).detail.permissions);
    this.controller.clearSensitive(); this.draft = ''; this.evidenceOpen = false; this.createOpen = false;
    if (this.canView) this.reload(); this.requestUpdate();
  };
  private sessionExpired = () => { this.controller.clearSensitive(); this.draft = ''; this.evidenceOpen = false; this.createOpen = false; this.requestUpdate(); };
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
      this.controller.dispose(); this.controller = new InvestigationsController(() => this.requestUpdate(), this.client);
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
  private filter() {
    const query = new URLSearchParams();
    if (this.query.trim()) query.set('query', this.query.trim());
    if (this.lifecycle) query.set('state', this.lifecycle);
    if (this.profile) query.set('profile', this.profile);
    if (this.resource.trim()) query.set('resource', this.resource.trim());
    return this.controller.loadList(query.toString());
  }
  private async openInvestigation(id: string, push = true) {
    this.draft = ''; this.evidenceOpen = false;
    if (push) { const url = new URL(location.href); url.searchParams.set('investigation', id); history.pushState({}, '', url); }
    await this.controller.select(id);
  }
  render() {
    const c = this.controller;
    return html`<style>${sharedBtnStyles.cssText}${workspaceShellStyles}
      investigations-page { display:block; min-width:0; }
      investigations-page .workspace { display:grid; grid-template-columns:minmax(180px, 240px) minmax(0, 1fr) minmax(240px, 320px); gap:var(--space-md); align-items:start; }
      investigations-page .workspace > * { min-width:0; }
      investigations-page .workspace-main { display:grid; gap:var(--space-md); }
      investigations-page .workspace-header, investigations-page .workspace-actions { display:flex; align-items:center; justify-content:space-between; gap:var(--space-sm); flex-wrap:wrap; margin-bottom:var(--space-md); }
      investigations-page h1 { margin:0; font-size:var(--text-xl); }
      investigations-page input, investigations-page select, investigations-page textarea { box-sizing:border-box; width:100%; min-width:0; background:var(--input); color:var(--text); padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); }
      investigations-page .investigation-list { display:grid; gap:var(--space-sm); }
      investigations-page .investigation-list button { display:block; white-space:normal; text-align:left; width:100%; overflow-wrap:anywhere; }
      investigations-page .investigation-list [aria-current=true] { border-color:var(--accent); }
      investigations-page .investigation-states { display:flex; flex-wrap:wrap; gap:var(--space-md); }
      investigations-page dt, investigations-page .muted { color:var(--muted); font-size:var(--text-sm); }
      investigations-page dd { margin:var(--space-xs) 0; }
      investigations-page p, investigations-page .investigation-messages { overflow-wrap:anywhere; }
      investigations-page .investigation-messages { min-width:0; }
      investigations-page .investigation-messages .chat-group { max-width:100%; }
      investigations-page .investigation-messages pre { max-width:100%; overflow:auto; }
      investigations-page .evidence-toggle { display:none; }
      investigations-page .workspace-error { margin:var(--space-md) 0; color:var(--danger); }
      @media(max-width:1439px) { investigations-page .workspace { grid-template-columns:minmax(160px, 220px) minmax(0, 1fr); } investigations-page .workspace-context { display:none; } investigations-page .evidence-toggle { display:inline-flex; } }
      @media(max-width:767px) { investigations-page .workspace { grid-template-columns:minmax(0,1fr); } investigations-page .investigation-list { max-height:220px; overflow:auto; } }
    </style>
    ${!this.canView ? html`<app-empty-state title="无访问权限" description="需要普通对话读取权限。"></app-empty-state>` : html`
      <div class="workspace-header"><h1>AI 工作空间</h1><button class="btn-primary" @click=${() => this.createOpen = true}>创建手动调查</button></div>
      ${c.error ? html`<div class="workspace-error" role="alert">${c.error}${c.acceptanceUnknown ? html`<button class="btn" ?disabled=${c.busy} @click=${() => void c.retryPending()}>核对原请求</button>` : nothing}<button class="btn" @click=${this.reload}>重试读取</button></div>` : nothing}
      <div class="workspace">
        <aside aria-label="调查导航"><app-card><span slot="header">调查列表</span>
          <form @submit=${(e: Event) => { e.preventDefault(); void this.filter(); }}>
            <app-form-field label="搜索调查"><input aria-label="搜索调查" .value=${this.query} @input=${(e: Event) => this.query = (e.target as HTMLInputElement).value}></app-form-field>
            <app-form-field label="调查状态"><select aria-label="调查状态" .value=${this.lifecycle} @change=${(e: Event) => { this.lifecycle = (e.target as HTMLSelectElement).value; void this.filter(); }}><option value="">全部</option><option value="open">开放</option><option value="waiting">等待处理</option><option value="closed">已关闭</option><option value="archived">归档</option></select></app-form-field>
            <app-form-field label="Profile 筛选"><select aria-label="Profile 筛选" .value=${this.profile} @change=${(e: Event) => { this.profile = (e.target as HTMLSelectElement).value; void this.filter(); }}><option value="">全部</option><option value="ops">Ops</option><option value="system">System</option></select></app-form-field>
            <app-form-field label="资源筛选" hint="instance:ID / server:ID / network_device:ID"><input aria-label="资源筛选" .value=${this.resource} @input=${(e: Event) => this.resource = (e.target as HTMLInputElement).value}></app-form-field>
            <button class="btn" type="submit" ?disabled=${c.loading}>筛选</button>
          </form>
          <p aria-live="polite">${c.loading ? '正在加载调查…' : `${c.list.authorizedCounts.total} 项可访问调查`}</p>
          <div class="investigation-list">${c.list.items.map(row => html`<button class="btn" aria-current=${row.id === c.detail?.id ? 'true' : 'false'} @click=${() => void this.openInvestigation(row.id)}>${row.title}<br><span class="muted">${row.profileId} · ${row.lifecycle}</span></button>`)}</div>
          ${!c.loading && !c.list.items.length ? html`<app-empty-state title="暂无匹配调查"></app-empty-state>` : nothing}
          ${c.list.nextCursor ? html`<button class="btn" ?disabled=${c.loading} @click=${() => void c.loadList(undefined, true)}>加载更多调查</button>` : nothing}
        </app-card></aside>
        <section class="workspace-main" aria-label="执行协作">${renderInvestigationDetail(c, { draft: this.draft, onDraft: v => this.draft = v,
          onContinue: () => void c.continue(this.draft).then(result => { if (result) this.draft = ''; }), onEvidence: () => this.evidenceOpen = true })}</section>
        <aside class="workspace-context" aria-label="证据成果"><investigation-context .results=${c.results} .evidence=${c.evidence} .onMore=${() => void c.loadResults()}></investigation-context></aside>
      </div>
      <app-dialog .open=${this.evidenceOpen && !c.forbidden} title="证据与成果" size="lg" @app-dialog-close=${() => this.evidenceOpen = false}>
        <investigation-context .results=${c.results} .evidence=${c.evidence} .onMore=${() => void c.loadResults()}></investigation-context>
      </app-dialog>
      <investigation-create .open=${this.createOpen} .client=${this.client} @investigation-create-close=${() => this.createOpen = false}
        @investigation-created=${(e: CustomEvent<{ id: string }>) => { void this.openInvestigation(e.detail.id); void c.loadList(); }}></investigation-create>
    `}`;
  }
}

interface AttentionItem { id: string; title: string; severity: string; status: string; updated_at: string; }
export function sortAttentionItems(items: AttentionItem[]) {
  const severity: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  return [...items].sort((a, b) => (severity[a.severity] ?? 3) - (severity[b.severity] ?? 3)
    || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
}
@customElement('attention-page')
export class AttentionPage extends LitElement {
  @property({ attribute: false }) permissions: Set<string> | null = null;
  @state() private overview = false;
  @state() private items: AttentionItem[] = [];
  @state() private loading = false;
  @state() private error = '';
  private generation = 0;
  private expired = () => { this.generation++; this.items = []; this.loading = false; this.overview = false; this.requestUpdate(); };
  private permissionsChanged = (e: Event) => { this.expired(); this.permissions = new Set((e as CustomEvent<{ permissions: string[] }>).detail.permissions); };
  createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); window.addEventListener('slide-session-expired', this.expired); window.addEventListener('slide-permissions-loaded', this.permissionsChanged); }
  disconnectedCallback() { this.expired(); window.removeEventListener('slide-session-expired', this.expired); window.removeEventListener('slide-permissions-loaded', this.permissionsChanged); super.disconnectedCallback(); }
  protected updated(changed: Map<string, unknown>) { if (changed.has('permissions')) { this.expired(); if (hasSlidePermission(this.permissions, 'alert:view')) void this.load(); } }
  private async load() {
    const generation = ++this.generation; this.loading = true; this.error = '';
    try {
      const response = await authFetch('/api/alerts/events?limit=20&offset=0&status=open,investigating,handled', { cache: 'no-store' });
      if (!response.ok) throw new Error('事项读取失败，请重新确认权限或重试。');
      const data = await response.json();
      if (generation === this.generation) this.items = sortAttentionItems(data.items ?? data);
    } catch (e) { if (generation === this.generation) { this.items = []; this.error = (e as Error).message; } }
    finally { if (generation === this.generation) this.loading = false; }
  }
  render() {
    return html`<style>${sharedBtnStyles.cssText}${workspaceShellStyles} attention-page { display:block; min-width:0; } attention-page .attention-actions { display:flex; gap:var(--space-sm); flex-wrap:wrap; margin-bottom:var(--space-md); } attention-page app-data-table { display:block; overflow:auto; }</style>
      <div class="attention-actions"><button class="btn" aria-pressed=${!this.overview} @click=${() => this.overview = false}>关注事项</button>
        ${hasSlidePermission(this.permissions, 'view_dashboard') ? html`<button class="btn" aria-pressed=${this.overview} @click=${() => this.overview = true}>资源概览</button>` : nothing}</div>
      ${this.overview ? html`<dashboard-page></dashboard-page>` : html`
        <app-card><span slot="header">关注事项</span>
          <p>最近 20 项待处理聚合事件，按严重度、更新时间与 ID 排序。</p>
          ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
          ${hasSlidePermission(this.permissions, 'alert:view') ? html`
            <app-data-table .loading=${this.loading} .columns=${[{ key: 'title', label: '事项' }, { key: 'severity', label: '严重度' }, { key: 'status', label: '状态' }]} .rows=${this.items.map(item => ({ ...item, severity: ({ critical: '严重', warning: '警告', info: '信息' })[item.severity] ?? item.severity, status: ({ open: '待处理', investigating: '调查中', handled: '待验证' })[item.status] ?? item.status }))} emptyMessage="暂无关注事项"></app-data-table>
            <div class="attention-actions"><button class="btn" ?disabled=${this.loading} @click=${() => void this.load()}>刷新事项</button><button class="btn" @click=${() => window.dispatchEvent(new CustomEvent('slide-navigate', { detail: { tab: 'events' } }))}>打开事件中心</button></div>
          ` : html`<app-empty-state title="暂无可访问事项"></app-empty-state>`}
        </app-card>`}`;
  }
}
