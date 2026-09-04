import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import './agent-tool-audit.js';
import './system-audit.js';

type AuditView = 'system' | 'agent';

const AUDIT_VIEWS: readonly { id: AuditView; label: string }[] = [
  { id: 'system', label: '系统审计' },
  { id: 'agent', label: 'Agent 审计' },
];

@customElement('audit-center-page')
export class AuditCenterPage extends LitElement {
  @state() private activeView: AuditView = 'system';
  private readonly popStateHandler = () => this.syncFromLocation();

  static styles = css`
    :host { display: block; min-width: 0; }
    .tabs {
      display: flex;
      gap: var(--space-xs);
      margin-bottom: var(--space-xl);
      overflow-x: auto;
      border-bottom: 1px solid var(--border);
    }
    .tab {
      flex: 0 0 auto;
      padding: var(--space-sm) var(--space-lg);
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--muted);
      font: inherit;
      cursor: pointer;
    }
    .tab:hover { color: var(--text); }
    .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .tab.active { border-bottom-color: var(--accent); color: var(--accent); font-weight: 600; }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('popstate', this.popStateHandler);
    this.syncFromLocation();
  }

  override disconnectedCallback(): void {
    window.removeEventListener('popstate', this.popStateHandler);
    super.disconnectedCallback();
  }

  private syncFromLocation(): void {
    const requested = new URL(window.location.href).searchParams.get('view');
    if (AUDIT_VIEWS.some(view => view.id === requested)) this.activeView = requested as AuditView;
  }

  private selectView(view: AuditView): void {
    this.activeView = view;
    const url = new URL(window.location.href);
    url.searchParams.set('view', view);
    window.history.pushState({}, '', url);
  }

  override render() {
    return html`
      <div class="tabs" role="tablist" aria-label="审计中心">
        ${AUDIT_VIEWS.map(view => html`
          <button
            type="button"
            role="tab"
            class="tab ${this.activeView === view.id ? 'active' : ''}"
            aria-selected=${this.activeView === view.id}
            @click=${() => this.selectView(view.id)}
          >${view.label}</button>
        `)}
      </div>
      ${this.activeView === 'agent'
        ? html`<agent-tool-audit-page></agent-tool-audit-page>`
        : html`<system-audit-page></system-audit-page>`}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'audit-center-page': AuditCenterPage } }
