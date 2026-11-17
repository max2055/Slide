import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { hasSlidePermission } from '../app-settings.ts';
import type { DirectGatewayClient } from '../direct-gateway.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import './investigations.ts';
import './operations-actions.ts';

@customElement('workbench-page')
export class WorkbenchPage extends LitElement {
  @property({ attribute: false }) permissions: Set<string> | null = null;
  @property({ attribute: false }) client: DirectGatewayClient | null = null;
  @state() private actions = new URL(location.href).searchParams.get('workspaceTab') === 'actions';
  @state() private epoch = 0;
  @state() private expired = false;
  private selectedTab = false;
  createRenderRoot() { return this; }
  private pop = () => { this.selectedTab = false; this.actions = new URL(location.href).searchParams.get('workspaceTab') === 'actions'; this.selectDefault(); this.epoch++; };
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
    if (!this.expired && !this.selectedTab && !new URL(location.href).search && this.permissions
      && !hasSlidePermission(this.permissions, 'chat:view')
      && hasSlidePermission(this.permissions, 'operations:actions:view')) this.choose(true, true);
  }
  disconnectedCallback() {
    window.removeEventListener('popstate', this.pop);
    window.removeEventListener('slide-permissions-loaded', this.authority);
    window.removeEventListener('slide-session-expired', this.expire);
    super.disconnectedCallback();
  }
  private choose(actions: boolean, replace = false) {
    this.selectedTab = true;
    const u = new URL(location.href);
    if (actions) u.searchParams.set('workspaceTab', 'actions'); else u.searchParams.delete('workspaceTab');
    history[replace ? 'replaceState' : 'pushState']({}, '', u);
    this.actions = actions; this.epoch++;
  }
  render() {
    const can = (p: string) => !this.expired && hasSlidePermission(this.permissions, p);
    const allowed = can(this.actions ? 'operations:actions:view' : 'chat:view');
    return html`<style>${sharedBtnStyles.cssText} workbench-page { display:block; min-width:0; } workbench-page nav { display:flex; gap:var(--space-sm); margin-bottom:var(--space-md); }</style>
      <h1>AI 工作台</h1><nav aria-label="工作台页签">
        <button class="btn" aria-pressed=${String(!this.actions)} ?disabled=${!can('chat:view')} @click=${() => this.choose(false)}>调查</button>
        <button class="btn" aria-pressed=${String(this.actions)} ?disabled=${!can('operations:actions:view')} @click=${() => this.choose(true)}>行动计划</button>
      </nav>
      ${!allowed ? html`<app-empty-state title="无访问权限" description="当前页签需要独立授权，请选择可访问页签或联系管理员。"></app-empty-state>` : keyed(`${this.actions}:${this.epoch}`, this.actions
        ? html`<operations-actions .permissions=${this.permissions}></operations-actions>`
        : html`<investigations-page .client=${this.client} .permissions=${this.permissions}></investigations-page>`)}${nothing}`;
  }
}
