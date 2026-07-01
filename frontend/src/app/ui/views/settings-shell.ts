/**
 * Settings Shell — unified settings page with sub-tab navigation.
 * Replaces the flat settings tabs in the sidebar with a single entry.
 */
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { icons } from "../../../icons.js";

type SettingsSubTab =
  | "ai-settings"
  | "prompt-settings"
  | "llm-config"
  | "scoring-settings"
  | "cron-jobs"
  | "appearance"
  | "branding"
  | "users"
  | "rbac"
  | "health-center"
  | "agent-sessions"
  | "agent-skills"
  | "agent-tools";

const SUB_TABS: { id: SettingsSubTab; label: string; icon: string; requireAdmin?: boolean }[] = [
  { id: "ai-settings", label: "AI 设置", icon: "sparkles" },
  { id: "prompt-settings", label: "提示词管理", icon: "book" },
  { id: "llm-config", label: "LLM 配置", icon: "brain" },
  { id: "scoring-settings", label: "评分权重", icon: "bar-chart" },
  { id: "appearance", label: "外观", icon: "spark" },
  { id: "branding", label: "品牌", icon: "palette" },
  { id: "users", label: "用户管理", icon: "scroll-text", requireAdmin: true },
  { id: "rbac", label: "权限管理", icon: "shield", requireAdmin: true },
  { id: "health-center", label: "闭环健康", icon: "activity" },
  { id: "agent-sessions", label: "Agent 会话", icon: "message-square" },
  { id: "agent-skills", label: "Agent Skills", icon: "book" },
  { id: "agent-tools", label: "Agent Tools", icon: "wrench" },
];

@customElement("settings-shell")
export class SettingsShell extends LitElement {
  @state() private activeTab: SettingsSubTab = "ai-settings";

  override connectedCallback() {
    super.connectedCallback();
    this._navHandler = (e: any) => {
      const { settingsSubTab } = e.detail || {};
      if (settingsSubTab) {
        const target = settingsSubTab.replace('#/settings/', '');
        if (this._isValidTab(target)) this.activeTab = target as SettingsSubTab;
      }
    };
    window.addEventListener("slide-navigate", this._navHandler);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._navHandler) window.removeEventListener("slide-navigate", this._navHandler);
  }

  private _navHandler: ((e: any) => void) | null = null;

  private _isValidTab(tab: string): boolean {
    return SUB_TABS.some(t => t.id === tab);
  }

  static styles = css`
    :host {
      display: flex;
      height: 100%;
      overflow: hidden;
    }
    .settings-subnav {
      width: 200px;
      min-width: 200px;
      border-right: 1px solid var(--border);
      background: var(--card);
      padding: 12px 0;
      overflow-y: auto;
    }
    .settings-subnav__title {
      padding: 0 16px 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
    }
    .settings-subtab {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 16px;
      border: none;
      background: none;
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
      text-align: left;
      transition: background 0.15s;
    }
    .settings-subtab:hover {
      background: var(--hover);
    }
    .settings-subtab.active {
      background: var(--active);
      color: var(--text-strong);
      font-weight: 500;
    }
    .settings-subtab svg {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    .settings-content {
      flex: 1;
      overflow-y: auto;
      padding: 20px 24px;
    }
  `;

  render() {
    const isAdmin = this._hasAdminAccess();
    const visibleTabs = SUB_TABS.filter(t => !t.requireAdmin || isAdmin);

    return html`
      <nav class="settings-subnav">
        <div class="settings-subnav__title">设置</div>
        ${visibleTabs.map(tab => html`
          <button
            class="settings-subtab ${this.activeTab === tab.id ? "active" : ""}"
            @click=${() => { this.activeTab = tab.id; }}
          >
            ${icons[tab.icon as keyof typeof icons] || ""}
            <span>${tab.label}</span>
          </button>
        `)}
      </nav>
      <main class="settings-content">
        ${this._renderTabContent()}
      </main>
    `;
  }

  private _renderTabContent() {
    switch (this.activeTab) {
      case "ai-settings":
        return html`<ai-settings-page></ai-settings-page>`;
      case "prompt-settings":
        return html`<prompt-settings-page></prompt-settings-page>`;
      case "llm-config":
        return html`<llm-config-page></llm-config-page>`;
      case "scoring-settings":
        return html`<scoring-settings-page></scoring-settings-page>`;
      case "appearance":
        return html`<appearance-settings></appearance-settings>`;
      case "branding":
        return html`<branding-settings></branding-settings>`;
      case "users":
        return html`<users-management></users-management>`;
      case "rbac":
        return html`<rbac-admin-page></rbac-admin-page>`;
      case "health-center":
        return html`<health-center-page></health-center-page>`;
      case "agent-sessions":
        return html`<agent-sessions-page></agent-sessions-page>`;
      case "agent-skills":
        return html`<agent-skills-page></agent-skills-page>`;
      case "agent-tools":
        return html`<agent-tools-page></agent-tools-page>`;
      default:
        return html``;
    }
  }

  private _hasAdminAccess(): boolean {
    try {
      const raw = localStorage.getItem("permissions");
      if (!raw) return true; // Not loaded yet — default to showing tabs (pages have their own auth)
      const perms = JSON.parse(raw);
      if (!Array.isArray(perms)) return true;
      return perms.includes("admin:*") || perms.includes("*");
    } catch { return true; } // Parse error — show tabs, individual pages handle auth
  }
}
