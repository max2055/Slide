import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { permissionMatches } from "../settings-navigation.ts";

type StatusView = "health" | "observations" | "sandbox";

const STATUS_VIEWS: readonly { id: StatusView; label: string; permission: string }[] = [
  { id: "health", label: "平台自检", permission: "config:view" },
  { id: "observations", label: "平台观测", permission: "config:view" },
  { id: "sandbox", label: "Agent 沙箱", permission: "audit:view" },
];

@customElement("platform-status-page")
export class PlatformStatusPage extends LitElement {
  @state() private activeView: StatusView = "health";
  @state() private permissions: Set<string> | null = this.readPermissions();
  private readonly permissionsHandler = (event: Event) => {
    const values = (event as CustomEvent<{ permissions?: string[] }>).detail?.permissions;
    this.permissions = Array.isArray(values) ? new Set(values) : this.readPermissions();
    this.ensureVisibleView();
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("slide-permissions-loaded", this.permissionsHandler);
    const requested = new URL(window.location.href).searchParams.get("view");
    if (STATUS_VIEWS.some((view) => view.id === requested)) this.activeView = requested as StatusView;
    this.ensureVisibleView();
  }

  override disconnectedCallback() {
    window.removeEventListener("slide-permissions-loaded", this.permissionsHandler);
    super.disconnectedCallback();
  }

  static styles = css`
    :host { display: block; min-width: 0; }
    .tabs {
      display: flex;
      gap: var(--space-xs);
      margin-bottom: var(--space-xl);
      border-bottom: 1px solid var(--border);
    }
    .tab {
      padding: var(--space-sm) var(--space-lg);
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--muted);
      font: inherit;
      cursor: pointer;
    }
    .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .tab.active { border-bottom-color: var(--accent); color: var(--accent); font-weight: 600; }
  `;

  private readPermissions(): Set<string> | null {
    try {
      const raw = localStorage.getItem("permissions");
      return raw ? new Set(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  private get visibleViews() {
    return STATUS_VIEWS.filter((view) => permissionMatches(this.permissions, view.permission));
  }

  private ensureVisibleView() {
    if (!this.visibleViews.some((view) => view.id === this.activeView) && this.visibleViews[0]) {
      this.activeView = this.visibleViews[0].id;
    }
  }

  private selectView(view: StatusView) {
    this.activeView = view;
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    url.searchParams.delete("tab");
    window.history.pushState({}, "", url);
  }

  override render() {
    return html`
      ${this.visibleViews.length > 1 ? html`
        <div class="tabs" role="tablist" aria-label="平台状态">
          ${this.visibleViews.map((view) => html`
            <button
              type="button"
              role="tab"
              class="tab ${this.activeView === view.id ? "active" : ""}"
              aria-selected=${this.activeView === view.id}
              @click=${() => this.selectView(view.id)}
            >${view.label}</button>
          `)}
        </div>
      ` : nothing}
      ${this.activeView === "observations"
        ? html`<platform-observations-page></platform-observations-page>`
        : this.activeView === "sandbox"
        ? html`<agent-sandbox-status-page></agent-sandbox-status-page>`
        : html`<health-center-page></health-center-page>`}
    `;
  }
}
