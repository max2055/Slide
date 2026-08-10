import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { InstanceHostMapping, InstanceHostRole } from '../../../api/generated/public-api.js';
import { authFetch } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './app-badge.js';
import './app-empty-state.js';
import './app-form-field.js';

interface ServerOption {
  id: number;
  host: string;
  port: number;
  label: string | null;
  os_type: string;
  status: string;
  collection_enabled: boolean | number;
}

const HOST_ROLES: Array<{ value: InstanceHostRole; label: string }> = [
  { value: 'standalone', label: '独立节点' },
  { value: 'primary', label: '主节点' },
  { value: 'replica', label: '副本' },
  { value: 'shard', label: '分片' },
  { value: 'arbiter', label: '仲裁节点' },
  { value: 'unknown', label: '未知角色' },
];

function isSupportedLinux(osType: string): boolean {
  const normalized = osType.toLowerCase().trim().replace(/\s+/g, ' ');
  if (normalized === 'linux') return true;
  return /^(?:rhel|red hat enterprise linux|centos(?: linux)?|rocky(?: linux)?|almalinux|oracle linux(?: server)?|ubuntu(?: linux)?|debian(?: gnu\/linux)?|fedora(?: linux)?|kylin)(?:\s*-?\s*v?\d+(?:\.\d+)*)?$/.test(normalized);
}

@customElement('instance-host-field')
export class InstanceHostField extends LitElement {
  @property({ attribute: false }) value: InstanceHostMapping[] | null = null;
  @property({ type: Boolean }) loading = false;
  @property({ attribute: false }) error: string | null = null;
  @property({ type: Boolean }) disabled = false;

  @state() private servers: ServerOption[] = [];
  @state() private serversLoading = true;
  @state() private serversError: string | null = null;

  override firstUpdated(): void {
    void this.loadServers();
  }

  private async loadServers(): Promise<void> {
    this.serversLoading = true;
    this.serversError = null;
    try {
      const response = await authFetch('/api/servers');
      if (!response.ok) throw new Error('Linux 主机列表加载失败');
      const servers = await response.json() as ServerOption[];
      this.servers = servers.filter((server) => isSupportedLinux(server.os_type));
    } catch (error) {
      this.servers = [];
      this.serversError = error instanceof Error ? error.message : 'Linux 主机列表加载失败';
    } finally {
      this.serversLoading = false;
    }
  }

  private emitHosts(hosts: InstanceHostMapping[]): void {
    this.value = hosts;
    this.dispatchEvent(new CustomEvent('instance-host-change', {
      detail: { hosts },
      bubbles: true,
      composed: true,
    }));
  }

  private onSelectionChange(serverId: number, selected: boolean): void {
    if (this.disabled || this.value === null) return;
    const current = [...this.value];
    if (selected && !current.some((mapping) => mapping.serverId === serverId)) {
      current.push({ serverId, role: 'standalone' });
    } else if (!selected) {
      const index = current.findIndex((mapping) => mapping.serverId === serverId);
      if (index >= 0) current.splice(index, 1);
    }
    this.emitHosts(current);
  }

  private onRoleChange(serverId: number, role: InstanceHostRole): void {
    if (this.disabled || this.value === null) return;
    this.emitHosts(this.value.map((mapping) => (
      mapping.serverId === serverId ? { ...mapping, role } : mapping
    )));
  }

  private requestRelationReload(): void {
    this.dispatchEvent(new CustomEvent('instance-host-reload', {
      bubbles: true,
      composed: true,
    }));
  }

  private statusVariant(status: string): 'ok' | 'danger' | 'warn' | 'muted' {
    if (status === 'online') return 'ok';
    if (status === 'error') return 'danger';
    if (status === 'unreachable') return 'warn';
    return 'muted';
  }

