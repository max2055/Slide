import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { icons } from "../../../icons.js";
import {
  SETTINGS_GROUPS,
  canAccessSettingsItem,
  findSettingsRoute,
  settingsBasePath,
  settingsItemById,
  visibleSettingsViews,
  type SettingsItem,
  type SettingsPageId,
} from "../settings-navigation.ts";
import "../components/app-empty-state.js";

function readPermissions(): Set<string> | null {
  try {
    const raw = localStorage.getItem("permissions");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : null;
  } catch {
    return null;
  }
}

@customElement("settings-shell")
export class SettingsShell extends LitElement {
  @state() private activePage: SettingsPageId = "branding";
  @state() private activeView = "";
  @state() private permissions: Set<string> | null = readPermissions();
  @state() private accessDenied = false;

  private readonly popStateHandler = () => this.syncFromLocation();
  private readonly permissionsHandler = (event: Event) => {
    const detail = (event as CustomEvent<{ permissions?: string[] }>).detail;
    this.permissions = Array.isArray(detail?.permissions)
      ? new Set(detail.permissions)
      : readPermissions();
    this.syncFromLocation();
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("popstate", this.popStateHandler);
    window.addEventListener("slide-permissions-loaded", this.permissionsHandler);
    this.syncFromLocation();
  }

  override disconnectedCallback() {
    window.removeEventListener("popstate", this.popStateHandler);
    window.removeEventListener("slide-permissions-loaded", this.permissionsHandler);
    super.disconnectedCallback();
  }

  static styles = css`
    :host {
      display: grid;
      grid-template-columns: minmax(11.5rem, 14rem) minmax(0, 1fr);
      height: 100%;
      min-height: 0;
      overflow: hidden;
      margin: calc(var(--space-lg) * -1) calc(var(--space-xl) * -1) -2rem;
    }

    .settings-nav {
      overflow-y: auto;
      border-right: 1px solid var(--border);
      background: var(--card);
      padding: var(--space-lg) var(--space-md) var(--space-xl);
    }

    .settings-group + .settings-group { margin-top: var(--space-lg); }

    .settings-group__label {
      padding: 0 var(--space-md) var(--space-xs);
      color: var(--muted);
      font-size: var(--text-xs);
      font-weight: 600;
      letter-spacing: 0;
    }

    .settings-item {
      position: relative;
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      width: 100%;
      min-height: 2.5rem;
      padding: var(--space-sm) var(--space-md);
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text);
      font: inherit;
      font-size: var(--text-base);
      text-align: left;
      cursor: pointer;
      transition: background var(--duration-fast) ease, color var(--duration-fast) ease;
    }

    .settings-item:hover { background: var(--bg-hover); }

    .settings-item:focus-visible,
    .content-tab:focus-visible,
    .settings-select:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .settings-item.active {
      background: var(--active);
      color: var(--text-strong);
      font-weight: 600;
    }

    .settings-item.active::before {
      position: absolute;
      inset: var(--space-xs) auto var(--space-xs) 0;
      width: 0.2rem;
      border-radius: var(--radius-sm);
      background: var(--accent);
      content: "";
    }

    .settings-item__icon {
      display: inline-flex;
      width: 1rem;
      height: 1rem;
      flex: 0 0 1rem;
    }

    .settings-item__icon svg { width: 100%; height: 100%; }

    .settings-main {
      min-width: 0;
      overflow-y: auto;
      padding: var(--space-xl);
    }

    .mobile-heading { display: none; }

    .content-tabs {
      display: flex;
      gap: var(--space-xs);
      margin-bottom: var(--space-xl);
      overflow-x: auto;
      border-bottom: 1px solid var(--border);
    }

    .content-tab {
      flex: 0 0 auto;
      padding: var(--space-sm) var(--space-lg);
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--muted);
      font: inherit;
      font-size: var(--text-base);
      cursor: pointer;
    }

    .content-tab.active {
      border-bottom-color: var(--accent);
      color: var(--accent);
      font-weight: 600;
    }

    @media (max-width: 720px) {
      :host {
        display: block;
        height: auto;
        min-height: 100%;
        margin: calc(var(--space-lg) * -1) calc(var(--space-md) * -1) -2rem;
        overflow: visible;
      }

      .settings-nav {
        position: sticky;
        top: 0;
        z-index: 2;
        overflow: visible;
        border-right: 0;
        border-bottom: 1px solid var(--border);
        padding: var(--space-md);
      }

      .desktop-groups { display: none; }

      .mobile-heading { display: grid; gap: var(--space-xs); }

      .mobile-heading__path { color: var(--muted); font-size: var(--text-xs); }

      .mobile-heading__row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(8rem, 45%);
        align-items: center;
        gap: var(--space-md);
      }

      .mobile-heading__title {
        overflow-wrap: anywhere;
        color: var(--text-strong);
        font-size: var(--text-lg);
        font-weight: 600;
      }

      .settings-select {
        width: 100%;
        min-width: 0;
        padding: var(--space-sm) var(--space-md);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--card);
        color: var(--text);
        font: inherit;
      }

      .settings-main {
        overflow: visible;
        padding: var(--space-lg) var(--space-md) var(--space-xl);
      }
    }
  `;

