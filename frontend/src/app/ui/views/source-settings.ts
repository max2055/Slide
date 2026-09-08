import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { permissionMatches } from '../settings-navigation.js';
import '../components/app-form-field.js';
import './source-manifest.js';

interface SourceConfig { baseUrl: string; projectId: string; allowedPaths: string[]; allowModelContent: boolean }
@customElement('source-settings')
export class SourceSettings extends LitElement {
  @state() private config: SourceConfig = { baseUrl: '', projectId: '', allowedPaths: [], allowModelContent: false };
  @state() private token = '';
  @state() private busy = false;
  @state() private loading = true;
  @state() private error = '';
  @state() private message = '';
  @state() private revision = 0;
  @state() private permissions: Set<string> = new Set();
  private readonly permissionsHandler = () => { this.readPermissions(); };
  static styles = [sharedBtnStyles, css`
    :host { display: block; min-width: 0; color: var(--text); }
    h1 { font-size: 22px; color: var(--text-strong); margin: 0 0 var(--space-lg); }
    form, section { padding: var(--space-lg) 0; border-bottom: 1px solid var(--border); }
    input:not([type="checkbox"]), textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: var(--space-sm); font: inherit; color: var(--text); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); }
    textarea { min-height: 100px; resize: vertical; }
    .error { color: var(--danger); } p { overflow-wrap: anywhere; }
    svg { width: 16px; height: 16px; } .skeleton { height: 100px; background: var(--border); opacity: .4; }
  `];
  override connectedCallback() { super.connectedCallback(); this.readPermissions(); window.addEventListener('slide-permissions-loaded', this.permissionsHandler); void this.load(); }
  override disconnectedCallback() { this.token = ''; window.removeEventListener('slide-permissions-loaded', this.permissionsHandler); super.disconnectedCallback(); }
  private readPermissions() {
    try { this.permissions = new Set(JSON.parse(localStorage.getItem('permissions') ?? '[]')); } catch { this.permissions = new Set(); }
  }
  private get editable() { return permissionMatches(this.permissions, 'admin:*'); }
  private async load() {
    this.loading = true; this.error = '';
    try {
      const response = await authFetch('/api/platform/source/config'); const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `SOURCE_CONFIG_UNAVAILABLE (${response.status})`);
      this.config = body.config ?? { baseUrl: '', projectId: '', allowedPaths: [], allowModelContent: false };
    } catch (error) { this.error = String(error); } finally { this.loading = false; }
  }
  private async save(event: Event) {
    event.preventDefault(); if (!this.editable || this.busy) return;
    this.busy = true; this.error = ''; this.message = '';
    try {
      const response = await authFetch('/api/platform/source/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.config) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'SOURCE_SAVE_FAILED');
      this.config = body.config; this.message = '配置已保存';
    } catch (error) { this.error = String(error); } finally { this.busy = false; }
  }
  private async sync() {
    if (!this.editable || this.busy || !this.token) return;
    const token = this.token; this.token = ''; this.busy = true; this.error = ''; this.message = '';
    try {
      const response = await authFetch('/api/platform/source/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'SOURCE_SYNC_FAILED');
      this.revision++; this.message = '源码同步完成';
    } catch (error) { this.error = String(error); } finally { this.busy = false; }
  }
  override render() {
    return html`<h1>部署源码</h1>${this.loading ? html`<div class="skeleton" aria-label="加载源码配置"></div>` : nothing}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p><button class="btn" @click=${this.load}>${icons['refresh-cw']} 重试加载</button>` : nothing}
      ${this.message ? html`<p role="status">${this.message}</p>` : nothing}
      <form @submit=${this.save}>
        <app-form-field label="GitLab URL"><input aria-label="GitLab URL" type="url" .required=${true} .disabled=${!this.editable || this.busy || this.loading} .value=${this.config.baseUrl} @input=${(e: Event) => { this.config = { ...this.config, baseUrl: (e.target as HTMLInputElement).value }; }}></app-form-field>
        <app-form-field label="项目 ID"><input aria-label="项目 ID" .required=${true} .disabled=${!this.editable || this.busy || this.loading} .value=${this.config.projectId} @input=${(e: Event) => { this.config = { ...this.config, projectId: (e.target as HTMLInputElement).value }; }}></app-form-field>
        <app-form-field label="允许的源码路径"><textarea aria-label="允许的源码路径" .disabled=${!this.editable || this.busy || this.loading} .value=${this.config.allowedPaths.join('\n')} @input=${(e: Event) => { this.config = { ...this.config, allowedPaths: (e.target as HTMLTextAreaElement).value.split('\n') }; }}></textarea></app-form-field>
        <app-form-field label="模型内容授权"><input aria-label="允许模型读取源码内容" type="checkbox" .checked=${this.config.allowModelContent} .disabled=${!this.editable || this.busy || this.loading} @change=${(e: Event) => { this.config = { ...this.config, allowModelContent: (e.target as HTMLInputElement).checked }; }}></app-form-field>
        ${this.editable ? html`<button class="btn-primary" type="submit" .disabled=${this.busy || this.loading}>${icons.save} 保存配置</button>` : nothing}
      </form>
      ${this.editable ? html`<section><app-form-field label="单次同步令牌"><input aria-label="单次同步令牌" type="password" autocomplete="off" .disabled=${this.busy || this.loading} .value=${this.token} @input=${(e: Event) => { this.token = (e.target as HTMLInputElement).value; }}></app-form-field><button class="btn" data-action="sync" .disabled=${this.busy || this.loading || !this.token} @click=${this.sync}>${icons['refresh-cw']} 同步源码</button></section>` : nothing}
      <section><source-manifest .revision=${this.revision}></source-manifest></section>`;
  }
}
