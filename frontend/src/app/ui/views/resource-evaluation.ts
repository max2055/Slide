import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import '../components/app-empty-state.js';
import '../components/app-badge.js';
import './resource-invariants.js';
import './resource-decisions.js';
import './resource-recovery.js';
interface RuleResult { ruleId: string; version: number; status: string; reason: string; evidenceRefs: string[] }
interface Expectation { metricId: string; status: string; reason: string; mean: number | null; deviation: number | null; sampleCount: number; evidenceRefs: string[] }
interface Evaluation { generatedAt: string; rulesVersion: number; invariants: RuleResult[]; expectations: Expectation[]; gaps: string[] }
@customElement('resource-evaluation')
export class ResourceEvaluation extends LitElement {
  @property() resourceType = '';
  @property({ type: Number }) resourceId = 0;
  @state() private data: Evaluation | null = null;
  @state() private error = '';
  @state() private loading = false;
  private requestVersion = 0;
  static styles = css`
    :host { display: block; min-width: 0; color: var(--text); }
    section { padding: var(--space-lg) 0; border-top: 1px solid var(--border); }
    h2 { font-size: 16px; color: var(--text-strong); }
    article { padding: var(--space-sm) 0; border-bottom: 1px solid var(--border); }
    p, code { overflow-wrap: anywhere; } .meta { color: var(--muted); font-size: 12px; }
    .skeleton { height: 80px; background: var(--border); opacity: .4; }
  `;
  protected override willUpdate(changed: Map<string, unknown>) { if (changed.has('resourceType') || changed.has('resourceId')) void this.load(); }
  override disconnectedCallback() { this.requestVersion++; super.disconnectedCallback(); }
  private async load() {
    const version = ++this.requestVersion; this.data = null; this.error = '';
    if (!this.resourceType || !this.resourceId) return;
    this.loading = true;
    try {
      const response = await authFetch(`/api/resources/${this.resourceType}/${this.resourceId}/evaluation`); const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `EVALUATION_UNAVAILABLE (${response.status})`);
      if (version === this.requestVersion) this.data = body;
    } catch (error) { if (version === this.requestVersion) this.error = String(error); }
    finally { if (version === this.requestVersion) this.loading = false; }
  }
  override render() {
    const data = this.data;
    return html`${this.loading ? html`<div class="skeleton" aria-label="加载评估"></div>` : nothing}${this.error ? html`<p role="status">${this.error}</p>` : nothing}
      ${data ? html`<p class="meta">规则集 ${data.rulesVersion} · ${data.generatedAt}</p>
        <section><h2>不变量评估</h2>${data.invariants.length ? data.invariants.map(rule => html`<article><p><code>${rule.ruleId}</code> v${rule.version} <app-badge>${rule.status}</app-badge></p><p>${rule.reason}</p><p class="meta">证据 ${rule.evidenceRefs.join(', ') || '无'}</p></article>`) : html`<app-empty-state title="暂无规则评估"></app-empty-state>`}</section>
        <section><h2>统计预期</h2>${data.expectations.length ? data.expectations.map(item => html`<article><p>${item.metricId} <app-badge>${item.status}</app-badge></p><p>${item.reason}</p><p>均值 ${item.mean ?? '未知'} · 偏差 ${item.deviation ?? '未知'} · 样本 ${item.sampleCount}</p><p class="meta">证据 ${item.evidenceRefs.join(', ') || '无'}</p></article>`) : html`<app-empty-state title="暂无统计预期"></app-empty-state>`}</section>
        ${data.gaps.map(gap => html`<p>${gap}</p>`)}` : nothing}
      <resource-invariants .resourceType=${this.resourceType} .resourceId=${this.resourceId} @rules-saved=${this.load}></resource-invariants>
      <resource-decisions .resourceType=${this.resourceType} .resourceId=${this.resourceId}></resource-decisions>
      <resource-recovery .resourceType=${this.resourceType} .resourceId=${this.resourceId}></resource-recovery>`;
  }
}
