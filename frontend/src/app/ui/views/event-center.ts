import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";

type EventCenterView = "active" | "aggregate" | "rules" | "notifications";

const EVENT_VIEWS: readonly { id: EventCenterView; label: string }[] = [
  { id: "active", label: "活动告警" },
  { id: "aggregate", label: "聚合事件" },
  { id: "rules", label: "规则与策略" },
  { id: "notifications", label: "通知投递" },
];

@customElement("event-center-page")
export class EventCenterPage extends LitElement {
  @state() private activeView: EventCenterView = "active";
  private readonly popStateHandler = () => this.syncFromLocation();

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("popstate", this.popStateHandler);
    this.syncFromLocation();
  }

  override disconnectedCallback() {
    window.removeEventListener("popstate", this.popStateHandler);
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
    .tab.active { border-bottom-color: var(--accent); color: var(--accent); font-weight: 600; }
  `;

  private syncFromLocation() {
    const requested = new URL(window.location.href).searchParams.get("view");
    if (EVENT_VIEWS.some((view) => view.id === requested)) {
      this.activeView = requested as EventCenterView;
    }
  }

  private selectView(view: EventCenterView) {
    this.activeView = view;
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    url.searchParams.delete("tab");
    window.history.pushState({}, "", url);
  }

  override render() {
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
      ${this.renderView()}
    `;
  }

  private renderView() {
    switch (this.activeView) {
      case "aggregate": return html`<event-management-page></event-management-page>`;
      case "rules": return html`<alerts-page mode="rules"></alerts-page>`;
      case "notifications": return html`<alerts-page mode="notifications"></alerts-page>`;
      default: return html`
        <alerts-page
          mode="active"
          @event-center-view=${(event: CustomEvent<{ view: EventCenterView; action?: string }>) => {
            this.selectView(event.detail.view);
            if (event.detail.action === "create-rule") {
              void this.updateComplete.then(() => {
                const alerts = this.shadowRoot?.querySelector("alerts-page") as (HTMLElement & { openRuleEditor?: () => void }) | null;
                alerts?.openRuleEditor?.();
              });
            }
          }}
        ></alerts-page>
      `;
    }
  }
}
