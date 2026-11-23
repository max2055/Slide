import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.ts';
import { permissionMatches } from '../settings-navigation.ts';
import '../components/app-empty-state.ts';

@customElement('legacy-runtime-logs')
export class LegacyRuntimeLogs extends LitElement {
  @property() basePath = '';
  @state() private access: 'loading' | 'allowed' | 'denied' | 'unavailable' = 'loading';
  private readGeneration = 0;

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    void this.readAccess();
  }

  override disconnectedCallback() {
    this.readGeneration++;
    super.disconnectedCallback();
  }

  private async readAccess() {
    this.access = 'loading';
    const generation = ++this.readGeneration;
    const session = apiClient.getSessionContext();
    const isCurrent = () => generation === this.readGeneration && session === apiClient.getSessionContext();
    try {
      const permissions = await apiClient.get<unknown>('/auth/permissions');
      if (!isCurrent()) return;
      if (!Array.isArray(permissions) || !permissions.every(permission => typeof permission === 'string')) {
        this.access = 'unavailable';
        return;
      }
      this.access = permissionMatches(new Set(permissions), 'config:view') ? 'allowed' : 'denied';
    } catch {
      if (isCurrent()) this.access = 'unavailable';
    }
  }

  override render() {
    return html`<section data-legacy-route aria-label="旧运行日志入口">
      <app-empty-state title="暂不支持运行日志" icon="info"
        description="当前未提供原始运行日志流。平台状态中的「平台观测」汇总服务信号和事件，数据库实例日志请在对应实例中查看。"
      ></app-empty-state>
      <div class="empty-state-actions">
        ${this.access === 'allowed'
          ? html`<a class="btn" href=${`${this.basePath}/health?view=observations`}>打开平台观测</a>`
          : this.access === 'unavailable'
            ? html`<span class="muted" role="status">暂时无法确认平台观测权限。</span>
                <button type="button" class="btn btn-refresh" @click=${this.readAccess}>重试</button>`
            : html`<span class="muted" role="status">${this.access === 'loading'
                ? '正在确认平台观测权限…'
                : '查看平台观测需要相应权限，请联系管理员。'}</span>`}
      </div>
    </section>`;
  }
}