  private get visibleGroups() {
    return SETTINGS_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccessSettingsItem(item, this.permissions)),
    })).filter((group) => group.items.length > 0);
  }

  private syncFromLocation() {
    const pathname = window.location.pathname;
    const route = findSettingsRoute(pathname);
    const isSettingsRoot = pathname.replace(/\/$/, "").endsWith("/settings");
    const firstItem = this.visibleGroups[0]?.items[0];

    if (!route && isSettingsRoot && firstItem) {
      this.navigateTo(firstItem, true);
      return;
    }

    if (!route) return;
    this.activePage = route.item.id;
    this.accessDenied = !canAccessSettingsItem(route.item, this.permissions);
    if (this.accessDenied) {
      this.activeView = "";
      return;
    }

    const views = visibleSettingsViews(route.item, this.permissions);
    const requestedView = route.view ?? new URL(window.location.href).searchParams.get("view") ?? "";
    this.activeView = views.some((view) => view.id === requestedView)
      ? requestedView
      : (views[0]?.id ?? "");

    if (route.legacy || (views.length > 0 && requestedView !== this.activeView)) {
      this.navigateTo(route.item, true, this.activeView);
    }
  }

  private navigateTo(item: SettingsItem, replace = false, view?: string) {
    const url = new URL(window.location.href);
    url.pathname = `${settingsBasePath(window.location.pathname)}${item.path}`;
    url.searchParams.delete("tab");
    const views = visibleSettingsViews(item, this.permissions);
    if (views.length > 0) {
      const targetView = views.some((candidate) => candidate.id === view) ? view! : views[0].id;
      url.searchParams.set("view", targetView);
      this.activeView = targetView;
    } else {
      url.searchParams.delete("view");
      this.activeView = "";
    }
    this.activePage = item.id;
    this.accessDenied = false;
    window.history[replace ? "replaceState" : "pushState"]({}, "", url);
  }

  private selectView(view: string) {
    const item = settingsItemById(this.activePage);
    if (item) this.navigateTo(item, false, view);
  }

  private renderDesktopNavigation() {
    return html`
      <div class="desktop-groups">
        ${this.visibleGroups.map((group) => html`
          <section class="settings-group" aria-labelledby=${`settings-group-${group.id}`}>
            <div id=${`settings-group-${group.id}`} class="settings-group__label">${group.label}</div>
            ${group.items.map((item) => html`
              <button
                type="button"
                class="settings-item ${this.activePage === item.id ? "active" : ""}"
                aria-current=${this.activePage === item.id ? "page" : nothing}
                @click=${() => this.navigateTo(item)}
              >
                <span class="settings-item__icon" aria-hidden="true">${icons[item.icon as keyof typeof icons] ?? nothing}</span>
                <span>${item.label}</span>
              </button>
            `)}
          </section>
        `)}
      </div>
    `;
  }

  private renderMobileNavigation() {
    const activeItem = settingsItemById(this.activePage);
    const activeGroup = this.visibleGroups.find((group) => group.items.some((item) => item.id === this.activePage));
    return html`
      <div class="mobile-heading">
        <div class="mobile-heading__path">设置 / ${activeGroup?.label ?? ""}</div>
        <div class="mobile-heading__row">
          <div class="mobile-heading__title">${activeItem?.label ?? "设置"}</div>
          <select
            class="settings-select"
            aria-label="选择设置页面"
            .value=${this.activePage}
            @change=${(event: Event) => {
              const item = settingsItemById((event.target as HTMLSelectElement).value as SettingsPageId);
              if (item) this.navigateTo(item);
            }}
          >
            ${this.visibleGroups.map((group) => html`
              <optgroup label=${group.label}>
                ${group.items.map((item) => html`<option value=${item.id}>${item.label}</option>`)}
              </optgroup>
            `)}
          </select>
        </div>
      </div>
    `;
  }

  private renderContentTabs(item: SettingsItem | undefined) {
    if (!item) return nothing;
    const views = visibleSettingsViews(item, this.permissions);
    if (views.length < 2) return nothing;
    return html`
      <div class="content-tabs" role="tablist" aria-label=${item.label}>
        ${views.map((view) => html`
          <button
            type="button"
            role="tab"
            class="content-tab ${this.activeView === view.id ? "active" : ""}"
            aria-selected=${this.activeView === view.id}
            @click=${() => this.selectView(view.id)}
          >${view.label}</button>
        `)}
      </div>
    `;
  }

  override render() {
    const item = settingsItemById(this.activePage);
    return html`
      <nav class="settings-nav" aria-label="设置导航">
        ${this.renderDesktopNavigation()}
        ${this.renderMobileNavigation()}
      </nav>
      <main class="settings-main">
        ${this.accessDenied
          ? html`<app-empty-state icon="lock" title="无权访问" description="当前账号无权访问此设置页面。"></app-empty-state>`
          : html`${this.renderContentTabs(item)}${this.renderPage()}`}
      </main>
    `;
  }

  private renderPage() {
    switch (this.activePage) {
      case "branding": return html`<branding-settings></branding-settings>`;
      case "appearance": return html`<appearance-settings></appearance-settings>`;
      case "notifications": return html`<feishu-notification-settings></feishu-notification-settings>`;
      case "metrics": return html`<metric-registry-viewer></metric-registry-viewer>`;
      case "analysis": return this.activeView === "scoring"
        ? html`<scoring-settings-page></scoring-settings-page>`
        : html`<ai-settings-page></ai-settings-page>`;
      case "models": return html`<llm-config-page></llm-config-page>`;
      case "prompts": return html`<prompt-settings-page></prompt-settings-page>`;
      case "capabilities": return this.activeView === "tools"
        ? html`<agent-tools-page></agent-tools-page>`
        : html`<agent-skills-page></agent-skills-page>`;
      case "security": return this.activeView === "sandbox"
        ? html`<agent-sandbox-status-page></agent-sandbox-status-page>`
        : html`<agent-security-policy-page></agent-security-policy-page>`;
      case "users": return this.activeView === "accounts"
        ? html`<users-management></users-management>`
        : html`<rbac-admin-page .activeSubTab=${this.activeView} .embedded=${true}></rbac-admin-page>`;
      case "login": return html`<session-settings-page></session-settings-page>`;
    }
  }
}
