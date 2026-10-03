import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { diagnosisLabels, displayTime, gapExplanation } from './diagnosis-presentation.js';
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
    return html`${this.loading ? html`<div class="skeleton" aria-label="加载评估"></div>` : nothing}${this.error ? html`<p role="status">自动评估不可用，当前异常无法确认。请检查权限与采集服务，再刷新页面。</p><details><summary>查看评估错误详情</summary><p>${this.error}</p></details>` : nothing}
      ${data ? html`<p class="meta">规则集 ${data.rulesVersion} · 评估时间 ${displayTime(data.generatedAt)}</p>
        <section aria-label="异常评估结论"><h2>异常评估结论</h2><p>${data.invariants.some(rule => rule.status === 'fail') ? '发现观测值超出配置范围，需人工核对规则与证据。' : data.invariants.some(rule => rule.status === 'unknown') || !data.invariants.length ? '规则依据不足，无法确认是否异常。' : '已评估的规则符合配置范围；不能据此确认业务正常或恢复。'}</p><p>评估来自自动观测，人工判断和恢复确认需另行记录。</p></section>
        <section><h2>不变量评估</h2>${data.invariants.length ? data.invariants.map(rule => html`<article><p>${rule.ruleId} <app-badge>${diagnosisLabels[rule.status] ?? '无法判断'}</app-badge></p><p>${gapExplanation(rule.reason)[0]}。下一步：${gapExplanation(rule.reason)[1]}。</p><details><summary>查看规则技术详情</summary><p>${rule.ruleId} v${rule.version} · ${rule.reason}</p><p class="meta">证据 ${rule.evidenceRefs.join(', ') || '无'}</p></details></article>`) : html`<app-empty-state title="暂无规则评估"></app-empty-state>`}</section>
        <section><h2>统计预期</h2>${data.expectations.length ? data.expectations.map(item => html`<article><p>${diagnosisLabels[item.metricId] ?? item.metricId} <app-badge>${diagnosisLabels[item.status] ?? '无法判断'}</app-badge></p><p>${gapExplanation(item.reason)[0]}。下一步：${gapExplanation(item.reason)[1]}。</p><p>均值 ${item.mean ?? '未知'} · 偏差 ${item.deviation ?? '未知'} · 样本 ${item.sampleCount}</p><details><summary>查看统计技术详情</summary><p>${item.reason}</p><p class="meta">证据 ${item.evidenceRefs.join(', ') || '无'}</p></details></article>`) : html`<app-empty-state title="暂无统计预期"></app-empty-state>`}</section>
        ${data.gaps.map(gap => html`<p>${gapExplanation(gap)[0]}。下一步：${gapExplanation(gap)[1]}。</p>`)}${data.gaps.length ? html`<details><summary>查看评估缺口技术详情</summary><pre>${JSON.stringify(data.gaps, null, 2)}</pre></details>` : nothing}` : nothing}
      <resource-invariants .resourceType=${this.resourceType} .resourceId=${this.resourceId} @rules-saved=${this.load}></resource-invariants>
      <resource-decisions .resourceType=${this.resourceType} .resourceId=${this.resourceId}></resource-decisions>
      <resource-recovery .resourceType=${this.resourceType} .resourceId=${this.resourceId}></resource-recovery>`;
  }
}
