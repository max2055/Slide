import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { showToast } from '../components/app-toast-container.js';
import '../components/app-card.js';
import '../components/app-form-field.js';

interface CollectionConfig {
  serverIntervalSeconds: number;
  networkDeviceIntervalSeconds: number;
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
}

@customElement('collection-settings-page')
export class CollectionSettingsPage extends LitElement {
  @state() private config: CollectionConfig | null = null;
  @state() private serverIntervalSeconds = '';
  @state() private networkDeviceIntervalSeconds = '';
  @state() private loading = true;
  @state() private saving = false;
  @state() private fieldErrors: Record<string, string> = {};

  static styles = [sharedBtnStyles, css`
    :host { display: block; width: min(100%, 48rem); color: var(--text); }
    .page-header { margin-bottom: var(--space-xl); }
    .page-header h1 { margin: 0 0 var(--space-xs); color: var(--text-strong); font-size: var(--text-xl); }
    .page-header p { margin: 0; color: var(--muted); font-size: var(--text-sm); }
    .settings-grid { display: grid; gap: var(--space-lg); }
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
    .skeleton { min-height: 12rem; }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      this.config = await apiClient.get<CollectionConfig>('/system/collection-config');
      this.serverIntervalSeconds = String(this.config.serverIntervalSeconds);
      this.networkDeviceIntervalSeconds = String(this.config.networkDeviceIntervalSeconds);
    } catch {
      this.config = null;
      showToast('加载采集设置失败', 'error');
    } finally {
      this.loading = false;
    }
  }

  private validateField(name: string, raw: string): number | null {
    const value = Number(raw);
    const min = this.config?.minIntervalSeconds ?? 10;
    const max = this.config?.maxIntervalSeconds ?? 86_400;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      this.fieldErrors = { ...this.fieldErrors, [name]: `请输入 ${min} 到 ${max} 之间的整数` };
      return null;
    }
    const next = { ...this.fieldErrors };
    delete next[name];
    this.fieldErrors = next;
    return value;
  }

  private async save(): Promise<void> {
    this.fieldErrors = {};
    const serverIntervalSeconds = this.validateField('server', this.serverIntervalSeconds);
    const networkDeviceIntervalSeconds = this.validateField('networkDevice', this.networkDeviceIntervalSeconds);
    if (serverIntervalSeconds === null || networkDeviceIntervalSeconds === null) return;

    this.saving = true;
    try {
      this.config = await apiClient.put<CollectionConfig>('/system/collection-config', {
        serverIntervalSeconds,
        networkDeviceIntervalSeconds,
      });
      this.serverIntervalSeconds = String(this.config.serverIntervalSeconds);
      this.networkDeviceIntervalSeconds = String(this.config.networkDeviceIntervalSeconds);
      showToast('采集设置已保存并生效', 'success');
    } catch {
      showToast('保存采集设置失败', 'error');
    } finally {
      this.saving = false;
    }
  }

  override render() {
    return html`
      <div class="page-header">
        <h1>采集设置</h1>
        <p>管理基础设施指标的自动采集频率</p>
      </div>
      ${this.loading ? html`<div class="skeleton"></div>` : this.config ? html`
        <app-card>
          <span slot="header">采集周期</span>
          <div class="settings-grid">
            <app-form-field
              label="服务器指标采集间隔（秒）"
              hint="通过 SSH 采集服务器 CPU、内存、磁盘和文件系统指标。"
              .error=${this.fieldErrors.server ?? ''}
              required
            >
              <input
                class="number-input"
                type="number"
                .min=${String(this.config.minIntervalSeconds)}
                .max=${String(this.config.maxIntervalSeconds)}
                step="1"
                .value=${this.serverIntervalSeconds}
                .disabled=${this.saving}
                @input=${(event: Event) => {
                  this.serverIntervalSeconds = (event.currentTarget as HTMLInputElement).value;
                  this.fieldErrors = { ...this.fieldErrors, server: '' };
                }}
              >
            </app-form-field>
            <app-form-field
              label="网络设备指标采集间隔（秒）"
              hint="通过 SNMP 采集已纳管网络设备的系统与接口指标。"
              .error=${this.fieldErrors.networkDevice ?? ''}
              required
            >
              <input
                class="number-input"
                type="number"
                .min=${String(this.config.minIntervalSeconds)}
                .max=${String(this.config.maxIntervalSeconds)}
                step="1"
                .value=${this.networkDeviceIntervalSeconds}
                .disabled=${this.saving}
                @input=${(event: Event) => {
                  this.networkDeviceIntervalSeconds = (event.currentTarget as HTMLInputElement).value;
                  this.fieldErrors = { ...this.fieldErrors, networkDevice: '' };
                }}
              >
            </app-form-field>
          </div>
          <p class="policy-note">设置保存后立即用于后续自动采集，不需要重启服务。</p>
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
    'collection-settings-page': CollectionSettingsPage;
  }
}
