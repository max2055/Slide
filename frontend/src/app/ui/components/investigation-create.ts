import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { InvestigationsController } from '../controllers/investigations.ts';
import type { DirectGatewayClient } from '../direct-gateway.ts';
import type { InvestigationCreateRequest } from '../controllers/investigation-api.ts';
import { showToast } from './app-toast-container.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import './app-dialog.ts';
import './app-form-field.ts';

@customElement('investigation-create')
export class InvestigationCreate extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) client: DirectGatewayClient | null = null;
  @property() sessionId = '';
  @state() private investigationTitle = '';
  @state() private goal = '';
  @state() private profile: 'ops' | 'system' = 'ops';
  @state() private resource = 'instance';
  @state() private ids = '';
  @state() private from = '';
  @state() private to = '';
  @state() private validation = '';
  private controller = new InvestigationsController(() => this.controllerChanged(), null);
  private controllerChanged() {
    if (this.controller.forbidden) {
      const message = this.controller.error;
      this.authorityChanged();
      if (message) showToast(message, 'error');
    }
    this.requestUpdate();
  }
  createRenderRoot() { return this; }
  private clearDraft() {
    this.investigationTitle = ''; this.goal = ''; this.ids = ''; this.from = ''; this.to = ''; this.validation = '';
    this.profile = 'ops'; this.resource = 'instance';
    this.controller.dispose(); this.controller = new InvestigationsController(() => this.controllerChanged(), this.client);
  }
  private authorityChanged = () => { this.clearDraft(); this.close(); };
  disconnectedCallback() {
    window.removeEventListener('slide-session-expired', this.authorityChanged);
    window.removeEventListener('slide-permissions-loaded', this.authorityChanged);
    this.clearDraft(); this.controller.dispose(); this.open = false; super.disconnectedCallback();
  }
  connectedCallback() {
    super.connectedCallback(); this.controller = new InvestigationsController(() => this.controllerChanged(), this.client);
    window.addEventListener('slide-session-expired', this.authorityChanged);
    window.addEventListener('slide-permissions-loaded', this.authorityChanged);
  }
  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('sessionId') && changed.get('sessionId') !== undefined) this.authorityChanged();
  }
  private close() { this.open = false; this.dispatchEvent(new CustomEvent('investigation-create-close', { bubbles: true, composed: true })); }
  private async submit() {
    if (this.controller.acceptanceUnknown) {
      const result = await this.controller.retryPending();
      if (result) this.created(result);
      return;
    }
    this.validation = '';
    const ids = this.ids.split(',').map(id => id.trim()).filter(Boolean).map(Number);
    if (!this.investigationTitle.trim() || !this.goal.trim() || this.profile === 'ops' && (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1))) {
      this.validation = '请填写标题、调查目标与有效资源 ID。'; return;
    }
    if ((!!this.from !== !!this.to) || this.from && (Date.parse(this.from) >= Date.parse(this.to) || !Number.isFinite(Date.parse(this.from)) || !Number.isFinite(Date.parse(this.to)))) {
      this.validation = '时间窗口需同时填写，结束时间晚于开始时间。'; return;
    }
    const resourceRefs: InvestigationCreateRequest['resourceRefs'] = this.profile === 'ops'
      ? [...new Set(ids)].map((id, i) => ({ type: this.resource as 'instance' | 'server' | 'network_device', id, role: i ? 'related' : 'primary' })) : [];
    const body: InvestigationCreateRequest = { title: this.investigationTitle.trim(), goal: this.goal.trim(), profileId: this.profile,
      subject: this.profile === 'ops' ? { kind: 'resource', resource: { type: resourceRefs[0].type, id: resourceRefs[0].id } } : { kind: 'platform', component: 'slide' },
      resourceRefs, ...(this.sessionId ? { sessionId: this.sessionId.replace(/^agent:[^:]+:/, '') } : {}),
      ...(this.from ? { from: new Date(this.from).toISOString(), to: new Date(this.to).toISOString() } : {}) };
    const result = await this.controller.create(body, false);
    if (!result) return;
    this.created(result);
  }
  private created(result: { id: string }) {
    showToast(this.sessionId ? '原对话已关联调查，消息保留。' : '调查已接受。', 'success');
    this.close();
    this.dispatchEvent(new CustomEvent('investigation-created', { bubbles: true, composed: true, detail: result }));
  }
  render() {
    const field = (label: string, value: string, setter: (v: string) => void, type = 'text') => html`<app-form-field label=${label}>
      <input aria-label=${label} type=${type} .value=${value} @input=${(e: Event) => setter((e.target as HTMLInputElement).value)}></app-form-field>`;
    return html`<style>${sharedBtnStyles.cssText}
      investigation-create input, investigation-create textarea, investigation-create select { box-sizing:border-box; width:100%; min-width:0; background:var(--input); color:var(--text); border:1px solid var(--border); border-radius:var(--radius-sm); padding:var(--space-sm); }
      investigation-create .create-footer { display:flex; gap:var(--space-sm); flex-wrap:wrap; }
      investigation-create [role=alert] { color:var(--danger); overflow-wrap:anywhere; }
    </style>
    <app-dialog .open=${this.open} .closeOnOverlay=${!this.controller.busy} .closable=${!this.controller.busy} title=${this.sessionId ? '将对话转为调查' : '创建手动调查'} @app-dialog-close=${this.close}>
      <p>调查只读取所选边界内的数据。${this.sessionId ? '关联原 Session，不复制历史消息。' : ''}</p>
      ${field('调查标题', this.investigationTitle, v => this.investigationTitle = v)}
      <app-form-field label="调查目标" .required=${true}><textarea aria-label="调查目标" maxlength="2000" rows="3" .value=${this.goal} @input=${(e: Event) => this.goal = (e.target as HTMLTextAreaElement).value}></textarea></app-form-field>
      <app-form-field label="调查 Profile"><select aria-label="调查 Profile" .value=${this.profile} @change=${(e: Event) => this.profile = (e.target as HTMLSelectElement).value as 'ops' | 'system'}><option value="ops">Ops（资源只读调查）</option><option value="system">System（平台只读调查）</option></select></app-form-field>
      ${this.profile === 'ops' ? html`<app-form-field label="资源类型"><select aria-label="资源类型" .value=${this.resource} @change=${(e: Event) => this.resource = (e.target as HTMLSelectElement).value}><option value="instance">数据库实例</option><option value="server">服务器</option><option value="network_device">网络设备</option></select></app-form-field>
        <app-form-field label="资源 ID" hint="填写资源详情中的 ID；多个 ID 用逗号分隔，全部资源均需当前访问权限。"><input aria-label="资源 ID" .value=${this.ids} @input=${(e: Event) => this.ids = (e.target as HTMLInputElement).value}></app-form-field>` : ''}
      ${field('观察开始时间', this.from, v => this.from = v, 'datetime-local')}${field('观察结束时间', this.to, v => this.to = v, 'datetime-local')}
      ${this.validation || this.controller.error ? html`<p role="alert">${this.validation || this.controller.error}</p>` : ''}
      <div class="create-footer" slot="footer"><button class="btn" ?disabled=${this.controller.busy} @click=${this.close}>取消</button>
        <button class="btn-primary" ?disabled=${this.controller.busy} @click=${this.submit}>${this.controller.busy ? '正在提交…' : this.controller.acceptanceUnknown ? '核对原请求' : '提交调查'}</button></div>
    </app-dialog>`;
  }
}
