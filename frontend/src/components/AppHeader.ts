/**
 * Slide - Header Component
 */
import { LitElement, html, css } from 'lit';
import { property, state } from 'lit/decorators.js';
import { icons } from '../icons.js';
import '../styles/global.css';

export class AppHeader extends LitElement {
  @property({ type: Number }) alertCount = 0;
  @property({ type: String }) pageTitle = '';

  @state() private userMenuOpen = false;
  @state() private currentUser: { username: string; role: string } | null = null;

  static override styles = css`
    :host {
      display: block;
      height: var(--header-height, 56px);
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      padding: 0 16px;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 100%;
      gap: 16px;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      flex: 1;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    /* Breadcrumb */
    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--muted);
      min-width: 0;
      flex: 1;
    }

    .breadcrumb-link {
      color: var(--muted);
      cursor: pointer;
      transition: color var(--duration-fast);
      text-decoration: none;
      white-space: nowrap;
    }

    .breadcrumb-link:hover {
      color: var(--accent);
    }

    .breadcrumb-sep {
      color: var(--muted-strong);
      font-size: 16px;
      line-height: 1;
      flex-shrink: 0;
    }

    .breadcrumb-current {
      color: var(--text-strong);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Action buttons */
    .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border: none;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      border-radius: var(--radius-md);
      transition: all var(--duration-normal) var(--ease-out);
      position: relative;
    }

    .action-btn:hover {
      background: var(--bg-hover);
      color: var(--text);
    }

    .action-btn svg {
      width: 18px;
      height: 18px;
    }

    /* Alert button with badge */
    .alert-btn {
      position: relative;
    }

    .alert-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      background: var(--danger);
      color: #ffffff;
      font-size: 10px;
      font-weight: 700;
      border-radius: var(--radius-full);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* User button */
    .user-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg);
      cursor: pointer;
      transition: all var(--duration-normal) var(--ease-out);
    }

    .user-btn:hover {
      border-color: var(--border-hover);
      background: var(--bg-hover);
    }

    .user-avatar {
      width: 26px;
      height: 26px;
      border-radius: var(--radius-full);
      background: var(--accent);
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      flex-shrink: 0;
    }

    .username {
      color: var(--text);
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
    }

    /* User menu dropdown */
    .user-menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      min-width: 180px;
      background: var(--popover);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      padding: 6px;
      z-index: 1000;
      animation: scale-in var(--duration-fast) var(--ease-out);
    }

    @keyframes scale-in {
      from {
        opacity: 0;
        transform: scale(0.95);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .user-menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
      transition: all var(--duration-fast) var(--ease-out);
      border: none;
      background: transparent;
      width: 100%;
      text-align: left;
      border-radius: var(--radius-md);
    }

    .user-menu-item:hover {
      background: var(--bg-hover);
      color: var(--text-strong);
    }

    .user-menu-item svg {
      width: 16px;
      height: 16px;
      opacity: 0.7;
    }

    .user-menu-item:hover svg {
      opacity: 1;
    }

    .user-menu-divider {
      height: 1px;
      background: var(--border);
      margin: 6px 0;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('click', this.handleClickOutside.bind(this));
    this.loadCurrentUser();
  }

  private loadCurrentUser() {
    try {
      const userStr = localStorage.getItem('user');
      if (userStr) {
        this.currentUser = JSON.parse(userStr);
      }
    } catch (error) {
      console.error('Failed to load user:', error);
    }
  }

  private toggleSidebar() {
    this.dispatchEvent(
      new CustomEvent('toggle-sidebar', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private toggleUserMenu() {
    this.userMenuOpen = !this.userMenuOpen;
  }

  private handleUserCommand(command: string) {
    this.userMenuOpen = false;
    this.dispatchEvent(
      new CustomEvent('user-command', {
        detail: { command },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleClickOutside(event: MouseEvent) {
    const target = event.target as Node;
    if (this.userMenuOpen && !this.contains(target)) {
      this.userMenuOpen = false;
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this.handleClickOutside.bind(this));
  }

  override render() {
    return html`
      <div class="header">
        <div class="header-left">
          <nav class="breadcrumb">
            <span class="breadcrumb-link" @click=${() => this.handleUserCommand('home')}>首页</span>
            ${this.pageTitle
              ? html`
                  <span class="breadcrumb-sep">›</span>
                  <span class="breadcrumb-current">${this.pageTitle}</span>
                `
              : ''}
          </nav>
        </div>

        <div class="header-right">
          <button
            class="action-btn alert-btn"
            @click=${() => this.handleUserCommand('alerts')}
            title="告警通知"
          >
            ${icons['bell']}
            ${this.alertCount > 0
              ? html`<span class="alert-badge">${this.alertCount}</span>`
              : ''}
          </button>

          <button class="user-btn" @click=${this.toggleUserMenu}>
            <div class="user-avatar">
              ${this.currentUser?.username?.charAt(0).toUpperCase() || 'A'}
            </div>
            <span class="username">${this.currentUser?.username || 'Guest'}</span>
          </button>

          ${this.userMenuOpen
            ? html`
                <div class="user-menu">
                  <button class="user-menu-item" @click=${() => this.handleUserCommand('settings')}>
                    ${icons['settings']}
                    <span>系统设置</span>
                  </button>
                  <button
                    class="user-menu-item"
                    @click=${() => this.handleUserCommand('appearance')}
                  >
                    ${icons['palette']}
                    <span>外观与设置</span>
                  </button>
                  <div class="user-menu-divider"></div>
                  <button class="user-menu-item" @click=${() => this.handleUserCommand('logout')}>
                    ${icons['circle-x']}
                    <span>退出登录</span>
                  </button>
                </div>
              `
            : ''}
        </div>
      </div>
    `;
  }
}

if (!customElements.get('app-header')) {
  customElements.define('app-header', AppHeader);
}
