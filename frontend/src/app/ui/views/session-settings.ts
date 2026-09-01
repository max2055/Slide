import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { showToast } from '../components/app-toast-container.js';
import '../components/app-card.js';
import '../components/app-form-field.js';

interface SessionConfig {
  idleTimeoutMinutes: number;
  minIdleTimeoutMinutes: number;
  maxIdleTimeoutMinutes: number;
}

@customElement('session-settings-page')
export class SessionSettingsPage extends LitElement {
  @state() private config: SessionConfig | null = null;
  @state() private idleTimeoutMinutes = '';
  @state() private loading = true;
  @state() private saving = false;
  @state() private fieldError = '';

  static styles = [sharedBtnStyles, css`
    :host { display: block; width: min(100%, 48rem); color: var(--text); }
    .page-header { margin-bottom: var(--space-xl); }
    .page-header h1 { margin: 0 0 var(--space-xs); color: var(--text-strong); font-size: var(--text-xl); }
    .page-header p { margin: 0; color: var(--muted); font-size: var(--text-sm); }
    .number-input {
      box-sizing: border-box;
      width: min(100%, 18rem);
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--card);
      color: var(--text-strong);
      font: inherit;
    }
    .number-input:focus { border-color: var(--accent); outline: 2px solid var(--accent-subtle); }
    .number-input:disabled { cursor: not-allowed; opacity: 0.6; }
    .policy-note { margin: var(--space-md) 0 0; color: var(--muted); font-size: var(--text-sm); line-height: 1.6; }
    .skeleton { min-height: 8rem; }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      this.config = await apiClient.get<SessionConfig>('/auth/session-config');
      this.idleTimeoutMinutes = String(this.config.idleTimeoutMinutes);
    } catch {
      this.config = null;
      showToast('加载登录安全设置失败', 'error');
    } finally {
      this.loading = false;
    }
  }

  private validate(): number | null {
    const value = Number(this.idleTimeoutMinutes);
    const min = this.config?.minIdleTimeoutMinutes ?? 5;
    const max = this.config?.maxIdleTimeoutMinutes ?? 43_200;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      this.fieldError = `请输入 ${min} 到 ${max} 之间的整数`;
      return null;
    }
    this.fieldError = '';
    return value;
  }

  private async save(): Promise<void> {
    const idleTimeoutMinutes = this.validate();
    if (idleTimeoutMinutes === null) return;
    this.saving = true;
    try {
      this.config = await apiClient.put<SessionConfig>('/auth/session-config', { idleTimeoutMinutes });
      this.idleTimeoutMinutes = String(this.config.idleTimeoutMinutes);
      showToast('登录安全设置已保存', 'success');
    } catch {
      showToast('保存登录安全设置失败', 'error');
    } finally {
      this.saving = false;
    }
  }

  override render() {
    return html`
      <div class="page-header">
        <h1>登录安全</h1>
        <p>管理用户登录会话的有效期限</p>
      </div>
      ${this.loading ? html`<div class="skeleton"></div>` : this.config ? html`
        <app-card>
          <span slot="header">会话超时</span>
          <app-form-field
            label="无操作超时（分钟）"
            hint="用户停止操作后，refresh token 超过此时间未轮换，登录会话即失效。"
            .error=${this.fieldError}
            required
          >
            <input
              class="number-input"
              type="number"
              .min=${String(this.config.minIdleTimeoutMinutes)}
              .max=${String(this.config.maxIdleTimeoutMinutes)}
              step="1"
              .value=${this.idleTimeoutMinutes}
              .disabled=${this.saving}
              @input=${(event: Event) => {
                this.idleTimeoutMinutes = (event.currentTarget as HTMLInputElement).value;
                this.fieldError = '';
              }}
            >
          </app-form-field>
          <p class="policy-note">新登录会话立即使用此设置。已登录会话保留当前 refresh token 的原到期时间，并在下一次成功续期后使用新设置。</p>
          <button slot="footer" class="btn-primary" .disabled=${this.saving} @click=${this.save}>
            ${this.saving ? '保存中...' : '保存设置'}
          </button>
        </app-card>
      ` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-settings-page': SessionSettingsPage;
  }
}
