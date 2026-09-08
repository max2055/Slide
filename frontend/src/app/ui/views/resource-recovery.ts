import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { resourceEvidenceFormStyles } from './resource-evidence-form-styles.js';
import '../components/app-form-field.js';
interface Policy { schemaVersion: 1; version: number; enabled: boolean; commandTypes: string[]; metricId: string; source: string; dimensions?: Record<string, string>; min?: number; max?: number; windowSeconds: number; maxSampleGapSeconds: number }
interface Recovery { status: string; reason: string; operationId: string; operationState: string; evidenceRefs: string[]; verifiedBy: string; policyVersion?: number; source?: string; metricId?: string; startedAt?: string; windowSeconds?: number }
@customElement('resource-recovery')
export class ResourceRecovery extends LitElement {
  @property() resourceType = '';
  @property({ type: Number }) resourceId = 0;
  @state() private version: number | null = null;
  @state() private enabled = false;
  @state() private draft = { commandTypes: '', metricId: '', source: '', dimensions: '{}', min: '', max: '', windowSeconds: '60', maxSampleGapSeconds: '30' };
  @state() private editable = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private saved = false;
  @state() private operationId = '';
  @state() private verifying = false;
  @state() private verifyError = '';
  @state() private result: Recovery | null = null;
  private requestVersion = 0;
  private verificationVersion = 0;
  private readonly permissionsHandler = (event?: Event) => {
    try { const p = (event as CustomEvent)?.detail?.permissions ?? JSON.parse(localStorage.getItem('permissions') ?? '[]'); this.editable = p.includes('*') || p.includes('admin:*'); } catch { this.editable = false; }
  };
  static styles = [sharedBtnStyles, resourceEvidenceFormStyles];
  override connectedCallback() { super.connectedCallback(); this.permissionsHandler(); window.addEventListener('slide-permissions-loaded', this.permissionsHandler); }
  override disconnectedCallback() { this.requestVersion++; this.verificationVersion++; window.removeEventListener('slide-permissions-loaded', this.permissionsHandler); super.disconnectedCallback(); }
  protected override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('resourceType') || changed.has('resourceId')) { this.verificationVersion++; this.operationId = ''; this.result = null; this.verifyError = ''; this.verifying = false; void this.load(); }
  }
  private get endpoint() { return `/api/resources/${this.resourceType}/${this.resourceId}`; }
  private accept(policy: Policy) {
    this.version = policy.version; this.enabled = policy.enabled;
    this.draft = { commandTypes: policy.commandTypes.join('\n'), metricId: policy.metricId, source: policy.source, dimensions: JSON.stringify(policy.dimensions ?? {}), min: policy.min === undefined ? '' : String(policy.min), max: policy.max === undefined ? '' : String(policy.max), windowSeconds: String(policy.windowSeconds), maxSampleGapSeconds: String(policy.maxSampleGapSeconds) };
  }
  private async load() {
    const version = ++this.requestVersion; this.busy = true; this.error = ''; this.version = null; this.enabled = false; this.saved = false;
    try {
      const response = await authFetch(`${this.endpoint}/recovery-policy`); const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'RECOVERY_POLICY_UNAVAILABLE');
      if (!Array.isArray(body.commandTypes) || typeof body.enabled !== 'boolean') throw new Error('RECOVERY_POLICY_INVALID');
      if (version === this.requestVersion) this.accept(body);
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.busy = false; }
  }
  private async save(event: Event) {
    event.preventDefault(); if (!this.editable || this.busy || this.version === null) return;
    const version = this.requestVersion; this.saved = false;
    try {
      const dimensions = JSON.parse(this.draft.dimensions);
      if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions) || Object.keys(dimensions).length > 16 || Object.entries(dimensions).some(([key, value]) => !/^[a-z][a-z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 256)) throw new Error('RECOVERY_DIMENSIONS_INVALID');
      const commandTypes = this.draft.commandTypes.split('\n').map(value => value.trim()).filter(Boolean);
      const min = this.draft.min === '' ? undefined : Number(this.draft.min), max = this.draft.max === '' ? undefined : Number(this.draft.max);
      const windowSeconds = Number(this.draft.windowSeconds), maxSampleGapSeconds = Number(this.draft.maxSampleGapSeconds);
      if (!Number.isInteger(windowSeconds) || windowSeconds < 30 || windowSeconds > 3600 || !Number.isInteger(maxSampleGapSeconds) || maxSampleGapSeconds < 1 || maxSampleGapSeconds > windowSeconds || commandTypes.length > 16 || new Set(commandTypes).size !== commandTypes.length || commandTypes.some(value => value.length > 128)
        || (min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max)) || (min !== undefined && max !== undefined && min > max)
        || (this.enabled && (!commandTypes.length || !this.draft.metricId.trim() || !this.draft.source.trim() || (min === undefined && max === undefined)))) throw new Error('RECOVERY_POLICY_INVALID');
      const body = { expectedVersion: this.version, enabled: this.enabled, commandTypes, metricId: this.draft.metricId.trim(), source: this.draft.source.trim(), ...(Object.keys(dimensions).length ? { dimensions } : {}), ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), windowSeconds, maxSampleGapSeconds };
      this.busy = true; this.error = '';
      const response = await authFetch(`${this.endpoint}/recovery-policy`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const policy = await response.json();
      if (!response.ok) throw new Error(policy.error ?? `RECOVERY_POLICY_SAVE_FAILED (${response.status})`);
      if (version === this.requestVersion) { this.accept(policy); this.saved = true; }
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.busy = false; }
  }
  private async verify(event: Event) {
    event.preventDefault(); if (!this.operationId.trim() || this.verifying) return;
    const version = ++this.verificationVersion; this.verifying = true; this.verifyError = ''; this.result = null;
    try {
      const response = await authFetch(`${this.endpoint}/recovery/${encodeURIComponent(this.operationId.trim())}`); const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `RECOVERY_UNAVAILABLE (${response.status})`);
      if (!['unknown', 'not-recovered', 'recovered'].includes(body.status) || !Array.isArray(body.evidenceRefs)) throw new Error('RECOVERY_RESULT_INVALID');
      if (version === this.verificationVersion) this.result = body;
    } catch (error) { if (version === this.verificationVersion) this.verifyError = String(error); }
    finally { if (version === this.verificationVersion) this.verifying = false; }
  }
  private field(name: keyof typeof this.draft, label: string, type = 'text') {
    return html`<app-form-field label=${label}><input aria-label=${label} type=${type} step=${name === 'windowSeconds' || name === 'maxSampleGapSeconds' ? '1' : 'any'} .value=${this.draft[name]} .disabled=${!this.editable || this.busy} @input=${(event: Event) => { this.saved = false; this.draft = { ...this.draft, [name]: (event.target as HTMLInputElement).value }; }}></app-form-field>`;
  }
  override render() {
    return html`<section><header><h2>恢复策略 ${this.version === null ? '' : `v${this.version}`}</h2><button class="btn" title="重新加载恢复策略" aria-label="重新加载恢复策略" .disabled=${this.busy} @click=${this.load}>${icons['refresh-cw']}</button></header>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}${this.saved ? html`<p role="status">恢复策略已保存</p>` : nothing}${this.busy ? html`<div class="skeleton" aria-label="加载或保存恢复策略"></div>` : nothing}
      ${this.version !== null ? html`<form data-policy-form @submit=${this.save}><app-form-field label="启用恢复策略"><input type="checkbox" aria-label="启用恢复策略" .checked=${this.enabled} .disabled=${!this.editable || this.busy} @change=${(event: Event) => { this.saved = false; this.enabled = (event.target as HTMLInputElement).checked; }}></app-form-field>
        <app-form-field label="命令类型"><textarea aria-label="命令类型" .value=${this.draft.commandTypes} .disabled=${!this.editable || this.busy} @input=${(event: Event) => { this.saved = false; this.draft = { ...this.draft, commandTypes: (event.target as HTMLTextAreaElement).value }; }}></textarea></app-form-field>
        <div class="fields">${this.field('metricId', '恢复指标 ID')}${this.field('source', '证据来源')}${this.field('min', '恢复下界', 'number')}${this.field('max', '恢复上界', 'number')}${this.field('windowSeconds', '验证窗口（秒）', 'number')}${this.field('maxSampleGapSeconds', '最大采样间隔（秒）', 'number')}</div>
        <app-form-field label="恢复维度 JSON"><textarea aria-label="恢复维度 JSON" .value=${this.draft.dimensions} .disabled=${!this.editable || this.busy} @input=${(event: Event) => { this.saved = false; this.draft = { ...this.draft, dimensions: (event.target as HTMLTextAreaElement).value }; }}></textarea></app-form-field>
        ${this.editable ? html`<button class="btn-primary" type="submit" .disabled=${this.busy}>${icons.save} 保存恢复策略</button>` : nothing}</form>` : nothing}</section>
      <section><h2>操作恢复验证</h2><form data-verify-form @submit=${this.verify}><app-form-field label="操作 ID"><input aria-label="操作 ID" maxlength="128" .required=${true} .value=${this.operationId} @input=${(event: Event) => { this.verificationVersion++; this.verifying = false; this.result = null; this.verifyError = ''; this.operationId = (event.target as HTMLInputElement).value; }}></app-form-field><button class="btn" type="submit" .disabled=${this.verifying || !this.operationId.trim()}>${icons.search} 查询恢复状态</button></form>
      ${this.verifying ? html`<div class="skeleton" aria-label="查询恢复状态"></div>` : nothing}${this.verifyError ? html`<p class="error" role="alert">${this.verifyError}</p>` : nothing}
      ${this.result ? html`<article data-recovery-result><p>${this.result.status} · ${this.result.reason}</p><p>操作 ${this.result.operationId} · ${this.result.operationState}</p><p class="meta">${this.result.verifiedBy}</p>${this.result.policyVersion !== undefined ? html`<p>绑定策略 v${this.result.policyVersion} · ${this.result.metricId} · ${this.result.source}</p><p class="meta">${this.result.startedAt} · ${this.result.windowSeconds} s</p>` : nothing}<details open><summary>验证证据 (${this.result.evidenceRefs.length})</summary>${this.result.evidenceRefs.map(id => html`<p><code>${id}</code></p>`)}</details></article>` : nothing}</section>`;
  }
}
