/**
 * 实例详情页面布局
 * 以数据库实例为中心的功能导航框架
 */
import { LitElement, html, css } from 'lit';
import { state } from 'lit/decorators.js';
import { icons } from '../icons.js';
import { databaseAPI } from '../api/database.js';
import type { DatabaseInstance } from '../api/database.js';
import '../styles/global.css';

interface TabConfig {
  id: string;
  label: string;
  icon: string;
  path: string;
}

export class InstanceDetailLayout extends LitElement {
  @state() private instance: DatabaseInstance | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private currentTab = 'overview';

  private instanceId: string = '';

  private tabs: TabConfig[] = [
    { id: 'overview', label: '概览', icon: 'layout-dashboard', path: '/overview' },
    { id: 'health', label: '健康检查', icon: 'heart-pulse', path: '/health' },
    { id: 'slow-queries', label: '慢查询', icon: 'clock', path: '/slow-queries' },
    { id: 'faults', label: '故障诊断', icon: 'stethoscope', path: '/faults' },
    { id: 'metrics', label: '监控指标', icon: 'circle-help', path: '/metrics' },
    { id: 'settings', label: '设置', icon: 'settings', path: '/settings' },
  ];

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      animation: fade-in 0.3s var(--ease-out);
    }

    /* Header */
    .instance-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      background: var(--card);
      border-bottom: 1px solid var(--border);
    }

    .instance-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .instance-icon {
      width: 40px;
      height: 40px;
      background: var(--accent-subtle);
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--accent);
    }

    .instance-icon svg {
      width: 24px;
      height: 24px;
    }

    .instance-meta {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .instance-name {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-strong);
    }

    .instance-connection {
      font-size: 12px;
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .instance-actions {
      display: flex;
      gap: 8px;
    }

    /* Status badge */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 600;
      border-radius: var(--radius-full);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .status-badge--healthy {
      background: var(--ok-subtle);
      color: var(--ok);
    }

    .status-badge--warning {
      background: var(--warn-subtle);
      color: var(--warn);
    }

    .status-badge--critical {
      background: var(--danger-subtle);
      color: var(--danger);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* Tabs navigation */
    .tabs-nav {
      display: flex;
      gap: 4px;
      padding: 0 20px;
      background: var(--card);
      border-bottom: 1px solid var(--border);
    }

    .tab-button {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      font-size: 13px;
      font-weight: 500;
      color: var(--muted);
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: all var(--duration-normal) var(--ease-out);
      position: relative;
      bottom: -1px;
    }

    .tab-button svg {
      width: 16px;
      height: 16px;
    }

    .tab-button:hover {
      color: var(--text);
      background: var(--bg-hover);
    }

    .tab-button--active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }

    .tab-button--active:hover {
      background: var(--accent-subtle);
    }

    /* Content area */
    .tab-content {
      flex: 1;
      overflow: auto;
      padding: 20px;
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      border-radius: var(--radius-md);
      border: 1px solid transparent;
      cursor: pointer;
      transition: all var(--duration-normal) var(--ease-out);
    }

    .btn--primary {
      background: var(--accent);
      color: var(--accent-foreground);
    }

    .btn--primary:hover {
      background: var(--accent-hover);
    }

    .btn--secondary {
      background: var(--bg-hover);
      color: var(--text);
      border-color: var(--border);
    }

    .btn--secondary:hover {
      background: var(--bg-elevated);
      border-color: var(--border-hover);
    }

    .btn svg {
      width: 16px;
      height: 16px;
    }

    /* Loading */
    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 16px;
      color: var(--muted);
    }

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Error state */
    .error-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 12px;
      color: var(--danger);
    }

    .error-state svg {
      width: 48px;
      height: 48px;
      opacity: 0.5;
    }
  `;

  override async firstUpdated() {
    await this.loadInstance();
  }

  private getInstanceIdFromPath(): string {
    const match = window.location.pathname.match(/\/instances\/([^\/]+)/);
    return match ? match[1] : '';
  }

  private async loadInstance() {
    this.instanceId = this.getInstanceIdFromPath();
    if (!this.instanceId) {
      this.error = '无效的实例 ID';
      return;
    }

    this.loading = true;
    this.error = null;
    try {
      const data = await databaseAPI.getInstance(this.instanceId);
      this.instance = data?.instance || null;
    } catch (err) {
      this.error = '加载实例信息失败';
      console.error(err);
    } finally {
      this.loading = false;
    }
  }

  private handleTabChange(tabId: string) {
    this.currentTab = tabId;
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab) {
      window.history.pushState({}, '', `/instances/${this.instanceId}${tab.path}`);
    }
  }

  private getCurrentTabFromPath(): string {
    const path = window.location.pathname;
    for (const tab of this.tabs) {
      if (path.endsWith(tab.path)) {
        return tab.id;
      }
    }
    return 'overview';
  }

  private getStatusClass(status: string): string {
    const lower = status.toLowerCase();
    if (lower === 'healthy' || lower === 'running') return 'healthy';
    if (lower === 'warning') return 'warning';
    return 'critical';
  }

  override render() {
    if (this.loading) {
      return html`
        <div class="loading">
          <div class="loading-spinner"></div>
          <span>加载实例信息...</span>
        </div>
      `;
    }

    if (this.error || !this.instance) {
      return html`
        <div class="error-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>${this.error || '实例不存在'}</span>
        </div>
      `;
    }

    const currentTab = this.getCurrentTabFromPath();

    return html`
      <!-- Header -->
      <div class="instance-header">
        <div class="instance-info">
          <div class="instance-icon">
            ${this.instance.db_type === 'mysql' ? icons['database'] : this.instance.db_type === 'postgresql' ? icons['database'] : icons['database']}
          </div>
          <div class="instance-meta">
            <span class="instance-name">${this.instance.name}</span>
            <span class="instance-connection">
              ${icons['link']}
              ${this.instance.host}:${this.instance.port}
            </span>
          </div>
        </div>
        <div class="instance-actions">
          <span class="status-badge status-badge--${this.getStatusClass(this.instance.status)}">
            <span class="status-dot"></span>
            ${this.instance.status}
          </span>
          <button class="btn btn--secondary" @click=${() => this.handleTabChange('health')}>
            ${icons['heart-pulse']}
            健康检查
          </button>
          <button class="btn btn--secondary" @click=${() => window.history.back()}>
            返回
          </button>
        </div>
      </div>

      <!-- Tabs Navigation -->
      <nav class="tabs-nav">
        ${this.tabs.map(
          (tab) => html`
            <button
              class="tab-button ${currentTab === tab.id ? 'tab-button--active' : ''}"
              @click=${() => this.handleTabChange(tab.id)}
            >
              ${(icons as any)[tab.icon] || (icons as any)['layout-dashboard']}
              ${tab.label}
            </button>
          `,
        )}
      </nav>

      <!-- Tab Content -->
      <div class="tab-content">
        <slot name="tab-content"></slot>
      </div>
    `;
  }
}

if (!customElements.get('instance-detail-layout')) {
  customElements.define('instance-detail-layout', InstanceDetailLayout);
}
