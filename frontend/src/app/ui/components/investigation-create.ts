import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { loadWorkspaceResources, workspaceResourceKey, workspaceResourceLabels, type WorkspaceInventory, InvestigationsController } from '../controllers/investigations.ts';
import type { DirectGatewayClient } from '../direct-gateway.ts';
import type { InvestigationCreateRequest } from '../controllers/investigation-api.ts';
import { showToast } from './app-toast-container.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import './app-dialog.ts';
import './app-form-field.ts';
import './app-empty-state.ts';

/** Bounded, live authorized inventory. Visibility never grants investigation execution. */
@customElement('investigation-resource-picker')
export class InvestigationResourcePicker extends LitElement {
  @property({ attribute: false }) value: string[] = [];
  @property({ type: Boolean }) disabled = false;
  @state() private inventory: WorkspaceInventory | null = null;
  @state() private loading = true;
  @state() private error = '';
  @state() private query = '';
  @state() private type = '';
  private epoch = 0;
  createRenderRoot() { return this; }
  private erase = () => { this.epoch++; this.inventory = null; this.query = ''; this.error = ''; this.loading = false; this.value = []; };
  connectedCallback() {
    super.connectedCallback(); void this.load();
    window.addEventListener('slide-session-expired', this.erase);
    window.addEventListener('slide-permissions-loaded', this.erase);
  }
  disconnectedCallback() {
    this.erase(); window.removeEventListener('slide-session-expired', this.erase);
    window.removeEventListener('slide-permissions-loaded', this.erase); super.disconnectedCallback();
  }
  private async load() {
    const epoch = ++this.epoch; this.loading = true; this.error = ''; this.inventory = null;
    try { const value = await loadWorkspaceResources(); if (epoch === this.epoch) this.inventory = value; }
    catch (error) {
      if (epoch === this.epoch) {
        this.error = error instanceof Error && /资源/.test(error.message) ? error.message : '资源列表读取失败，请重试。';
        this.dispatchEvent(new CustomEvent('resource-list-unavailable', { bubbles: true, composed: true }));
      }
    }
    finally { if (epoch === this.epoch) this.loading = false; }
  }
  private change(key: string, checked: boolean) {
    if (this.disabled) return;
    this.value = checked ? [...new Set([...this.value, key])] : this.value.filter(item => item !== key);
    this.dispatchEvent(new CustomEvent('resource-selection-change', { detail: { value: this.value, names: Object.fromEntries((this.inventory?.items ?? []).map(item => [workspaceResourceKey(item.resource), item.label])) }, bubbles: true, composed: true }));
  }
  render() {
    const items = this.inventory?.items.filter(item => (!this.type || item.resource.type === this.type)
      && `${item.label} ${workspaceResourceLabels[item.resource.type]} ${workspaceResourceKey(item.resource)}`.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase())) ?? [];
    return html`<style>
      investigation-resource-picker { display:block; min-width:0; }
      investigation-resource-picker .resource-search { display:grid; grid-template-columns:minmax(0,1fr) minmax(100px,150px); gap:var(--space-sm); }
      investigation-resource-picker .resource-options { display:grid; max-height:240px; overflow:auto; margin:var(--space-sm) 0; border:1px solid var(--border); border-radius:var(--radius-md); }
      investigation-resource-picker .resource-option { display:flex; align-items:center; gap:var(--space-sm); padding:var(--space-sm) var(--space-md); border-bottom:1px solid var(--border); cursor:pointer; }
      investigation-resource-picker .resource-option:last-child { border-bottom:0; }
      investigation-resource-picker .resource-option input { width:auto; flex-shrink:0; accent-color:var(--accent); }
      investigation-resource-picker .resource-option span { min-width:0; overflow-wrap:anywhere; }
      investigation-resource-picker small { display:block; color:var(--muted); font-size:12px; }
      investigation-resource-picker .resource-note { color:var(--muted); font-size:12px; }
      @media(max-width:600px) { investigation-resource-picker .resource-search { grid-template-columns:minmax(0,1fr); } }
    </style>
    <div class="resource-search"><input aria-label="搜索资源" placeholder="查找数据库、服务器或网络设备" .value=${this.query} ?disabled=${this.disabled} @input=${(e: Event) => this.query = (e.target as HTMLInputElement).value}>
      <select aria-label="筛选资源类型" .value=${this.type} ?disabled=${this.disabled} @change=${(e: Event) => this.type = (e.target as HTMLSelectElement).value}><option value="">全部资源类型</option>${Object.entries(workspaceResourceLabels).map(([key, label]) => html`<option value=${key}>${label}</option>`)}</select></div>
    ${this.loading ? html`<p role="status">正在加载有权限的资源…</p>` : this.error ? html`<p role="alert">${this.error}<button class="btn" ?disabled=${this.disabled} @click=${this.load}>重试资源列表</button></p>` : html`
      ${this.inventory?.dataQuality === 'partial' ? html`<p class="resource-note" role="status">资源列表不完整。${this.inventory.truncated ? '仅检索已返回的前 500 项；可在高级入口填写确切 ID。' : ''}${this.inventory.unavailableTypes?.length ? `暂不可用：${this.inventory.unavailableTypes.map(type => workspaceResourceLabels[type]).join('、')}。` : ''}</p>` : nothing}
      ${items.length ? html`<div class="resource-options">${items.map(item => { const key = workspaceResourceKey(item.resource); return html`<label class="resource-option"><input type="checkbox" aria-label=${`${item.label} · ${workspaceResourceLabels[item.resource.type]}`} .checked=${this.value.includes(key)} ?disabled=${this.disabled} @change=${(e: Event) => this.change(key, (e.target as HTMLInputElement).checked)}><span>${item.label}<small>${workspaceResourceLabels[item.resource.type]} · ${key} · 状态：${item.status || '未知'}</small></span></label>`; })}</div>` : html`<app-empty-state title=${this.query || this.type ? '没有匹配资源' : '暂无可选资源'} description="仅显示当前可读取的资源；可更换搜索或核对权限。"></app-empty-state>`}
      <p class="resource-note">已选 ${this.value.length} 项：${(this.inventory?.items ?? []).filter(item => this.value.includes(workspaceResourceKey(item.resource))).map(item => item.label).join('、') || '尚未选择'}。资源可见不等于可执行，提交时仍实时核验权限；离线或未知状态不代表没有历史证据。</p>`}`;
  }
}

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
  @state() private selected: string[] = [];
  @state() private resourceNames: Record<string, string> = {};
  @state() private advancedRefs = '';
  @state() private advancedOpen = false;
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
    this.profile = 'ops'; this.resource = 'instance'; this.selected = []; this.resourceNames = {}; this.advancedRefs = ''; this.advancedOpen = false;
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
    const ids = this.ids.split(',').map(id => id.trim()).filter(Boolean);
    const raw = [...this.selected, ...ids.map(id => `${this.resource}:${id}`), ...this.advancedRefs.split(',').map(ref => ref.trim()).filter(Boolean)];
    const invalid = raw.some(ref => !/^(instance|server|network_device):[1-9]\d*$/.test(ref) || !Number.isSafeInteger(Number(ref.split(':')[1])));
    if (!this.investigationTitle.trim() || !this.goal.trim() || this.profile === 'ops' && (!raw.length || invalid)) {
      this.validation = '请填写标题、调查目标并选择资源；高级 ID 必须为有效的正整数。'; return;
    }
    if ((!!this.from !== !!this.to) || this.from && (Date.parse(this.from) >= Date.parse(this.to) || !Number.isFinite(Date.parse(this.from)) || !Number.isFinite(Date.parse(this.to)))) {
      this.validation = '时间窗口需同时填写，结束时间晚于开始时间。'; return;
    }
    const resourceRefs: InvestigationCreateRequest['resourceRefs'] = this.profile === 'ops'
      ? [...new Set(raw)].map((ref, i) => { const [type, id] = ref.split(':'); return { type: type as 'instance' | 'server' | 'network_device', id: Number(id), role: i ? 'related' as const : 'primary' as const }; }) : [];
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
    this.close(); this.clearDraft();
    this.dispatchEvent(new CustomEvent('investigation-created', { bubbles: true, composed: true, detail: result }));
  }
  render() {
    const field = (label: string, value: string, setter: (v: string) => void, type = 'text') => html`<app-form-field label=${label}>
      <input aria-label=${label} type=${type} .value=${value} @input=${(e: Event) => setter((e.target as HTMLInputElement).value)}></app-form-field>`;
    return html`<style>${sharedBtnStyles.cssText}
      investigation-create input, investigation-create textarea, investigation-create select { box-sizing:border-box; width:100%; min-width:0; background:var(--input); color:var(--text); border:1px solid var(--border); border-radius:var(--radius-sm); padding:var(--space-sm); }
      investigation-create h3 { font-size:16px; margin:var(--space-lg) 0 var(--space-sm); }
      investigation-create p { font-size:14px; color:var(--muted); }
      investigation-create .create-times { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-md); }
      investigation-create fieldset { border:0; padding:0; margin:0; min-width:0; }
      investigation-create summary { cursor:pointer; font-size:14px; margin:var(--space-md) 0; }
      investigation-create .selected-resource { display:flex; align-items:center; gap:var(--space-sm); overflow-wrap:anywhere; margin:var(--space-xs) 0; font-size:12px; }
      @media(max-width:600px) { investigation-create .create-times { grid-template-columns:minmax(0,1fr); } }
      investigation-create .create-footer { display:flex; gap:var(--space-sm); flex-wrap:wrap; }
      investigation-create [role=alert] { color:var(--danger); overflow-wrap:anywhere; }
    </style>
    <app-dialog size="xl" .open=${this.open} .closeOnOverlay=${!this.controller.busy} .closable=${!this.controller.busy} title=${this.sessionId ? '将对话转为调查' : '创建手动调查'} @app-dialog-close=${this.close}>
      <p>调查只读取所选边界内的数据。${this.sessionId ? '关联原 Session，不复制历史消息。' : ''}</p>
      ${this.validation || this.controller.error ? html`<p role="alert">${this.validation || this.controller.error}</p>` : ''}
      <fieldset ?disabled=${this.controller.busy || this.controller.acceptanceUnknown}>
      ${field('调查标题', this.investigationTitle, v => this.investigationTitle = v)}
      <app-form-field label="调查目标" .required=${true}><textarea aria-label="调查目标" maxlength="2000" rows="3" .value=${this.goal} @input=${(e: Event) => this.goal = (e.target as HTMLTextAreaElement).value}></textarea></app-form-field>
      <app-form-field label="调查 Profile"><select aria-label="调查 Profile" .value=${this.profile} @change=${(e: Event) => { this.profile = (e.target as HTMLSelectElement).value as 'ops' | 'system'; this.selected = []; this.resourceNames = {}; this.ids = ''; this.advancedRefs = ''; this.validation = ''; }}><option value="ops">Ops（资源只读调查）</option><option value="system">System（平台只读调查）</option></select></app-form-field>
      ${this.profile === 'ops' ? html`<h3>资源范围</h3><p>按名称选择，不默认包含其他资源。首个所选资源为主资源，其余为关联资源。</p>
        ${this.open ? html`<investigation-resource-picker .value=${this.selected} @resource-list-unavailable=${() => this.advancedOpen = true} .disabled=${this.controller.busy || this.controller.acceptanceUnknown} @resource-selection-change=${(e: CustomEvent<{ value: string[]; names: Record<string, string> }>) => { this.selected = e.detail.value; this.resourceNames = e.detail.names; }}></investigation-resource-picker>` : nothing}
        ${this.selected.map((ref, index) => html`<div class="selected-resource"><span>${index ? '关联资源' : '主资源'} · ${this.resourceNames[ref] || ref}</span>${index ? html`<button type="button" class="btn-ghost" @click=${() => this.selected = [ref, ...this.selected.filter(value => value !== ref)]}>设为主资源</button>` : nothing}<button type="button" class="btn-ghost" aria-label=${`移除 ${ref}`} @click=${() => this.selected = this.selected.filter(value => value !== ref)}>移除</button></div>`)}
        <details .open=${this.advancedOpen} @toggle=${(e: Event) => this.advancedOpen = (e.target as HTMLDetailsElement).open}><summary>高级：按资源标识补充</summary>
          <app-form-field label="资源标识" hint="例如 instance:1, server:3；与名称选择合并去重，不自动授权。"><input aria-label="资源标识" .value=${this.advancedRefs} @input=${(e: Event) => this.advancedRefs = (e.target as HTMLInputElement).value}></app-form-field>
          <app-form-field label="资源类型"><select aria-label="资源类型" .value=${this.resource} @change=${(e: Event) => this.resource = (e.target as HTMLSelectElement).value}>${Object.entries(workspaceResourceLabels).map(([key, label]) => html`<option value=${key}>${label}</option>`)}</select></app-form-field>
          <app-form-field label="资源 ID" hint="兼容入口；多个 ID 用逗号分隔，全部资源均需当前访问权限。"><input aria-label="资源 ID" .value=${this.ids} @input=${(e: Event) => this.ids = (e.target as HTMLInputElement).value}></app-form-field>
        </details>` : html`<p role="status">System 仅调查平台，已清除资源选择；不会把资源范围带入平台调查。</p>`}
      <div class="create-times">${field('观察开始时间', this.from, v => this.from = v, 'datetime-local')}${field('观察结束时间', this.to, v => this.to = v, 'datetime-local')}</div>
      </fieldset>
      ${this.controller.acceptanceUnknown ? html`<p role="status">提交结果未知，已锁定本次输入。请核对原请求，避免重复创建。</p>` : nothing}
      <div class="create-footer" slot="footer"><button class="btn" ?disabled=${this.controller.busy} @click=${this.close}>取消</button>
        <button class="btn-primary" ?disabled=${this.controller.busy} @click=${this.submit}>${this.controller.busy ? '正在提交…' : this.controller.acceptanceUnknown ? '核对原请求' : '提交调查'}</button></div>
    </app-dialog>`;
  }
}
