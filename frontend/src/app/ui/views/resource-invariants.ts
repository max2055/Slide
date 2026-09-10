import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { resourceEvidenceFormStyles } from './resource-evidence-form-styles.js';
import '../components/app-form-field.js';
import '../components/app-empty-state.js';
interface Rule { id: string; version: number; metricId: string; min?: number; max?: number; dimensions?: Record<string, string> }
interface Configuration { schemaVersion: 1; version: number; rules: Rule[] }
@customElement('resource-invariants')
export class ResourceInvariants extends LitElement {
  @property() resourceType = '';
  @property({ type: Number }) resourceId = 0;
  @state() private config: Configuration | null = null;
  @state() private busy = false;
  @state() private error = '';
  @state() private editable = false;
  @state() private draft = { id: '', metricId: '', min: '', max: '', dimensions: '{}' };
  @state() private editingId: string | null = null;
  private requestVersion = 0;
  private readonly permissionsHandler = (event?: Event) => {
    try {
      const permissions = (event as CustomEvent)?.detail?.permissions ?? JSON.parse(localStorage.getItem('permissions') ?? '[]');
      this.editable = permissions.includes('*') || permissions.includes('admin:*');
    } catch { this.editable = false; }
  };
  static styles = [sharedBtnStyles, resourceEvidenceFormStyles];
  override connectedCallback() { super.connectedCallback(); this.permissionsHandler(); window.addEventListener('slide-permissions-loaded', this.permissionsHandler); }
  override disconnectedCallback() { this.requestVersion++; window.removeEventListener('slide-permissions-loaded', this.permissionsHandler); super.disconnectedCallback(); }
  protected override willUpdate(changed: Map<string, unknown>) { if (changed.has('resourceType') || changed.has('resourceId')) { this.reset(); void this.load(); } }
  private get endpoint() { return `/api/resources/${this.resourceType}/${this.resourceId}/invariants`; }
  private reset() { this.editingId = null; this.draft = { id: '', metricId: '', min: '', max: '', dimensions: '{}' }; }
  private async load() {
    const version = ++this.requestVersion; this.config = null; this.error = ''; this.busy = true;
    try {
      const response = await authFetch(this.endpoint); const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'RULES_UNAVAILABLE');
      if (!Array.isArray(body.rules)) throw new Error('RULES_INVALID');
      if (version === this.requestVersion) this.config = body;
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.busy = false; }
  }
  private edit(rule: Rule) {
    this.editingId = rule.id;
    this.draft = { id: rule.id, metricId: rule.metricId, min: rule.min === undefined ? '' : String(rule.min), max: rule.max === undefined ? '' : String(rule.max), dimensions: JSON.stringify(rule.dimensions ?? {}) };
  }
  private async write(rules: Rule[]) {
    if (!this.editable || !this.config || this.busy) return;
    const version = this.requestVersion; this.busy = true; this.error = '';
    try {
      const response = await authFetch(this.endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: this.config.version, rules }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? `RULES_SAVE_FAILED (${response.status})`);
      if (version !== this.requestVersion) return;
      this.config = body; this.reset(); this.dispatchEvent(new CustomEvent('rules-saved', { bubbles: true, composed: true }));
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.busy = false; }
  }
  private async save(event: Event) {
    event.preventDefault(); if (!this.config || !this.editable || this.busy) return;
    try {
      const dimensions: unknown = JSON.parse(this.draft.dimensions);
      if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions) || Object.keys(dimensions).length > 16
        || Object.entries(dimensions).some(([key, value]) => !/^[a-z][a-z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 256)) throw new Error('维度必须为字符串键值对象');
      const min = this.draft.min === '' ? undefined : Number(this.draft.min);
      const max = this.draft.max === '' ? undefined : Number(this.draft.max);
      if ((min === undefined && max === undefined) || (min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max)) || (min !== undefined && max !== undefined && min > max)) throw new Error('数值边界无效');
      const previous = this.config.rules.find(rule => rule.id === this.editingId);
      if (!this.draft.id.trim() || !this.draft.metricId.trim()) throw new Error('规则与指标 ID 不能为空');
      if (this.config.rules.some(rule => rule.id === this.draft.id.trim() && rule.id !== this.editingId)) throw new Error('规则 ID 已存在');
      const rule: Rule = { id: this.draft.id.trim(), version: previous ? previous.version + 1 : 1, metricId: this.draft.metricId.trim(), ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), ...(Object.keys(dimensions).length ? { dimensions: dimensions as Record<string, string> } : {}) };
      await this.write([...this.config.rules.filter(rule => rule.id !== this.editingId), rule]);
    } catch (error) { this.error = String(error); }
  }
  private field(name: keyof typeof this.draft, label: string, numeric = false) {
    return html`<app-form-field label=${label}><input aria-label=${label} type=${numeric ? 'number' : 'text'} step="any" .disabled=${this.busy || (name === 'id' && this.editingId !== null)} .required=${!numeric} .value=${this.draft[name]} @input=${(event: Event) => { this.draft = { ...this.draft, [name]: (event.target as HTMLInputElement).value }; }}></app-form-field>`;
  }
  override render() {
    return html`<section><header><h2>规则配置 ${this.config ? `v${this.config.version}` : ''}</h2><button class="btn" title="重新加载规则" aria-label="重新加载规则" .disabled=${this.busy} @click=${this.load}>${icons['refresh-cw']}</button></header>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}${this.busy ? html`<div class="skeleton" aria-label="保存或加载规则"></div>` : nothing}
      ${this.config ? html`${this.config.rules.length ? this.config.rules.map(rule => html`<article><header><code>${rule.id} v${rule.version}</code>${this.editable ? html`<div class="actions"><button class="btn-ghost" title="编辑规则" aria-label=${`编辑 ${rule.id}`} .disabled=${this.busy} @click=${() => this.edit(rule)}>${icons.edit}</button><button class="btn-ghost" title="删除规则" aria-label=${`删除 ${rule.id}`} .disabled=${this.busy} @click=${() => this.write(this.config!.rules.filter(item => item.id !== rule.id))}>${icons.trash}</button></div>` : nothing}</header><p>${rule.metricId}: ${rule.min ?? '无下界'} ~ ${rule.max ?? '无上界'}</p><p class="meta">${JSON.stringify(rule.dimensions ?? {})}</p></article>`) : html`<app-empty-state title="尚未配置规则"></app-empty-state>`}
      ${this.editable ? html`<form @submit=${this.save}><div class="fields">${this.field('id', '规则 ID')}${this.field('metricId', '指标 ID')}${this.field('min', '下界', true)}${this.field('max', '上界', true)}</div><app-form-field label="维度 JSON"><textarea aria-label="维度 JSON" .disabled=${this.busy} .value=${this.draft.dimensions} @input=${(event: Event) => { this.draft = { ...this.draft, dimensions: (event.target as HTMLTextAreaElement).value }; }}></textarea></app-form-field><div class="actions"><button class="btn-primary" type="submit" .disabled=${this.busy}>${icons.save} 保存规则</button>${this.editingId ? html`<button type="button" class="btn" .disabled=${this.busy} @click=${this.reset}>取消编辑</button>` : nothing}</div></form>` : nothing}` : nothing}</section>`;
  }
}
