import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { showToast } from '../components/app-toast-container.js';
import '../components/app-card.js';
import '../components/app-badge.js';
import '../components/app-form-field.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';

type NotificationType = 'feishu' | 'email';
type EmailAuth = 'password' | 'oauth2';

interface NotificationChannelConfig {
  endpoint?: string;
  hasCredential?: boolean;
  severity?: string;
  smtp_host?: string;
  smtp_port?: number | string;
  smtp_username?: string;
  smtp_auth?: EmailAuth;
  oauth2_tenant?: string;
  oauth2_client_id?: string;
  from?: string;
  to?: string;
  smtp_secure?: boolean;
}

interface NotificationChannel {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  config?: NotificationChannelConfig;
}

function feishuUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'open.feishu.cn' || !url.pathname.startsWith('/open-apis/bot/v2/hook/')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

@customElement('feishu-notification-settings')
export class FeishuNotificationSettings extends LitElement {
  @state() selectedType: NotificationType = 'feishu';
  @state() channelId: number | null = null;
  @state() channels: Partial<Record<NotificationType, NotificationChannel>> = {};

  // Feishu fields are kept public for backwards compatibility with existing settings tests.
  @state() webhookUrl = '';
  @state() secret = '';
  @state() endpoint = '';
  @state() hasStoredCredential = false;

  // Secret inputs are intentionally cleared after load and save.
  @state() emailHost = '';
  @state() emailPort = '587';
  @state() emailUsername = '';
  @state() emailAuth: EmailAuth = 'password';
  @state() emailStoredAuth: EmailAuth | null = null;
  @state() emailPassword = '';
  @state() emailTenant = '';
  @state() emailClientId = '';
  @state() emailRefreshToken = '';
  @state() emailFrom = '';
  @state() emailTo = '';
  @state() emailSecure = false;
  @state() emailHasStoredCredential = false;

  @state() enabled = false;
  @state() loading = true;
  @state() saving = false;
  @state() testing = false;
  @state() error = '';

  static styles = [sharedBtnStyles, css`
    :host { display: block; max-width: 760px; }
    h1 { margin: 0 0 var(--space-xs); color: var(--text-strong); font-size: var(--text-2xl); }
    .intro { margin: 0 0 var(--space-xl); color: var(--muted); font-size: var(--text-base); }
    .field-input {
      box-sizing: border-box; width: 100%; min-width: 0;
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      padding: var(--space-sm) var(--space-md); color: var(--text);
      background: var(--card); font: inherit;
    }
    .field-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
    .channel-tabs {
      display: inline-flex; gap: 2px; padding: 3px; margin-bottom: var(--space-lg);
      border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-elevated);
    }
    .channel-tab {
      border: 0; border-radius: var(--radius-sm); padding: 7px 16px;
      color: var(--muted); background: transparent; font: inherit; font-size: var(--text-sm);
      cursor: pointer;
    }
    .channel-tab:hover { color: var(--text-strong); background: var(--bg-hover); }
    .channel-tab.active { color: var(--text-strong); background: var(--card); box-shadow: 0 1px 3px rgba(0,0,0,.08); font-weight: 600; }
    .status { display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: center; margin-bottom: var(--space-lg); }
    .switch { display: flex; gap: var(--space-sm); align-items: center; color: var(--text); font-size: var(--text-base); cursor: pointer; }
    .switch input { accent-color: var(--accent); }
    .hint { margin: var(--space-xs) 0 0; color: var(--muted); font-size: var(--text-xs); line-height: 1.5; }
    .actions { display: flex; flex-wrap: wrap; gap: var(--space-sm); padding-top: var(--space-md); }
    .error { margin: 0 0 var(--space-md); color: var(--danger); font-size: var(--text-sm); }
    .loading { color: var(--muted); padding: var(--space-xl); }
    .email-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 var(--space-md); }
    .email-grid app-form-field { min-width: 0; }
    .full-width { grid-column: 1 / -1; }
    @media (max-width: 640px) {
      .email-grid { grid-template-columns: minmax(0, 1fr); }
      .full-width { grid-column: auto; }
      .channel-tabs { display: flex; width: 100%; }
      .channel-tab { flex: 1; }
    }
  `];

