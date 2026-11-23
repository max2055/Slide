import '../components/resource-event-context.js';
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { keyed } from 'lit/directives/keyed.js';
import { hasSlidePermission } from '../app-settings.ts';
import './event-management.ts';
import './system-events.ts';

type EventCenterView = "active" | "aggregate" | "notifications" | "system";

const EVENT_VIEWS: readonly { id: EventCenterView; label: string }[] = [
  { id: "active", label: "活动告警" },
  { id: "aggregate", label: "聚合事件" },
  { id: "notifications", label: "通知投递" },
  { id: "system", label: "平台异常" },
];

@customElement("event-center-page")
export class EventCenterPage extends LitElement {
  @property({ attribute: false }) permissions: Set<string> | null = null;
  @state() private authorityEpoch = 0;
  private authority = (event: Event) => {
    this.permissions = new Set((event as CustomEvent<{permissions:string[]}>).detail.permissions);
    this.authorityEpoch++;
  };
  @state() private activeView: EventCenterView = "active";
  @state() private eventId = 0;
  @state() private eventReturnTo = '';
  private readonly popStateHandler = () => this.syncFromLocation();

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("popstate", this.popStateHandler);
    window.addEventListener('slide-permissions-loaded', this.authority);
    this.syncFromLocation();
  }

  override disconnectedCallback() {
    window.removeEventListener("popstate", this.popStateHandler);
    window.removeEventListener('slide-permissions-loaded', this.authority);
    super.disconnectedCallback();
  }

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
    .tab.active { border-bottom-color: var(--accent); color: var(--accent-text); font-weight: 600; }
  `;

  private syncFromLocation() {
    const params = new URL(window.location.href).searchParams;
    const requested = params.get('view');
    const eventId = params.get('eventId');
    this.eventId = requested === 'aggregate' && eventId && /^[1-9]\d*$/.test(eventId) && Number.isSafeInteger(Number(eventId)) ? Number(eventId) : 0;
    this.eventReturnTo = this.eventId ? params.get('returnTo') ?? '' : '';
    if (requested === "rules") { this.activeView = "aggregate"; return; }
    if (EVENT_VIEWS.some((view) => view.id === requested)) {
      this.activeView = requested as EventCenterView;
    } else {
      this.activeView = "active";
    }
  }

  private selectView(view: EventCenterView) {
    this.activeView = view;
    this.eventId = 0;
    this.eventReturnTo = '';
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    url.searchParams.delete("tab");
    url.searchParams.delete('eventId');
    url.searchParams.delete('returnTo');
    window.history.pushState({}, "", url);
  }

  override render() {
    if (new URLSearchParams(location.search).has('resource')) return html`<resource-event-context></resource-event-context>`;
    if (this.activeView === 'aggregate' && this.permissions === null) return html`<p role="status">正在确认访问权限</p>`;
    if (this.activeView === 'aggregate' && !hasSlidePermission(this.permissions, 'alert:view')) return html`<app-empty-state title="无访问权限"></app-empty-state>`;
    return html`
      <div class="tabs" role="tablist" aria-label="事件中心">
        ${EVENT_VIEWS.map((view) => html`
          <button
            type="button"
            role="tab"
            class="tab ${this.activeView === view.id ? "active" : ""}"
            aria-selected=${this.activeView === view.id}
            @click=${() => this.selectView(view.id)}
          >${view.label}</button>
        `)}
      </div>
      ${keyed(this.authorityEpoch, this.renderView())}
    `;
  }

  private renderView() {
    switch (this.activeView) {
      case "system": return html`<system-events-page></system-events-page>`;
      case "aggregate": return html`<event-management-page .eventId=${this.eventId} .returnTo=${this.eventReturnTo}
        .canViewInvestigations=${hasSlidePermission(this.permissions,'chat:view')}></event-management-page>`;
      case "notifications": return html`<alerts-page mode="notifications"></alerts-page>`;
      default: return html`
        <alerts-page
          mode="active"
          @event-center-view=${(event: CustomEvent<{ view: EventCenterView; action?: string }>) => {
            if ((event.detail.view as string) === 'rules' || event.detail.action === 'create-rule') {
              window.location.assign('/?tab=instances-db');
            } else this.selectView(event.detail.view);
          }}
        ></alerts-page>
      `;
    }
  }
}
