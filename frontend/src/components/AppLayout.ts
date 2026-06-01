/**
 * Slide - Main Layout Component
 */
import { LitElement, html, css } from 'lit';
import { state } from 'lit/decorators.js';
import './AppSidebar.js';
import './AppHeader.js';
import apiClient from '../api/index.js';
import { alertAPI } from '../api/database.js';
import '../styles/global.css';
import { icons } from '../icons.js';

export class AppLayout extends LitElement {
  @state() private currentPage = '/';
  @state() private pageTitle = '';
  @state() private navCollapsed = false;
  @state() private alertCount = 0;
  @state() private currentUser: { username: string; role: string } | null = null;
  @state() private userMenuOpen = false;

  static override styles = css`
    :host {
      display: block;
    }

    .shell {
      --shell-pad: 16px;
      --shell-gap: 16px;
      --shell-nav-width: 240px;
      --shell-nav-rail-width: 64px;
      --shell-topbar-height: 56px;
      --shell-focus-duration: 200ms;
      --shell-focus-ease: var(--ease-out);
      height: 100vh;
      display: grid;
      grid-template-columns: var(--shell-nav-width) minmax(0, 1fr);
      grid-template-rows: var(--shell-topbar-height) 1fr;
      grid-template-areas:
        "nav topbar"
        "nav content";
      gap: 0;
      transition: grid-template-columns var(--shell-focus-duration) var(--shell-focus-ease);
      overflow: hidden;
    }

    .shell--nav-collapsed {
      grid-template-columns: var(--shell-nav-rail-width) minmax(0, 1fr);
    }

    .shell-nav {
      grid-area: nav;
      display: flex;
      min-height: 100%;
      overflow: hidden;
      border-right: 1px solid var(--border);
      transition: width var(--shell-focus-duration) var(--shell-focus-ease);
    }

    .topbar {
      grid-area: topbar;
      position: sticky;
      top: 0;
      z-index: 40;
      min-height: 56px;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 74%, transparent);
      background: var(--chrome);
      backdrop-filter: blur(8px);
    }

    .content {
      grid-area: content;
      padding: var(--shell-pad);
      height: 100%;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
    }
  `;

  private handleNavigate = (event: CustomEvent) => {
    const path = event.detail.path;
    window.history.pushState({}, '', path);
    this.currentPage = path;
    this.updatePageTitle(path);
  };

  private handleUserCommand = (event: CustomEvent) => {
    const command = event.detail.command;
    this.userMenuOpen = false;
    switch (command) {
      case 'home':
        window.history.pushState({}, '', '/');
        this.currentPage = '/';
        this.pageTitle = '';
        break;
      case 'alerts':
        window.history.pushState({}, '', '/alerts');
        this.currentPage = '/alerts';
        this.pageTitle = '告警管理';
        break;
      case 'settings':
        window.history.pushState({}, '', '/settings');
        this.currentPage = '/settings';
        this.pageTitle = '系统设置';
        break;
      case 'appearance':
        window.history.pushState({}, '', '/settings/appearance');
        this.currentPage = '/settings/appearance';
        this.pageTitle = '外观与设置';
        break;
      case 'logout':
        apiClient.setToken(null);
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.history.pushState({}, '', '/login');
        this.currentPage = '/login';
        break;
    }
  };

  private updatePageTitle(path: string) {
    const pathTitles: Record<string, string> = {
      '/': '仪表盘',
      '/instances': '数据库实例',
      '/chat': 'Chat Ops',
      '/skills': 'Skills 技能',
      '/reports': '运维报表',
      '/alerts': '告警管理',
      '/settings': '系统设置',
      '/settings/llm': 'AI 模型配置',
      '/settings/users': '用户管理',
      '/settings/appearance': '外观与设置',
    };
    this.pageTitle = pathTitles[path] || '';
  }

  private async loadAlertCount() {
    try {
      const data = await alertAPI.getAlertCount();
      this.alertCount = data?.count || 0;
    } catch (error) {
      console.error('加载告警数量失败:', error);
    }
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

  private handleToggleNav = () => {
    this.navCollapsed = !this.navCollapsed;
    this.requestUpdate();
  };

  private handlePopState = () => {
    this.currentPage = window.location.pathname;
    this.updatePageTitle(window.location.pathname);
  };

  private alertInterval: number | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.currentPage = window.location.pathname;
    this.updatePageTitle(window.location.pathname);
    this.loadCurrentUser();
    this.loadAlertCount();
    this.alertInterval = setInterval(() => this.loadAlertCount(), 300000);
    window.addEventListener('popstate', this.handlePopState);
    document.addEventListener('click', this.handleClickOutside.bind(this));
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.alertInterval) {
      clearInterval(this.alertInterval);
    }
    window.removeEventListener('popstate', this.handlePopState);
    document.removeEventListener('click', this.handleClickOutside.bind(this));
  }

  private handleClickOutside(event: MouseEvent) {
    const target = event.target as Node;
    if (this.userMenuOpen && !(target as Element).closest('.user-btn')) {
      this.userMenuOpen = false;
    }
  }

  private toggleUserMenu() {
    this.userMenuOpen = !this.userMenuOpen;
  }

  override render() {
    const shellClass = `shell ${this.navCollapsed ? 'shell--nav-collapsed' : ''}`;
    const username = this.currentUser?.username || 'Guest';

    return html`
      <div class="${shellClass}">
        <div class="shell-nav">
          <app-sidebar
            .collapsed=${this.navCollapsed}
            .activePath=${this.currentPage}
            .onToggleNav=${this.handleToggleNav}
            @navigate=${this.handleNavigate}
          ></app-sidebar>
        </div>

        <div class="topbar">
          <app-header
            .alertCount=${this.alertCount}
            .pageTitle=${this.pageTitle}
            @user-command=${this.handleUserCommand}
          ></app-header>
        </div>

        <div class="content">
          <slot></slot>
        </div>
      </div>
    `;
  }
}

if (!customElements.get('app-layout')) {
  customElements.define('app-layout', AppLayout);
}
