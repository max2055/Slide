import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { hasSlidePermission } from '../app-settings.ts';
import type { DirectGatewayClient } from '../direct-gateway.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import './investigations.ts';
import '../components/investigation-attention.ts';
import './operations-actions.ts';

@customElement('workbench-page')
export class WorkbenchPage extends LitElement {
  @property({ attribute: false }) permissions: Set<string> | null = null;
  @property({ attribute: false }) client: DirectGatewayClient | null = null;
  @state() private actions = new URL(location.href).searchParams.get('workspaceTab') === 'actions';
  @state() private home = (!new URL(location.href).search || new URL(location.href).searchParams.get('workspaceTab') === 'home');
  @state() private epoch = 0;
  @state() private expired = false;
  private selectedTab = false;
  createRenderRoot() { return this; }
  private pop = () => {
    const previous = `${this.home}:${this.actions}`, url = new URL(location.href);
    this.selectedTab = false;
    this.actions = url.searchParams.get('workspaceTab') === 'actions';
    this.home = !url.search || url.searchParams.get('workspaceTab') === 'home';
    this.selectDefault();
    if(previous !== `${this.home}:${this.actions}`) this.epoch++;
  };
  private authority = (event: Event) => {
    this.permissions = new Set((event as CustomEvent<{permissions: string[]}>).detail.permissions);
    this.epoch++;
  };
  private expire = () => { this.expired = true; this.permissions = null; this.epoch++; };
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('popstate', this.pop);
    window.addEventListener('slide-permissions-loaded', this.authority);
    window.addEventListener('slide-session-expired', this.expire);
    this.selectDefault();
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has('permissions')) this.selectDefault();
  }
  private selectDefault() {
    // Resolve the plain entry after either cached or asynchronous authority arrives.
    // Queries carry explicit context; a user's tab choice also survives later grants.
    if (!this.expired && !this.selectedTab && (!new URL(location.href).search || new URL(location.href).searchParams.get('workspaceTab') === 'home') && this.permissions
      && !hasSlidePermission(this.permissions, 'chat:view')
      && hasSlidePermission(this.permissions, 'operations:actions:view')) this.choose(true, true);
  }
  disconnectedCallback() {
    window.removeEventListener('popstate', this.pop);
    window.removeEventListener('slide-permissions-loaded', this.authority);
    window.removeEventListener('slide-session-expired', this.expire);
    super.disconnectedCallback();
  }
  private choose(actions: boolean, replace = false, home = false) {
    this.selectedTab = true;
    const u = new URL(location.href);
    u.search = '';
    if (!home) u.searchParams.set('workspaceTab', actions ? 'actions' : 'investigations');
    history[replace ? 'replaceState' : 'pushState']({}, '', u);
    this.actions = actions; this.home = home; this.epoch++;
  }
  render() {
    const can = (p: string) => !this.expired && hasSlidePermission(this.permissions, p);
    const allowed = can(this.actions ? 'operations:actions:view' : 'chat:view');
    return html`<style>${sharedBtnStyles.cssText}
      workbench-page { display:block; min-width:0; max-width:1660px; margin:auto; }
      workbench-page > nav { display:flex; gap:var(--space-sm); border-bottom:1px solid var(--border); margin-bottom:var(--space-lg); }
      workbench-page > nav button { border-radius:0; border:0; border-bottom:3px solid transparent; padding:var(--space-md); background:transparent; }
      workbench-page > nav button[aria-pressed=true] { color:var(--accent); border-bottom-color:var(--accent); background:var(--accent-subtle); }
      workbench-page investigations-page .workspace-header h2, workbench-page investigations-page .workspace-header p { display:none; }
      workbench-page investigations-page .workspace-header { justify-content:flex-end; }
      workbench-page > header { margin-bottom:var(--space-lg); }
      workbench-page > header h1 { font-size:31px; line-height:1.32; margin:var(--space-xs) 0; color:var(--text-strong); letter-spacing:-1px; }
      workbench-page > header p { color:var(--muted); margin:0; }
      workbench-page .workbench-kicker { font-size:11px; letter-spacing:1.8px; color:var(--accent); }
    </style>
      <nav aria-label="工作台页签">
        <button class="btn" aria-pressed=${String(this.home)} ?disabled=${!can('chat:view')} @click=${() => this.choose(false, false, true)}>工作台</button>
        <button class="btn" aria-pressed=${String(!this.actions && !this.home)} ?disabled=${!can('chat:view')} @click=${() => this.choose(false)}>调查列表</button>
        <button class="btn" aria-pressed=${String(this.actions)} ?disabled=${!can('operations:actions:view')} @click=${() => this.choose(true)}>行动列表</button>
      </nav>
      <header><span class="workbench-kicker">OPERATIONS / WORKBENCH</span><h1>${this.home ? '运维工作台' : this.actions ? '行动计划' : '调查列表'}</h1>
        <p>${this.home ? '仅展示开放或等待中的授权调查，每个调查最多一个当前下一步。' : this.actions ? '独立审阅、显式执行，分别核对执行结果与业务恢复。' : '查找进行中与已关闭的调查，核对原始依据与下一步。'}</p></header>
      ${!allowed ? html`<app-empty-state title="无访问权限" description="当前页签需要独立授权，请选择可访问页签或联系管理员。"></app-empty-state>` : keyed(`${this.home}:${this.actions}:${this.epoch}`, this.home
        ? html`<investigation-attention .canViewActions=${can('operations:actions:view')}></investigation-attention>`
        : this.actions ? html`<operations-actions .permissions=${this.permissions}></operations-actions>`
        : html`<investigations-page .client=${this.client} .permissions=${this.permissions}></investigations-page>`)}${nothing}`;
  }
}