  override connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  async load() {
    this.loading = true;
    this.error = '';
    try {
      const response = await authFetch('/api/notification/channels');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `加载失败 (${response.status})`);
      const loaded: Partial<Record<NotificationType, NotificationChannel>> = {};
      for (const item of (Array.isArray(body) ? body : []) as NotificationChannel[]) {
        if (item.type === 'feishu' || item.type === 'email') loaded[item.type] = item;
      }
      this.channels = loaded;

      // Keep the current tab when it has a saved channel. On a fresh page with
      // only email configured, selecting email avoids showing an empty Feishu form.
      const preferred: NotificationType = loaded[this.selectedType]
        ? this.selectedType
        : loaded.feishu ? 'feishu' : loaded.email ? 'email' : this.selectedType;
      this.selectType(preferred);
    } catch (error: any) {
      this.error = error.message || '加载通知配置失败';
    } finally {
      this.loading = false;
    }
  }

  selectType(type: NotificationType) {
    this.selectedType = type;
    const channel = this.channels[type];
    this.channelId = channel?.id ?? null;
    this.enabled = channel?.enabled ?? false;

    if (type === 'feishu') {
      this.endpoint = channel?.config?.endpoint || '';
      this.hasStoredCredential = Boolean(channel?.config?.hasCredential);
      // Never hydrate a secret returned by a legacy/non-redacting endpoint.
      this.webhookUrl = '';
      this.secret = '';
      return;
    }

    const config = channel?.config || {};
    this.emailHost = config.smtp_host || '';
    this.emailPort = config.smtp_port === undefined || config.smtp_port === null ? '587' : String(config.smtp_port);
    this.emailUsername = config.smtp_username || '';
    this.emailAuth = config.smtp_auth === 'oauth2' ? 'oauth2' : 'password';
    this.emailStoredAuth = config.smtp_auth === 'oauth2' ? 'oauth2' : config.hasCredential ? 'password' : null;
    this.emailTenant = config.oauth2_tenant || '';
    this.emailClientId = config.oauth2_client_id || '';
    this.emailFrom = config.from || '';
    this.emailTo = config.to || '';
    this.emailSecure = config.smtp_secure === true;
    this.emailHasStoredCredential = Boolean(config.hasCredential);
    this.emailPassword = '';
    this.emailRefreshToken = '';
  }

  async save() {
    if (this.selectedType === 'email') {
      await this.saveEmail();
      return;
    }
    await this.saveFeishu();
  }

  private async saveFeishu() {
    this.error = '';
    const trimmedUrl = this.webhookUrl.trim();
    const trimmedSecret = this.secret.trim();
    const normalizedUrl = trimmedUrl ? feishuUrl(trimmedUrl) : null;
    if (!this.channelId && !normalizedUrl) {
      this.error = '请输入 open.feishu.cn 的 HTTPS Webhook 地址。';
      return;
    }
    if (trimmedUrl && !normalizedUrl) {
      this.error = 'Webhook 必须是 open.feishu.cn 的 HTTPS 飞书机器人地址。';
      return;
    }
    if (!this.channelId && !trimmedSecret) {
      this.error = '创建通道时必须填写飞书签名密钥。';
      return;
    }
    this.saving = true;
    try {
      const config = normalizedUrl ? {
        webhook_url: normalizedUrl,
        ...(trimmedSecret ? { secret: trimmedSecret } : {}),
        severity: 'info',
      } : undefined;
      const request = this.channelId
        ? authFetch(`/api/notification/channels/${this.channelId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '飞书告警', enabled: this.enabled, ...(config ? { config } : {}) }),
        })
        : authFetch('/api/notification/channels', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '飞书告警', type: 'feishu', enabled: this.enabled, config }),
        });
      const response = await request;
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `保存失败 (${response.status})`);
      if (!this.channelId) this.channelId = Number(body.id);
      this.secret = '';
      this.webhookUrl = '';
      this.hasStoredCredential = this.hasStoredCredential || Boolean(trimmedSecret);
      if (normalizedUrl) this.endpoint = new URL(normalizedUrl).origin;
      this.rememberSavedChannel('feishu', '飞书告警');
      showToast('飞书通知配置已保存', 'success');
    } catch (error: any) {
      this.error = error.message || '保存飞书配置失败';
    } finally {
      this.saving = false;
    }
  }

  private async saveEmail() {
    this.error = '';
    const host = this.emailHost.trim();
    const username = this.emailUsername.trim();
    const from = this.emailFrom.trim();
    const to = this.emailTo.trim();
    const password = this.emailPassword.trim();
    const refreshToken = this.emailRefreshToken.trim();
    const port = Number(this.emailPort.trim());

    if (!host) { this.error = '请输入 SMTP 服务器地址。'; return; }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { this.error = 'SMTP 端口必须是 1-65535 的整数。'; return; }
    if (!username) { this.error = '请输入 SMTP 用户名。'; return; }
    if (!from) { this.error = '请输入发件人地址。'; return; }
    if (!to) { this.error = '请输入收件人地址。'; return; }
    if (this.emailAuth === 'password' && (!this.emailHasStoredCredential || this.emailStoredAuth !== 'password') && !password) {
      this.error = '首次保存密码认证时必须填写 SMTP 密码。'; return;
    }
    if (this.emailAuth === 'oauth2' && (!this.emailTenant.trim() || !this.emailClientId.trim())) {
      this.error = 'OAuth2 认证需要填写租户和客户端 ID。'; return;
    }
    if (this.emailAuth === 'oauth2' && (!this.emailHasStoredCredential || this.emailStoredAuth !== 'oauth2') && !refreshToken) {
      this.error = '首次保存 OAuth2 认证时必须填写刷新令牌。'; return;
    }

    this.saving = true;
    try {
      const config: Record<string, unknown> = {
        smtp_host: host,
        smtp_port: port,
        smtp_username: username,
        smtp_auth: this.emailAuth,
        from,
        to,
        smtp_secure: this.emailSecure,
        severity: 'info',
      };
      if (password) config.password = password;
      if (this.emailAuth === 'oauth2') {
        config.oauth2_tenant = this.emailTenant.trim();
        config.oauth2_client_id = this.emailClientId.trim();
        if (refreshToken) config.oauth2_refresh_token = refreshToken;
      }

      const request = this.channelId
        ? authFetch(`/api/notification/channels/${this.channelId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '邮件告警', enabled: this.enabled, config }),
        })
        : authFetch('/api/notification/channels', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '邮件告警', type: 'email', enabled: this.enabled, config }),
        });
      const response = await request;
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `保存失败 (${response.status})`);
      if (!this.channelId) this.channelId = Number(body.id);
      this.emailPassword = '';
      this.emailRefreshToken = '';
      this.emailHasStoredCredential = this.emailHasStoredCredential || Boolean(password || refreshToken);
      this.emailStoredAuth = this.emailAuth;
      this.rememberSavedChannel('email', '邮件告警');
      showToast('邮件通知配置已保存', 'success');
    } catch (error: any) {
      this.error = error.message || '保存邮件配置失败';
    } finally {
      this.saving = false;
    }
  }

  private rememberSavedChannel(type: NotificationType, name: string) {
    const existing = this.channels[type];
    const config: NotificationChannelConfig = type === 'email'
      ? {
        smtp_host: this.emailHost.trim(),
        smtp_port: Number(this.emailPort.trim()),
        smtp_username: this.emailUsername.trim(),
        smtp_auth: this.emailAuth,
        ...(this.emailAuth === 'oauth2' ? {
          oauth2_tenant: this.emailTenant.trim(),
          oauth2_client_id: this.emailClientId.trim(),
        } : {}),
        from: this.emailFrom.trim(),
        to: this.emailTo.trim(),
        smtp_secure: this.emailSecure,
        hasCredential: this.emailHasStoredCredential,
      }
      : {
        endpoint: this.endpoint,
        severity: 'info',
        hasCredential: this.hasStoredCredential,
      };
    this.channels = {
      ...this.channels,
      [type]: {
        id: this.channelId || existing?.id || 0,
        name,
        type,
        enabled: this.enabled,
        config: { ...config, ...(existing?.config?.endpoint && type === 'feishu' ? { endpoint: existing.config.endpoint } : {}) },
      },
    };
  }

  async test() {
    if (!this.channelId) return;
    this.testing = true;
    this.error = '';
    try {
      const response = await authFetch(`/api/notification/channels/${this.channelId}/test`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `测试失败 (${response.status})`);
      showToast(this.selectedType === 'email' ? '测试邮件已发送，请检查收件箱。' : '测试消息已发送，请在飞书群中确认。', 'success');
    } catch (error: any) {
      this.error = error.message || (this.selectedType === 'email' ? '邮件测试发送失败' : '飞书测试发送失败');
    } finally {
      this.testing = false;
    }
  }

  override render() {
    if (this.loading) return html`<div class="loading">加载通知配置…</div>`;
    return html`
      <h1>通知配置</h1>
      <p class="intro">配置告警通知渠道。SMTP 密码、OAuth2 刷新令牌和飞书签名密钥只会通过受保护接口提交，保存后不会回显。</p>
      <div class="channel-tabs" role="tablist" aria-label="通知渠道">
        <button class="channel-tab ${this.selectedType === 'feishu' ? 'active' : ''}" role="tab" aria-selected=${this.selectedType === 'feishu'} @click=${() => this.selectType('feishu')}>飞书</button>
        <button class="channel-tab ${this.selectedType === 'email' ? 'active' : ''}" role="tab" aria-selected=${this.selectedType === 'email'} @click=${() => this.selectType('email')}>邮件</button>
      </div>
      <app-card>
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : ''}
        ${this.selectedType === 'email' ? this.renderEmailForm() : this.renderFeishuForm()}
        <label class="switch"><input type="checkbox" .checked=${this.enabled} @change=${(event: Event) => { this.enabled = (event.target as HTMLInputElement).checked; }}> 启用告警通知</label>
        <p class="hint">建议先保存为禁用状态并点击“发送测试消息”。确认收到后，再启用真实告警通知。</p>
        <div class="actions">
          <button class="btn btn-primary" ?disabled=${this.saving} @click=${this.save}>${this.saving ? '保存中…' : '保存配置'}</button>
          <button class="btn" ?disabled=${!this.channelId || this.testing} @click=${this.test}>${this.testing ? '发送中…' : '发送测试消息'}</button>
        </div>
      </app-card>
    `;
  }

  private renderFeishuForm() {
    return html`
      <div class="status" aria-label="飞书通知配置状态">
        <app-badge variant=${this.endpoint ? 'ok' : 'muted'}>${this.endpoint ? 'Webhook 已配置' : 'Webhook 未配置'}</app-badge>
        <app-badge variant=${this.hasStoredCredential ? 'ok' : 'muted'}>${this.hasStoredCredential ? '签名密钥已配置' : '签名密钥未配置'}</app-badge>
        <app-badge variant=${this.enabled ? 'ok' : 'warn'}>${this.enabled ? '告警通知已启用' : '告警通知未启用'}</app-badge>
      </div>
      <app-form-field label=${this.channelId ? '替换飞书 Webhook' : '飞书 Webhook'} hint="仅接受 open.feishu.cn 的 HTTPS 自定义机器人地址。留空表示保留已保存地址。" .error=${this.error && this.error.includes('Webhook') ? this.error : ''}>
        <input class="field-input" type="url" autocomplete="off" placeholder=${this.endpoint ? '已保存，留空不变' : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'} .value=${this.webhookUrl} @input=${(event: Event) => { this.webhookUrl = (event.target as HTMLInputElement).value; }}>
      </app-form-field>
      <app-form-field label=${this.channelId ? '更新签名密钥' : '签名密钥'} hint="启用飞书机器人签名校验时填写。保存后该密钥会被加密且无法在页面中查看；留空表示保留已保存密钥。" .error=${this.error && this.error.includes('签名密钥') ? this.error : ''}>
        <input class="field-input" type="password" autocomplete="new-password" placeholder=${this.hasStoredCredential ? '已安全保存，留空不变' : '飞书机器人签名密钥'} .value=${this.secret} @input=${(event: Event) => { this.secret = (event.target as HTMLInputElement).value; }}>
      </app-form-field>
    `;
  }

  private renderEmailForm() {
    const emailError = (terms: string[]) => this.error && terms.some((term) => this.error.includes(term)) ? this.error : '';
    return html`
      <div class="status" aria-label="邮件通知配置状态">
        <app-badge variant=${this.emailHost ? 'ok' : 'muted'}>${this.emailHost ? 'SMTP 已配置' : 'SMTP 未配置'}</app-badge>
        <app-badge variant=${this.emailHasStoredCredential ? 'ok' : 'muted'}>${this.emailHasStoredCredential ? '邮件凭据已配置' : '邮件凭据未配置'}</app-badge>
        <app-badge variant=${this.enabled ? 'ok' : 'warn'}>${this.enabled ? '告警通知已启用' : '告警通知未启用'}</app-badge>
      </div>
      <div class="email-grid">
        <app-form-field label="SMTP 服务器" required .error=${emailError(['SMTP 服务器'])}>
          <input class="field-input" type="text" autocomplete="off" placeholder="smtp.example.com" .value=${this.emailHost} @input=${(event: Event) => { this.emailHost = (event.target as HTMLInputElement).value; }}>
        </app-form-field>
        <app-form-field label="SMTP 端口" required .error=${emailError(['SMTP 端口'])}>
          <input class="field-input" type="number" min="1" max="65535" step="1" inputmode="numeric" .value=${this.emailPort} @input=${(event: Event) => { this.emailPort = (event.target as HTMLInputElement).value; }}>
        </app-form-field>
        <app-form-field label="SMTP 用户名" required .error=${emailError(['SMTP 用户名'])}>
          <input class="field-input" type="text" autocomplete="username" placeholder="alerts@example.com" .value=${this.emailUsername} @input=${(event: Event) => { this.emailUsername = (event.target as HTMLInputElement).value; }}>
        </app-form-field>
        <app-form-field label="认证方式">
          <select class="field-input" .value=${this.emailAuth} @change=${(event: Event) => { this.emailAuth = (event.target as HTMLSelectElement).value === 'oauth2' ? 'oauth2' : 'password'; }}>
            <option value="password">SMTP 密码</option>
            <option value="oauth2">OAuth2</option>
          </select>
        </app-form-field>
        ${this.emailAuth === 'password' ? html`
          <app-form-field class="full-width" label=${this.emailHasStoredCredential ? '更新 SMTP 密码' : 'SMTP 密码'} hint="密码会被加密保存，页面不会回显；留空表示保留已保存密码。" .error=${emailError(['SMTP 密码', '密码认证'])}>
            <input class="field-input" type="password" autocomplete="new-password" placeholder=${this.emailHasStoredCredential ? '已安全保存，留空不变' : 'SMTP 密码或应用专用密码'} .value=${this.emailPassword} @input=${(event: Event) => { this.emailPassword = (event.target as HTMLInputElement).value; }}>
          </app-form-field>
        ` : html`
          <app-form-field label="OAuth2 租户" required .error=${emailError(['OAuth2'])}>
            <input class="field-input" type="text" autocomplete="off" placeholder="consumers 或租户 ID" .value=${this.emailTenant} @input=${(event: Event) => { this.emailTenant = (event.target as HTMLInputElement).value; }}>
          </app-form-field>
          <app-form-field label="OAuth2 客户端 ID" required .error=${emailError(['OAuth2'])}>
            <input class="field-input" type="text" autocomplete="off" .value=${this.emailClientId} @input=${(event: Event) => { this.emailClientId = (event.target as HTMLInputElement).value; }}>
          </app-form-field>
          <app-form-field class="full-width" label=${this.emailHasStoredCredential ? '更新 OAuth2 刷新令牌' : 'OAuth2 刷新令牌'} hint="令牌会被加密保存，页面不会回显；留空表示保留已保存令牌。" .error=${emailError(['刷新令牌'])}>
            <input class="field-input" type="password" autocomplete="new-password" placeholder=${this.emailHasStoredCredential ? '已安全保存，留空不变' : 'OAuth2 refresh token'} .value=${this.emailRefreshToken} @input=${(event: Event) => { this.emailRefreshToken = (event.target as HTMLInputElement).value; }}>
          </app-form-field>
        `}
        <app-form-field label="发件人" required .error=${emailError(['发件人'])}>
          <input class="field-input" type="email" autocomplete="email" placeholder="alerts@example.com" .value=${this.emailFrom} @input=${(event: Event) => { this.emailFrom = (event.target as HTMLInputElement).value; }}>
        </app-form-field>
        <app-form-field label="收件人" required hint="多个收件人可用逗号分隔。" .error=${emailError(['收件人'])}>
          <input class="field-input" type="text" autocomplete="off" placeholder="dba@example.com" .value=${this.emailTo} @input=${(event: Event) => { this.emailTo = (event.target as HTMLInputElement).value; }}>
        </app-form-field>
        <label class="switch full-width"><input type="checkbox" .checked=${this.emailSecure} @change=${(event: Event) => { this.emailSecure = (event.target as HTMLInputElement).checked; }}> 使用 SMTP SSL/TLS（465 端口通常启用）</label>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'feishu-notification-settings': FeishuNotificationSettings; }
}
