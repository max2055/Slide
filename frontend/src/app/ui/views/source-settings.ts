import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { permissionMatches } from '../settings-navigation.js';
import '../components/app-form-field.js';
import './source-manifest.js';

interface SourceConfig { provider?: 'gitlab' | 'github'; baseUrl: string; repositoryPath: string; ref?: string; allowedPaths: string[]; allowModelContent: boolean; gitUsername?: string; httpProxy?: string; httpsProxy?: string; allProxy?: string }
@customElement('source-settings')
export class SourceSettings extends LitElement {
  @state() private config: SourceConfig = { provider: 'gitlab', baseUrl: '', repositoryPath: '', allowedPaths: [], allowModelContent: false };
  @state() private token = '';
  @state() private retainToken = false;
  @state() private credential: { identity: string; hasSavedToken: boolean; hasStoredToken?: boolean; error?: string } = { identity: '', hasSavedToken: false };
  @state() private savedConfig = '';
  private get configChanged() { return JSON.stringify(this.config) !== this.savedConfig; }
  @state() private busy = false;
  @state() private loading = true;
  @state() private error = '';
  @state() private message = '';
  @state() private syncStatus = '';
  @state() private revision = 0;
  @state() private permissions: Set<string> = new Set();
  private readonly permissionsHandler = () => { this.readPermissions(); };
  static styles = [sharedFieldStyles, sharedBtnStyles, css`
    :host { display: block; min-width: 0; color: var(--text); }
    h1 { font-size: 22px; color: var(--text-strong); margin: 0 0 var(--space-lg); }
    h2 { font-size: 16px; color: var(--text-strong); margin: 0 0 var(--space-lg); }
    form, .sync-section { margin: 0; padding: var(--space-lg) 0 var(--space-xl); border-bottom: 1px solid var(--border); }
    input:not([type="checkbox"]), textarea, select { box-sizing: border-box; width: 100%; min-width: 0; padding: var(--space-sm); font: inherit; color: var(--text); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); }
    input:not([type="checkbox"]), select { min-height: 40px; }
    textarea { min-height: 100px; resize: vertical; }
    .error { color: var(--danger); } p { overflow-wrap: anywhere; }
    .permission-control { display:flex; align-items:center; gap:var(--space-sm); min-height:40px; cursor:pointer; }
    .permission-control input { width:18px; height:18px; flex:0 0 auto; }
    svg { width: 16px; height: 16px; } .skeleton { height: 100px; background: var(--border); opacity: .4; }
    .action-row { display:grid; grid-template-columns:minmax(120px, 180px) minmax(0, 1fr); column-gap:var(--space-lg); margin-top:var(--space-md); }
    .action-content { grid-column:2; display:flex; align-items:center; gap:var(--space-sm); flex-wrap:wrap; }
    .action-content .btn, .action-content .btn-primary { min-height:40px; }
    .sync-status { color: var(--muted); font-size: var(--text-sm); margin: var(--space-sm) 0 0; }
    source-manifest { margin-top:var(--space-xl); }
    @media (max-width: 720px) {
      .action-row { grid-template-columns:1fr; }
      .action-content { grid-column:1; }
    }
  `];
  override connectedCallback() { super.connectedCallback(); this.readPermissions(); window.addEventListener('slide-permissions-loaded', this.permissionsHandler); void this.load(); }
  override disconnectedCallback() { this.token = ''; this.retainToken = false; window.removeEventListener('slide-permissions-loaded', this.permissionsHandler); super.disconnectedCallback(); }
  private readPermissions() {
    try { this.permissions = new Set(JSON.parse(localStorage.getItem('permissions') ?? '[]')); } catch { this.permissions = new Set(); }
  }
  private credentialError(code: string) {
    return ({ SOURCE_CREDENTIAL_INVALID: '令牌无效、已过期或缺少仓库读取权限，请输入有效令牌后重试；勾选保留可替换已保存值。', SOURCE_SAVED_CREDENTIAL_UNAVAILABLE: '已保存令牌无法解密，请重新输入并替换，或删除后重试。', SOURCE_CREDENTIAL_ENCRYPTION_UNAVAILABLE: '服务端加密配置不可用，请联系管理员检查加密密钥后重试。', SOURCE_CONFIG_CHANGED: '仓库配置已发生变化，请重新加载配置后再操作。', SOURCE_REPOSITORY_NOT_FOUND: '仓库不存在或令牌无权读取，请检查仓库路径与令牌权限。' } as Record<string, string>)[code] ?? code;
  }
  private get editable() { return permissionMatches(this.permissions, 'admin:*'); }
  private async load() {
    this.loading = true; this.error = '';
    try {
      const response = await authFetch('/api/platform/source/config'); const text = await response.text(); let body: any = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
      if (!response.ok) throw new Error((body.error === 'SOURCE_REPOSITORY_PATH_REQUIRED' ? '旧 GitLab 数字 ID 已失效，请重新填写平台地址和仓库路径并保存。' : body.error) ?? `SOURCE_CONFIG_UNAVAILABLE (${response.status})`);
      this.config = body.config ?? { provider: 'gitlab', baseUrl: '', repositoryPath: '', allowedPaths: [], allowModelContent: false };
      this.savedConfig = JSON.stringify(this.config);
      this.credential = body.credential ?? { identity: '', hasSavedToken: false };
    } catch (error) { this.error = String(error); } finally { this.loading = false; }
  }
  private async save(event: Event) {
    event.preventDefault(); if (!this.editable || this.busy) return;
    this.busy = true; this.error = ''; this.message = '';
    try {
      const allowedPaths = [...new Set(this.config.allowedPaths.map(path => path.trim()).filter(Boolean))];
      if (allowedPaths.some(path => !/^[A-Za-z0-9_/-]+\/$/.test(path))) throw new Error('源码路径必须每行一个目录，并以 / 结尾');
      const response = await authFetch('/api/platform/source/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...this.config, provider: this.config.provider ?? 'gitlab', allowedPaths }) });
      const text = await response.text(); let body: any = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; } if (!response.ok) throw new Error(body.error ?? `SOURCE_SAVE_FAILED (${response.status})`);
      this.config = body.config; this.savedConfig = JSON.stringify(this.config);
      await this.refreshCredential(); this.revision++; this.message = '配置已保存';
    } catch (error) { this.error = String(error); } finally { this.busy = false; }
  }
  private async refreshCredential() {
    const response = await authFetch('/api/platform/source/config');
    const body = JSON.parse(await response.text());
    if (!response.ok) throw new Error(this.credentialError(body.error));
    if (JSON.stringify(body.config) !== this.savedConfig) throw new Error(this.credentialError('SOURCE_CONFIG_CHANGED'));
    this.credential = body.credential ?? { identity: '', hasSavedToken: false };
  }
  private async manageCredential(remove = false) {
    if (!this.editable || this.busy || this.configChanged || (!remove && !this.token)) return;
    const token = this.token; this.token = ''; this.busy = true; this.error = ''; this.message = '';
    try {
      const response = await authFetch('/api/platform/source/credential', { method: remove ? 'DELETE' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: remove ? '' : token, expectedIdentity: this.credential.identity || undefined }) });
      const body = JSON.parse(await response.text());
      if (!response.ok) throw new Error(this.credentialError(body.error));
      this.credential = body; this.message = remove ? '已保存令牌已删除' : '同步令牌已加密保存';
    } catch (error) { this.error = String(error); } finally { this.busy = false; }
  }
  private async sync() {
    if (!this.editable || this.busy || this.configChanged || (!this.token && !this.credential.hasSavedToken)) return;
    const token = this.token; this.token = ''; this.busy = true; this.error = ''; this.message = '';
    this.syncStatus = '正在连接代码托管平台并同步源码，可能需要几分钟…';
    try {
      const response = await authFetch('/api/platform/source/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...(this.retainToken && token ? { retainToken: true } : {}), ...(this.credential.identity ? { expectedIdentity: this.credential.identity } : {}) }) });
      const text = await response.text(); let body: any = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; } if (!response.ok) throw new Error(this.credentialError(body.error ?? `SOURCE_SYNC_FAILED (${response.status})`));
      await this.refreshCredential(); this.revision++; this.message = body.completeness === 'partial' ? `部分同步完成，已跳过 ${body.skippedFiles?.length ?? 0} 个文件或目录，详见快照清单。` : '源码同步完成'; this.syncStatus = '';
    } catch (error) { this.error = String(error); this.syncStatus = ''; } finally { this.busy = false; }
  }
  override render() {
    return html`<h1>源码仓库</h1>${this.loading ? html`<div class="skeleton" aria-label="加载源码配置"></div>` : nothing}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p><button class="btn" @click=${this.load}>${icons['refresh-cw']} 重试加载</button>` : nothing}
      ${this.message ? html`<p role="status">${this.message}</p>` : nothing}
      <form @submit=${this.save}>
        <h2>代码仓库配置</h2>
        <app-form-field label="代码托管平台" hint="只读同步指定分支或提交；无需预先绑定部署版本。" .inline=${true}><select aria-label="代码托管平台" .value=${this.config.provider ?? 'gitlab'} .disabled=${!this.editable || this.busy || this.loading} @change=${(e: Event) => { this.config = { ...this.config, provider: (e.target as HTMLSelectElement).value as 'gitlab'|'github', baseUrl: (e.target as HTMLSelectElement).value === 'github' ? 'https://github.com' : '' }; }}><option value="gitlab">GitLab</option><option value="github">GitHub</option></select></app-form-field>
        <app-form-field label="${this.config.provider === 'github' ? 'GitHub URL' : 'GitLab URL'}" hint="填写实例根地址，不要填写项目路径、查询参数或令牌。" .inline=${true}><input aria-label="${this.config.provider === 'github' ? 'GitHub URL' : 'GitLab URL'}" title="平台实例根地址" placeholder=${this.config.provider === 'github' ? 'https://github.com' : 'https://gitlab.example.com'} type="url" .required=${true} .disabled=${!this.editable || this.busy || this.loading} .value=${this.config.baseUrl} @input=${(e: Event) => { this.config = { ...this.config, baseUrl: (e.target as HTMLInputElement).value }; }}></app-form-field>
        ${(['httpProxy', 'httpsProxy', 'allProxy'] as const).map(key => html`<app-form-field label="${key === 'httpProxy' ? 'HTTP 代理' : key === 'httpsProxy' ? 'HTTPS 代理' : 'ALL 代理'}" .inline=${true}><input aria-label="${key}" placeholder="例如 http://127.0.0.1:7890" .value=${this.config[key] ?? ''} .disabled=${!this.editable || this.busy || this.loading} @input=${(e: Event) => { this.config = { ...this.config, [key]: (e.target as HTMLInputElement).value }; }}></app-form-field>`)}
        ${this.config.baseUrl.startsWith('http://') ? html`<p role="note">此仓库使用 HTTP，令牌与源码在内网明文传输。请使用只读访问令牌。</p>` : nothing}
        <app-form-field label="仓库路径" .hint=${this.config.provider === 'github' ? '填写 owner/repository，例如 openai/example。' : '填写 group/project 或 group/subgroup/project，不要填写数字 ID 或 .git 后缀。'} .inline=${true}><input aria-label="仓库路径" placeholder="例如 group/project" .required=${true} .disabled=${!this.editable || this.busy || this.loading} .value=${this.config.repositoryPath} @input=${(e: Event) => { this.config = { ...this.config, repositoryPath: (e.target as HTMLInputElement).value }; }}></app-form-field>
        <app-form-field label="分支、标签或 Commit" hint="留空同步仓库默认分支；完整 Commit 需在服务器上可获取。" .inline=${true}><input aria-label="分支、标签或 Commit" placeholder="例如 main 或 refs/heads/release" .value=${this.config.ref ?? ''} .disabled=${!this.editable || this.busy || this.loading} @input=${(e: Event) => { this.config = { ...this.config, ref: (e.target as HTMLInputElement).value.trim() }; }}></app-form-field>
        ${this.config.provider !== 'github' ? html`<app-form-field label="Git 用户名" hint="PAT 留空使用 oauth2；Deploy Token 请填写其用户名。" .inline=${true}><input aria-label="Git 用户名" .value=${this.config.gitUsername ?? ''} .disabled=${!this.editable || this.busy || this.loading} @input=${(e: Event) => { this.config = { ...this.config, gitUsername: (e.target as HTMLInputElement).value || undefined }; }}></app-form-field>` : nothing}
        <app-form-field label="允许的源码路径" hint="留空同步全部源码。疑似敏感内容仅提示并保留；较大文件按片段读取，快照总容量上限为 32MiB。" .inline=${true}><textarea aria-label="允许的源码路径" title="每行一个目录前缀，并以 / 结尾" placeholder="每行一个目录，例如：&#10;apps/db-ops-api/src/&#10;frontend/src/" .disabled=${!this.editable || this.busy || this.loading} .value=${this.config.allowedPaths.join('\n')} @input=${(e: Event) => { this.config = { ...this.config, allowedPaths: (e.target as HTMLTextAreaElement).value.split('\n') }; }}></textarea></app-form-field>
        <app-form-field label="模型读取" hint="开启后，Agent 可读取允许目录内的已同步源码片段，包括带敏感内容提示的原文；Git 访问令牌不会提供给模型。" .inline=${true}><label class="permission-control" for="allow-model-content"><input aria-label="允许模型读取源码内容" id="allow-model-content" type="checkbox" .checked=${this.config.allowModelContent} .disabled=${!this.editable || this.busy || this.loading} @change=${(e: Event) => { this.config = { ...this.config, allowModelContent: (e.target as HTMLInputElement).checked }; }}><strong>允许模型读取源码内容</strong></label></app-form-field>
        ${this.editable ? html`<div class="action-row"><div class="action-content"><button class="btn-primary" type="submit" .disabled=${this.busy || this.loading}>${icons.save} 保存配置</button></div></div>` : nothing}
      </form>
      ${this.editable ? html`<section class="sync-section">
        <h2>同步源码</h2>
        <app-form-field label="同步令牌" hint="留空沿用当前仓库已保存的令牌；输入新值仅覆盖本次，勾选保留或点击保存才会替换。令牌不会发送给 Agent。" .inline=${true}><input aria-label="同步令牌" title="提交后立即清空输入" placeholder=${this.credential.hasSavedToken ? "已保存令牌，留空沿用" : "请输入访问令牌"} type="password" autocomplete="off" .disabled=${this.busy || this.loading} .value=${this.token} @input=${(e: Event) => { this.token = (e.target as HTMLInputElement).value; }}></app-form-field>
        <app-form-field label="保留令牌" .inline=${true}><label class="permission-control"><input aria-label="保留同步令牌" type="checkbox" .checked=${this.retainToken} .disabled=${this.busy || this.loading} @change=${(e: Event) => { this.retainToken = (e.target as HTMLInputElement).checked; }}>保留同步令牌（同步成功后加密保存）</label></app-form-field>
        <div class="action-row"><div class="action-content"><span role="status">${this.configChanged ? '配置已修改，请先保存配置再操作令牌或同步' : this.credential.error ? this.credentialError(this.credential.error) : this.credential.hasSavedToken ? '当前仓库已保存令牌' : this.credential.hasStoredToken ? '其他仓库已保存令牌，当前仓库不会使用；可删除或输入新令牌替换' : '当前仓库未保存令牌'}</span></div></div>
        <div class="action-row"><div class="action-content"><button type="button" class="btn" data-action="save-token" .disabled=${this.busy || this.loading || this.configChanged || !this.token} @click=${() => this.manageCredential()}>${this.credential.hasSavedToken ? '替换已保存令牌' : '保存令牌'}</button><button type="button" class="btn-ghost" data-action="delete-token" .disabled=${this.busy || this.loading || this.configChanged || !(this.credential.hasStoredToken ?? this.credential.hasSavedToken)} @click=${() => this.manageCredential(true)}>删除已保存令牌</button></div></div>
        <div class="action-row"><div class="action-content"><button type="button" class="btn" data-action="sync" .disabled=${this.busy || this.loading || this.configChanged || (!this.token && !this.credential.hasSavedToken)} @click=${(e: Event) => { e.preventDefault(); void this.sync(); }}>${this.busy ? icons['loader'] : icons['refresh-cw']} ${this.busy ? '同步中…' : '同步源码'}</button>${!this.token && !this.credential.hasSavedToken && !this.busy ? html`<span class="sync-status">请输入令牌后开始同步</span>` : nothing}</div></div>
        ${this.syncStatus ? html`<div class="action-row"><p class="action-content sync-status" role="status" aria-live="polite">${this.syncStatus}</p></div>` : nothing}
      </section>` : nothing}
      <source-manifest .revision=${this.revision}></source-manifest>`;
  }
}
