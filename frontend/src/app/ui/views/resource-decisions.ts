import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { resourceEvidenceFormStyles } from './resource-evidence-form-styles.js';
import '../components/app-form-field.js';
import '../components/app-empty-state.js';
interface Evidence { id: string; observedAt: string; status: string; payload: { metricId?: string; statement?: string } }
interface Decision { id: string; status: 'inference' | 'hypothesis'; statement: string; evidenceRefs: string[]; from: string; to: string; createdAt: string }
function localTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, -1);
}
@customElement('resource-decisions')
export class ResourceDecisions extends LitElement {
  @property() resourceType = '';
  @property({ type: Number }) resourceId = 0;
  @state() private items: Decision[] = [];
  @state() private evidence: Evidence[] = [];
  @state() private selected = new Set<string>();
  @state() private statement = '';
  @state() private status: 'inference' | 'hypothesis' = 'inference';
  @state() private from = '';
  @state() private to = '';
  @state() private gaps: string[] = [];
  @state() private truncated = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private editable = false;
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
  protected override willUpdate(changed: Map<string, unknown>) { if (changed.has('resourceType') || changed.has('resourceId')) void this.load(); }
  private get endpoint() { return `/api/resources/${this.resourceType}/${this.resourceId}`; }
  private async get(path: string) {
    const response = await authFetch(path); const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `EVIDENCE_UNAVAILABLE (${response.status})`);
    return body;
  }
  private async load() {
    const version = ++this.requestVersion; this.busy = true; this.error = ''; this.items = []; this.evidence = []; this.gaps = []; this.selected = new Set(); this.statement = ''; this.from = ''; this.to = ''; this.truncated = false;
    const [decisions, evidence] = await Promise.allSettled([this.get(`${this.endpoint}/decisions?limit=20`), this.get(`${this.endpoint}/evidence`)]);
    if (version !== this.requestVersion) return;
    const errors: string[] = [];
    if (decisions.status === 'fulfilled' && Array.isArray(decisions.value.items)) {
      this.items = decisions.value.items; this.gaps = decisions.value.gaps; this.truncated = decisions.value.truncated;
    } else errors.push(decisions.status === 'rejected' ? String(decisions.reason) : 'DECISIONS_INVALID');
    if (evidence.status === 'fulfilled' && Array.isArray(evidence.value.facts)) {
      const bundle = evidence.value;
      this.evidence = [...new Map<string, Evidence>([...bundle.facts, ...(bundle.inferences ?? []), ...(bundle.hypotheses ?? [])].filter((item: Evidence) => Number.isFinite(Date.parse(item.observedAt))).map((item: Evidence) => [item.id, item])).values()];
      if (bundle.truncated) this.gaps = [...this.gaps, 'EVIDENCE_TRUNCATED'];
      this.gaps = [...new Set([...this.gaps, ...(bundle.gaps ?? [])])];
    } else errors.push(evidence.status === 'rejected' ? String(evidence.reason) : 'EVIDENCE_INVALID');
    this.error = errors.join('; '); this.busy = false;
  }
  private toggle(id: string, checked: boolean) {
    const selected = new Set(this.selected); if (checked) selected.add(id); else selected.delete(id); this.selected = selected;
    const times = this.evidence.filter(item => selected.has(item.id)).map(item => Date.parse(item.observedAt));
    this.from = times.length ? localTime(new Date(Math.min(...times)).toISOString()) : '';
    this.to = times.length ? localTime(new Date(Math.max(...times)).toISOString()) : '';
  }
  private async save(event: Event) {
    event.preventDefault(); if (!this.editable || this.busy) return;
    const version = this.requestVersion;
    try {
      const from = new Date(this.from).toISOString(), to = new Date(this.to).toISOString();
      const evidenceRefs = [...this.selected];
      if (!this.statement.trim() || evidenceRefs.length < 1 || evidenceRefs.length > 100 || from > to || evidenceRefs.some(id => !this.evidence.some(item => item.id === id && item.observedAt >= from && item.observedAt <= to))) throw new Error('DECISION_EVIDENCE_INVALID');
      this.busy = true; this.error = '';
      const response = await authFetch(`${this.endpoint}/decisions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ statement: this.statement.trim(), status: this.status, evidenceRefs, from, to }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'DECISION_SAVE_FAILED');
      if (version !== this.requestVersion) return;
      this.items = [body, ...this.items].slice(0, 20); this.selected = new Set(); this.statement = ''; this.from = ''; this.to = '';
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.busy = false; }
  }
  override render() {
    return html`<section><header><h2>推论与假设记录</h2><button class="btn" title="刷新决策记录" aria-label="刷新决策记录" .disabled=${this.busy} @click=${this.load}>${icons['refresh-cw']}</button></header>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}${this.busy ? html`<div class="skeleton" aria-label="加载或保存决策"></div>` : nothing}
      ${this.items.length ? this.items.map(item => html`<article><header><code>${item.id}</code><span>${item.status === 'inference' ? '推论' : '假设'}</span></header><p>${item.statement}</p><p class="meta">${item.from} ~ ${item.to} · ${item.createdAt}</p><details><summary>引用证据 (${item.evidenceRefs.length})</summary>${item.evidenceRefs.map(id => html`<p><code>${id}</code></p>`)}</details></article>`) : !this.busy && !this.error ? html`<app-empty-state title="暂无决策记录"></app-empty-state>` : nothing}
      ${this.truncated ? html`<p role="status">仅显示最近 20 条记录</p>` : nothing}${this.gaps.map(gap => html`<p class="meta">${gap}</p>`)}
      ${this.editable && this.evidence.length ? html`<form @submit=${this.save}><app-form-field label="记录类型"><select aria-label="记录类型" .value=${this.status} .disabled=${this.busy} @change=${(event: Event) => { this.status = (event.target as HTMLSelectElement).value as 'inference' | 'hypothesis'; }}><option value="inference">推论</option><option value="hypothesis">假设</option></select></app-form-field>
        <app-form-field label="判断内容"><textarea aria-label="判断内容" maxlength="2000" .required=${true} .disabled=${this.busy} .value=${this.statement} @input=${(event: Event) => { this.statement = (event.target as HTMLTextAreaElement).value; }}></textarea></app-form-field>
        <details open><summary>引用证据 (${this.selected.size})</summary>${this.evidence.map(item => html`<label class="evidence-option"><input type="checkbox" aria-label=${`引用 ${item.id}`} .disabled=${this.busy} .checked=${this.selected.has(item.id)} @change=${(event: Event) => this.toggle(item.id, (event.target as HTMLInputElement).checked)}><span>${item.payload.metricId ?? item.payload.statement ?? item.status}<code>${item.id}</code><span class="meta">${item.observedAt}</span></span></label>`)}</details>
        <div class="fields"><app-form-field label="时间起点"><input aria-label="时间起点" type="datetime-local" step="0.001" .required=${true} .disabled=${this.busy} .value=${this.from} @input=${(event: Event) => { this.from = (event.target as HTMLInputElement).value; }}></app-form-field><app-form-field label="时间终点"><input aria-label="时间终点" type="datetime-local" step="0.001" .required=${true} .disabled=${this.busy} .value=${this.to} @input=${(event: Event) => { this.to = (event.target as HTMLInputElement).value; }}></app-form-field></div>
        <button class="btn-primary" type="submit" .disabled=${this.busy || !this.statement.trim() || !this.selected.size}>${icons.save} 保存判断</button></form>` : this.editable && !this.busy ? html`<app-empty-state title="没有可引用证据"></app-empty-state>` : nothing}</section>`;
  }
}
