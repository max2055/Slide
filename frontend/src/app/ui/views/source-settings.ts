import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { permissionMatches } from '../settings-navigation.js';
import '../components/app-form-field.js';
import './source-manifest.js';

interface SourceConfig { provider?: 'gitlab' | 'github'; baseUrl: string; projectId: string; allowedPaths: string[]; allowModelContent: boolean }
@customElement('source-settings')
export class SourceSettings extends LitElement {
  @state() private config: SourceConfig = { provider: 'gitlab', baseUrl: '', projectId: '', allowedPaths: [], allowModelContent: false };
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
    .error { color: var(--danger); } p { overflow-wrap: anywhere; } .hint { color: var(--muted); font-size: 12px; margin: calc(var(--space-xs) * -1) 0 var(--space-md); }
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
      this.config = body.config ?? { provider: 'gitlab', baseUrl: '', projectId: '', allowedPaths: [], allowModelContent: false };
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
        <app-form-field label="代码托管平台"><select aria-label="代码托管平台" .value=${this.config.provider ?? 'gitlab'} .disabled=${!this.editable || this.busy || this.loading} @change=${(e: Event) => { this.config = { ...this.config, provider: (e.target as HTMLSelectElement).value as 'gitlab'|'github', baseUrl: (e.target as HTMLSelectElement).value === 'github' ? 'https://github.com' : '' }; }}><option value="gitlab">GitLab</option><option value="github">GitHub</option></select></app-form-field>
        <p class="hint">选择源码所在的代码托管平台。同步只读取部署提交，不会写入仓库。</p>
        <app-form-field label="${this.config.provider === 'github' ? 'GitHub URL' : 'GitLab URL'}"><input aria-label="${this.config.provider === 'github' ? 'GitHub URL' : 'GitLab URL'}" title="平台实例根地址" placeholder=${this.config.provider === 'github' ? 'https://github.com' : 'https://gitlab.example.com'} type="url" .required=${true} .disabled=${!this.editable || this.busy || this.loading} .value=${this.config.baseUrl} @input=${(e: Event) => { this.config = { ...this.config, baseUrl: (e.target as HTMLInputElement).value }; }}></app-form-field>
        <p class="hint">填写实例根地址，不要填写项目路径、查询参数或令牌。</p>
        <app-form-field label="项目 ID"><input aria-label="项目 ID" title="项目数字 ID，不是项目名称" placeholder="例如 123" .required=${true} .disabled=${!this.editable || this.busy || this.loading} .value=${this.config.projectId} @input=${(e: Event) => { this.config = { ...this.config, projectId: (e.target as HTMLInputElement).value }; }}></app-form-field>
        <p class="hint">${this.config.provider === 'github' ? '填写 owner/repository，例如 openai/example。' : '填写项目的数字 ID，可在项目首页或设置中查看。'}</p>
        <app-form-field label="允许的源码路径"><textarea aria-label="允许的源码路径" title="每行一个目录前缀，并以 / 结尾" placeholder="每行一个目录，例如：&#10;apps/db-ops-api/src/&#10;frontend/src/" .disabled=${!this.editable || this.busy || this.loading} .value=${this.config.allowedPaths.join('\n')} @input=${(e: Event) => { this.config = { ...this.config, allowedPaths: (e.target as HTMLTextAreaElement).value.split('\n') }; }}></textarea></app-form-field>
        <p class="hint">只同步这些目录；建议填写 Agent 分析所需的最小范围。</p>
        <app-form-field label="模型内容授权"><input aria-label="允许模型读取源码内容" type="checkbox" .checked=${this.config.allowModelContent} .disabled=${!this.editable || this.busy || this.loading} @change=${(e: Event) => { this.config = { ...this.config, allowModelContent: (e.target as HTMLInputElement).checked }; }}></app-form-field>
        ${this.editable ? html`<button class="btn-primary" type="submit" .disabled=${this.busy || this.loading}>${icons.save} 保存配置</button>` : nothing}
      </form>
      ${this.editable ? html`<section><app-form-field label="单次同步令牌"><input aria-label="单次同步令牌" title="仅本次同步使用，提交后立即清除" placeholder="粘贴后立即同步" type="password" autocomplete="off" .disabled=${this.busy || this.loading} .value=${this.token} @input=${(e: Event) => { this.token = (e.target as HTMLInputElement).value; }}></app-form-field><p class="hint">令牌不会保存，也不会发送给 Agent。</p><button class="btn" data-action="sync" .disabled=${this.busy || this.loading || !this.token} @click=${this.sync}>${icons['refresh-cw']} 同步源码</button></section>` : nothing}
      <section><source-manifest .revision=${this.revision}></source-manifest></section>`;
  }
}
