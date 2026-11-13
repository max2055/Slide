import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "../components/app-empty-state.js";
import { permissionMatches } from "../settings-navigation.ts";

type StatusView = "health" | "observations" | "sandbox";

const STATUS_VIEWS: readonly { id: StatusView; label: string; permission: string }[] = [
  { id: "health", label: "平台自检", permission: "config:view" },
  { id: "observations", label: "平台观测", permission: "config:view" },
  { id: "sandbox", label: "Agent 沙箱", permission: "audit:view" },
];

@customElement("platform-status-page")
export class PlatformStatusPage extends LitElement {
  @state() private activeView: StatusView | null = null;
  @state() private permissions: Set<string> = new Set();
  private connectedPath = "";
  private readonly permissionsHandler = (event: Event) => {
    const values = (event as CustomEvent<{ permissions?: string[] }>).detail?.permissions;
    this.permissions = values === undefined ? this.readPermissions() : this.parsePermissions(values);
    this.syncLocation();
  };

  private readonly popStateHandler = () => this.syncLocation();

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("slide-permissions-loaded", this.permissionsHandler);
    window.addEventListener("popstate", this.popStateHandler);
    this.connectedPath = window.location.pathname;
    this.permissions = this.readPermissions();
    this.syncLocation();
  }

  override disconnectedCallback() {
    window.removeEventListener("slide-permissions-loaded", this.permissionsHandler);
    window.removeEventListener("popstate", this.popStateHandler);
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
    .tab.active { border-bottom-color: var(--accent); color: var(--accent-text); font-weight: 600; }
  `;

  private parsePermissions(values: unknown): Set<string> {
    return Array.isArray(values) && values.every((value) => typeof value === "string")
      ? new Set(values) : new Set();
  }

  private readPermissions(): Set<string> {
    try {
      return this.parsePermissions(JSON.parse(localStorage.getItem("permissions") ?? "null"));
    } catch {
      return new Set();
    }
  }

  private get visibleViews() {
    return STATUS_VIEWS.filter((view) => permissionMatches(this.permissions, view.permission));
  }

  private syncLocation() {
    // The shell removes this component after the current popstate dispatch.
    if (window.location.pathname !== this.connectedPath) return;
    const url = new URL(window.location.href);
    const requested = url.searchParams.get("view");
    const visible = this.visibleViews;
    this.activeView = visible.find((view) => view.id === requested)?.id ?? visible[0]?.id ?? null;
    // Normalize denied/unknown views without adding an extra history entry.
    if (this.activeView && requested !== null && requested !== this.activeView) {
      url.searchParams.set("view", this.activeView);
      window.history.replaceState(window.history.state, "", url);
    }
  }

  private selectView(view: StatusView) {
    if (view === this.activeView || !this.visibleViews.some((item) => item.id === view)) return;
    this.activeView = view;
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    url.searchParams.delete("tab");
    window.history.pushState({}, "", url);
  }

  override render() {
    if (!this.visibleViews.some((view) => view.id === this.activeView)) {
      return html`<app-empty-state role="status" title="无权限访问平台状态"
        description="当前账号没有可访问的平台状态视图，请联系管理员。"
      ></app-empty-state>`;
    }
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
