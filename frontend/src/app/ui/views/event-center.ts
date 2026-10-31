import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
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
    .tab.active { border-bottom-color: var(--accent); color: var(--accent-text); font-weight: 600; }
  `;

  private syncFromLocation() {
    const requested = new URL(window.location.href).searchParams.get("view");
    if (requested === "rules") { this.activeView = "aggregate"; return; }
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
      <p>触发条件在资源的固定版本模板中配置。<a href="/?tab=instances-db">前往资源配置模板触发器</a></p>
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
      case "system": return html`<system-events-page></system-events-page>`;
      case "aggregate": return html`<event-management-page></event-management-page>`;
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