  private renderContent() {
    if (this.loading) {
      return html`<div class="field-skeleton skeleton" aria-label="关联关系加载中"></div>`;
    }
    if (this.value === null) {
      return html`
        <div class="message message--error" role="alert">
          <span>${this.error || '关联关系状态未知'}</span>
          <button
            class="btn"
            data-action="reload"
            type="button"
            .disabled=${this.disabled}
            @click=${this.requestRelationReload}
          >重新加载</button>
        </div>
      `;
    }
    if (this.serversLoading) {
      return html`<div class="field-skeleton skeleton" aria-label="Linux 主机加载中"></div>`;
    }
    if (this.serversError) {
      return html`
        <div class="message message--error" role="alert">
          <span>${this.serversError}</span>
          <button class="btn" type="button" .disabled=${this.disabled} @click=${this.loadServers}>重试</button>
        </div>
      `;
    }
    if (this.servers.length === 0) {
      return html`
        <app-empty-state
          title="暂无可关联的 Linux 主机"
          description="请先在服务器管理中添加受支持的 Linux 主机"
          icon="server"
        ></app-empty-state>
      `;
    }

    return html`
      <div class="host-options">
        ${this.servers.map((server) => {
          const mapping = this.value?.find((item) => item.serverId === server.id);
          return html`
            <div class="host-option ${mapping ? 'host-option--selected' : ''}">
              <label class="host-select">
                <input
                  type="checkbox"
                  value=${server.id}
                  .checked=${Boolean(mapping)}
                  .disabled=${this.disabled}
                  @change=${(event: Event) => this.onSelectionChange(server.id, (event.target as HTMLInputElement).checked)}
                />
                <span class="host-copy">
                  <span class="host-name">${server.label || server.host}</span>
                  <span class="host-address">${server.host}:${server.port}</span>
                </span>
              </label>
              <div class="host-meta">
                <app-badge variant=${this.statusVariant(server.status)}>${server.status}</app-badge>
                <span class="os-type">${server.os_type}</span>
              </div>
              ${mapping ? html`
                <label class="role-field">
                  <span>节点角色</span>
                  <select
                    data-server-id=${server.id}
                    .value=${mapping.role}
                    .disabled=${this.disabled}
                    @change=${(event: Event) => this.onRoleChange(server.id, (event.target as HTMLSelectElement).value as InstanceHostRole)}
                  >
                    ${HOST_ROLES.map((role) => html`<option value=${role.value}>${role.label}</option>`)}
                  </select>
                </label>
              ` : nothing}
            </div>
          `;
        })}
      </div>
    `;
  }

  override render() {
    return html`
      <style>${sharedBtnStyles.cssText}</style>
      <style>
        :host { display: block; min-width: 0; }
        app-form-field { margin-bottom: 0; }
        .host-options { display: grid; gap: var(--space-sm); }
        .host-option {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: var(--space-sm) var(--space-md);
          align-items: center;
          padding: var(--space-md);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          background: var(--card);
          min-width: 0;
        }
        .host-option--selected { border-color: var(--accent); background: var(--accent-subtle); }
        .host-select { display: flex; align-items: flex-start; gap: var(--space-sm); min-width: 0; cursor: pointer; }
        .host-select input { margin-top: var(--space-xs); flex: 0 0 auto; }
        .host-copy { display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0; }
        .host-name { color: var(--text-strong); font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; }
        .host-address, .os-type { color: var(--muted); font-size: var(--text-xs); overflow-wrap: anywhere; }
        .host-meta { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-sm); flex-wrap: wrap; min-width: 0; }
        .role-field {
          grid-column: 1 / -1;
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 180px);
          align-items: center;
          gap: var(--space-md);
          color: var(--muted);
          font-size: var(--text-xs);
        }
        select {
          box-sizing: border-box;
          width: 100%;
          padding: var(--space-sm) var(--space-md);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text);
          background: var(--card);
          font-size: var(--text-sm);
        }
        select:focus { outline: none; border-color: var(--accent); }
        .message {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-md);
          padding: var(--space-md);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text);
          font-size: var(--text-sm);
          overflow-wrap: anywhere;
        }
        .message--error { border-color: var(--danger); background: var(--danger-subtle); color: var(--danger); }
        .field-skeleton { min-height: 72px; border-radius: var(--radius-sm); }
        .skeleton { background: var(--skeleton, var(--border)); animation: skeleton-pulse 1.5s ease-in-out infinite; }
        @keyframes skeleton-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
        @media (max-width: 600px) {
          .host-option { grid-template-columns: minmax(0, 1fr); }
          .host-meta { justify-content: flex-start; }
          .role-field { grid-template-columns: minmax(0, 1fr); }
          .message { align-items: flex-start; flex-direction: column; }
        }
      </style>
      <app-form-field label="关联 Linux 主机" hint="可多选主机并为每台主机指定数据库节点角色">
        ${this.renderContent()}
      </app-form-field>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'instance-host-field': InstanceHostField;
  }
}
