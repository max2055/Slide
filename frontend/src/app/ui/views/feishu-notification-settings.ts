import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { showToast } from '../components/app-toast-container.js';
import '../components/app-card.js';
import '../components/app-badge.js';
import '../components/app-form-field.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';

interface NotificationChannel {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  config?: { endpoint?: string; hasCredential?: boolean; severity?: string };
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
  @state() channelId: number | null = null;
  @state() webhookUrl = '';
  @state() secret = '';
  @state() enabled = false;
  @state() hasStoredCredential = false;
  @state() endpoint = '';
  @state() loading = true;
  @state() saving = false;
  @state() testing = false;
  @state() error = '';

  static styles = [sharedBtnStyles, css`
    :host { display: block; max-width: 760px; }
    h1 { margin: 0 0 var(--space-xs); color: var(--text-strong); font-size: var(--text-2xl); }
    .intro { margin: 0 0 var(--space-xl); color: var(--muted); font-size: var(--text-base); }
    .field-input { box-sizing: border-box; width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-sm) var(--space-md); color: var(--text); background: var(--card); font: inherit; }
    .field-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
    .status { display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: center; margin-bottom: var(--space-lg); }
    .switch { display: flex; gap: var(--space-sm); align-items: center; color: var(--text); font-size: var(--text-base); cursor: pointer; }
    .hint { margin: var(--space-xs) 0 0; color: var(--muted); font-size: var(--text-xs); line-height: 1.5; }
    .actions { display: flex; flex-wrap: wrap; gap: var(--space-sm); padding-top: var(--space-md); }
    .error { margin: 0 0 var(--space-md); color: var(--danger); font-size: var(--text-sm); }
    .loading { color: var(--muted); padding: var(--space-xl); }
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
      const channel = (Array.isArray(body) ? body : []).find((item: NotificationChannel) => item.type === 'feishu') as NotificationChannel | undefined;
      if (channel) {
        this.channelId = channel.id;
        this.enabled = channel.enabled;
        this.endpoint = channel.config?.endpoint || '';
        this.hasStoredCredential = Boolean(channel.config?.hasCredential);
      }
    } catch (error: any) {
      this.error = error.message || '加载飞书配置失败';
    } finally {
      this.loading = false;
    }
  }

  async save() {
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
      showToast('飞书通知配置已保存', 'success');
    } catch (error: any) {
      this.error = error.message || '保存飞书配置失败';
    } finally {
      this.saving = false;
    }
  }

  async test() {
    if (!this.channelId) return;
    this.testing = true;
    this.error = '';
    try {
      const response = await authFetch(`/api/notification/channels/${this.channelId}/test`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `测试失败 (${response.status})`);
      showToast('测试消息已发送，请在飞书群中确认。', 'success');
    } catch (error: any) {
      this.error = error.message || '飞书测试发送失败';
    } finally {
      this.testing = false;
    }
  }

  override render() {
    if (this.loading) return html`<div class="loading">加载飞书通知配置…</div>`;
    return html`
      <h1>飞书通知</h1>
      <p class="intro">配置告警机器人。Webhook 与签名密钥只会通过受保护接口提交，保存后不会回显。</p>
      <app-card>
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : ''}
        <div class="status" aria-label="飞书通知配置状态">
          <app-badge variant=${this.endpoint ? 'ok' : 'muted'}>
            ${this.endpoint ? 'Webhook 已配置' : 'Webhook 未配置'}
          </app-badge>
          <app-badge variant=${this.hasStoredCredential ? 'ok' : 'muted'}>
            ${this.hasStoredCredential ? '签名密钥已配置' : '签名密钥未配置'}
          </app-badge>
          <app-badge variant=${this.enabled ? 'ok' : 'warn'}>
            ${this.enabled ? '告警通知已启用' : '告警通知未启用'}
          </app-badge>
        </div>
        <app-form-field label=${this.channelId ? '替换飞书 Webhook' : '飞书 Webhook'} hint="仅接受 open.feishu.cn 的 HTTPS 自定义机器人地址。留空表示保留已保存地址。" .error=${this.error && this.error.includes('Webhook') ? this.error : ''}>
          <input class="field-input" type="url" autocomplete="off" placeholder=${this.endpoint ? '已保存，留空不变' : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'} .value=${this.webhookUrl} @input=${(event: Event) => { this.webhookUrl = (event.target as HTMLInputElement).value; }}>
        </app-form-field>
        <app-form-field label=${this.channelId ? '更新签名密钥' : '签名密钥'} hint="启用飞书机器人签名校验时填写。保存后该密钥会被加密且无法在页面中查看；留空表示保留已保存密钥。" .error=${this.error && this.error.includes('签名密钥') ? this.error : ''}>
          <input class="field-input" type="password" autocomplete="new-password" placeholder=${this.hasStoredCredential ? '已安全保存，留空不变' : '飞书机器人签名密钥'} .value=${this.secret} @input=${(event: Event) => { this.secret = (event.target as HTMLInputElement).value; }}>
        </app-form-field>
        <label class="switch"><input type="checkbox" .checked=${this.enabled} @change=${(event: Event) => { this.enabled = (event.target as HTMLInputElement).checked; }}> 启用告警通知</label>
        <p class="hint">建议先保存为禁用状态并点击“发送测试消息”。确认群内收到后，再启用真实告警通知。</p>
        <div class="actions">
          <button class="btn btn-primary" ?disabled=${this.saving} @click=${this.save}>${this.saving ? '保存中…' : '保存配置'}</button>
          <button class="btn" ?disabled=${!this.channelId || this.testing} @click=${this.test}>${this.testing ? '发送中…' : '发送测试消息'}</button>
        </div>
      </app-card>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'feishu-notification-settings': FeishuNotificationSettings; }
}
