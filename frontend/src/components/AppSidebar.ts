/**
 * Slide - Sidebar Navigation Component
 */
import { LitElement, html, css } from 'lit';
import { property } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { icons, type IconName } from '../icons.js';
import '../styles/global.css';

type NavItem = {
  path: string;
  label: string;
  icon: IconName;
};

const navItems: NavItem[] = [
  { path: '/', label: '仪表盘', icon: 'layout-grid' },
  { path: '/instances', label: '数据库实例', icon: 'database' },
  { path: '/chat', label: 'Chat Ops', icon: 'message' },
  { path: '/skills', label: 'Skills 技能', icon: 'zap' },
  { path: '/scheduler', label: '定时任务', icon: 'clock' },
  { path: '/reports', label: '运维报表', icon: 'file-text' },
  { path: '/alerts', label: '告警管理', icon: 'bell' },
  { path: '/settings', label: '系统设置', icon: 'settings' },
];

export class AppSidebar extends LitElement {
  @property({ type: String }) activePath = '/';
  @property({ attribute: false }) onToggleNav?: () => void;

  // Collapsed state - controlled by parent
  @property({ type: Boolean, reflect: true }) collapsed = false;
  private _toggling = false;

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: color-mix(in srgb, var(--panel) 98%, white 2%);
      height: 100%;
      overflow: hidden;
      width: 100%;
    }

    .sidebar-shell {
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1;
      padding: 14px 10px 12px;
      border: none;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
    }

    .sidebar-shell__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 0;
      padding: 0 8px 18px;
      flex-shrink: 0;
      position: relative;
    }

    .sidebar-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    :host([collapsed]) .sidebar-brand {
      display: none;
    }

    .logo-icon {
      width: 32px;
      height: 32px;
      color: var(--accent);
      flex-shrink: 0;
    }

    .logo-text {
      color: var(--text-strong);
      font-size: 15px;
      font-weight: 700;
      letter-spacing: -0.03em;
      white-space: nowrap;
    }

    .nav-collapse-toggle {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);
      border: none;
      border-radius: var(--radius-full);
      cursor: pointer;
      transition:
        background var(--duration-fast) ease,
        color var(--duration-fast) ease,
        transform var(--duration-fast) ease;
      margin-bottom: 0;
      color: var(--muted);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 8%, transparent);
      flex-shrink: 0;
      position: absolute;
      right: 8px;
      top: 0;
    }

    :host([collapsed]) .nav-collapse-toggle {
      position: static;
      margin: 0 auto 18px;
    }

    .nav-collapse-toggle:hover {
      background: color-mix(in srgb, var(--bg-hover) 90%, transparent);
      color: var(--text);
      transform: translateY(-1px);
    }

    .nav-collapse-toggle svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.5px;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .sidebar-nav {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0;
      scrollbar-width: none;
    }

    .sidebar-nav::-webkit-scrollbar {
      display: none;
    }

    .nav-item {
      display: flex;
      align-items: center;
      padding: 8px 10px;
      margin: 2px 0;
      border-radius: var(--radius-md);
      color: var(--muted);
      cursor: pointer;
      transition: all var(--duration-normal) var(--ease-out);
      text-decoration: none;
      gap: 10px;
      min-height: 36px;
    }

    .nav-item:hover {
      background: color-mix(in srgb, var(--bg-hover) 72%, transparent);
      color: var(--text);
    }

    .nav-item--active {
      background: var(--accent-subtle);
      color: var(--accent);
      font-weight: 500;
    }

    .nav-item svg {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
    }

    .nav-item-text {
      font-size: 14px;
      white-space: nowrap;
    }

    :host([collapsed]) .nav-item-text {
      display: none;
    }

    :host([collapsed]) .nav-item {
      justify-content: center;
      padding: 8px;
    }
  `;

  private handleNavClick(path: string) {
    this.dispatchEvent(
      new CustomEvent('navigate', {
        detail: { path },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleToggleClick() {
    if (this._toggling) return;
    this._toggling = true;

    // Notify parent to toggle layout
    this.onToggleNav?.();

    // Release lock after animation frame
    requestAnimationFrame(() => { this._toggling = false; });
  }

  override render() {
    const c = this.collapsed;
    return html`
      <div class="sidebar-shell">
        <div class="sidebar-shell__header">
          <div class="sidebar-brand">
            <svg class="logo-icon" viewBox="0 0 32 32" fill="currentColor">
              <!-- Slide Logo - S 形滑道 (复刻原版) -->
              <path d="M5 25 L21 25 C25 25 27 23 27 19 C27 15 25 13 21 13 L15 13 C11 13 9 11 9 7 C9 5 10 4 12 4 L12 6 C11 6 10 7 10 9 C10 12 12 14 17 14 L21 14 C24 14 26 16 26 19 C26 22 24 24 21 24 L5 24 Z" />
              <circle cx="22" cy="8" r="2.5" fill="currentColor" />
            </svg>
            <span class="logo-text">Slide</span>
          </div>
          <button
            class="nav-collapse-toggle"
            @click=${this.handleToggleClick}
            title=${c ? '展开侧边栏' : '折叠侧边栏'}
            aria-label=${c ? '展开侧边栏' : '折叠侧边栏'}
          >
            ${c ? icons['panel-right-open'] : icons['panel-left-close']}
          </button>
        </div>

        <nav class="sidebar-nav">
          ${navItems.map(
            (item) => html`
              <a
                class="nav-item ${this.activePath === item.path ? 'nav-item--active' : ''}"
                @click=${() => this.handleNavClick(item.path)}
                title=${c ? item.label : ifDefined(undefined)}
              >
                <span>${icons[item.icon]}</span>
                <span class="nav-item-text">${item.label}</span>
              </a>
            `
          )}
        </nav>
      </div>
    `;
  }
}

if (!customElements.get('app-sidebar')) {
  customElements.define('app-sidebar', AppSidebar);
}
