import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import type { InvestigationEvidence, InvestigationResultPage } from '../controllers/investigation-api.ts';
import { OperationsResource, authorizedJson } from '../controllers/operations-api.ts';
import { displayTime } from '../views/diagnosis-presentation.ts';
import './app-card.ts';
import './app-badge.ts';
import './app-empty-state.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';

@customElement('investigation-context')
export class InvestigationContext extends LitElement {
  @property({ attribute: false }) results: InvestigationResultPage = { items: [], nextBefore: null };
  @property({ attribute: false }) evidence: InvestigationEvidence[] = [];
  @property() evidenceState: 'pending' | 'unavailable' | 'ready' = 'pending';
  @property({ attribute: false }) onMore = () => {};
  @state() private selected = '';
  @state() private rawId = '';
  private raw = new OperationsResource<InvestigationEvidence>(this, undefined, authorizedJson);

  createRenderRoot() { return this; }

  private showEvidence(id: string) {
    const entry = Array.from(this.querySelectorAll<HTMLDetailsElement>('details[data-evidence]'))
      .find(element => element.dataset.evidence === id);
    if (!entry) return;
    entry.open = true;
    entry.querySelector('summary')?.focus({ preventScroll: true });
    entry.scrollIntoView({ block: 'nearest' });
  }

  private readRaw(evidence: InvestigationEvidence) {
    this.rawId = evidence.id;
    return this.raw.load(`/api/investigations/${encodeURIComponent(evidence.investigationId)}/evidence/${encodeURIComponent(evidence.id)}?raw=true`);
  }

  private showVersion(version: InvestigationResultPage['items'][number], latest: boolean) {
    const result = version.result;
    const refs = (ids: string[]) => ids.map(id => {
      const index = this.evidence.findIndex(evidence => evidence.id === id);
      return index === -1 ? html`<span class="muted">引用暂不可查看</span> `
        : html`<button class="btn-ghost btn-sm" type="button" @click=${() => this.showEvidence(id)}>证据 ${index + 1}</button> `;
    });
    return html`
      <details>
        <summary>结果 V${version.version} 的依据与技术详情</summary>
        ${latest ? nothing : html`<h3>历史结论</h3><p>${result.summary}</p>`}
        <p><app-badge variant="muted">${({ unverified: '根因待验证', supported: '有证据支持，待验证', human_confirmed: '人工确认', experimentally_verified: '实验验证' })[result.rootCauseVerification.status]}</app-badge></p>
        <h3>事实</h3>
        ${result.facts.length ? result.facts.map(fact => html`<p>${fact.statement}<br>${refs(fact.evidenceIds)}</p>`) : html`<p>暂无已绑定事实。</p>`}
        ${result.hypotheses.length || result.claims.length ? html`<h3>假设、推断与反证</h3>
          ${result.hypotheses.map(h => html`<p>${h.statement}（${({ supported: '支持', refuted: '反驳', unknown: '未知' })[h.status]}）<br>支持：${refs(h.supportingEvidenceIds)}<br>反证：${refs(h.contradictingEvidenceIds)}</p>`)}
          ${result.claims.map(c => html`<p>${c.kind === 'fact' ? '事实' : '推断'}：${c.statement}<br>${refs(c.supportingEvidenceIds)} ${refs(c.contradictingEvidenceIds)}</p>`)}` : nothing}
        ${!latest && result.unresolvedQuestions.length ? html`<h3>待确认问题</h3>${result.unresolvedQuestions.map(q => html`<p>${q}</p>`)}` : nothing}
        ${!latest && result.recommendations.length ? html`<h3>已保存的建议</h3>${result.recommendations.map(r => html`<p>${r.action}</p>`)}` : nothing}
        <dl>
          <dt>结果标识</dt><dd>${version.id}</dd><dt>运行标识</dt><dd>${version.runId}</dd>
          <dt>记录时间（UTC）</dt><dd>${result.createdAt ?? '未提供'}</dd>
          <dt>停止原因</dt><dd>${result.execution?.reasonCode ?? '历史记录未保留具体停止原因'}</dd>
          <dt>模型配置标识</dt><dd>${result.provenance.modelVersion === 'unavailable' ? '历史记录未保留' : result.provenance.modelVersion}</dd>
          <dt>提示词版本与哈希</dt><dd>${result.provenance.promptVersion === 'unavailable' ? '历史记录未保留' : result.provenance.promptVersion}</dd>
          <dt>用量记录</dt><dd>${({ available: '可用', unavailable: '不可用', partial: '部分可用' })[result.provenance.usageStatus]}</dd>
        </dl>
      </details>`;
  }

  render() {
    const latest = this.results.items.reduce<(typeof this.results.items)[number] | undefined>((found, item) =>
      !found || item.version > found.version ? item : found, undefined);
    const version = this.results.items.find(row => row.id === this.selected) ?? latest;
    return html`
      <style>${sharedBtnStyles.cssText}
        investigation-context { display:block; min-width:0; overflow-wrap:anywhere; }
        investigation-context select { max-width:100%; background:var(--input); color:var(--text); padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); }
        investigation-context h3 { font-size:var(--text-md); margin:var(--space-md) 0 var(--space-sm); }
        investigation-context p, investigation-context pre { white-space:pre-wrap; overflow-wrap:anywhere; }
        investigation-context .evidence-index { margin-top:var(--space-lg); }
        investigation-context .evidence-entry { border-top:1px solid var(--border); padding:var(--space-sm) 0; scroll-margin-top:var(--space-xl); }
        investigation-context .evidence-entry > summary { color:var(--accent-text); cursor:pointer; padding:var(--space-xs) 0; }
        investigation-context .evidence-entry time { display:block; margin-left:var(--space-md); }
        investigation-context dt, investigation-context .evidence-entry time { color:var(--muted); font-size:var(--text-sm); }
        investigation-context dd { margin:0 0 var(--space-sm); }
      </style>
      <app-card><span slot="header">证据索引</span>
        ${version ? html`
          <label>结果版本 <select aria-label="结果版本" .value=${version.id} @change=${(e: Event) => this.selected = (e.target as HTMLSelectElement).value}>
            ${this.results.items.map(row => html`<option value=${row.id}>V${row.version} · ${displayTime(row.result.createdAt)}</option>`)}
          </select></label>
          ${keyed(version.id, this.showVersion(version, version.id === latest?.id))}
        ` : html`<p class="muted">暂无已保存结果。</p>`}
        ${this.results.nextBefore ? html`<button class="btn" @click=${this.onMore}>加载更早结果版本</button>` : nothing}
        <section class="evidence-index" aria-label="证据记录">
          <h3>证据记录</h3>
          ${this.evidenceState === 'pending' ? html`<p role="status">正在核对可访问的证据…</p>`
            : this.evidenceState === 'unavailable' ? html`<p role="alert">证据清单暂不可用，请刷新调查核对。</p>` : nothing}
          ${this.evidence.length ? this.evidence.map((evidence, index) => html`
            <details class="evidence-entry" data-evidence=${evidence.id}>
              <summary>${evidence.source.startsWith('tool:') ? `工具检查记录 ${index + 1}` : evidence.source}
                ${evidence.status === 'expired' ? html`<app-badge variant="warn">原文已过期</app-badge>` : nothing}
                <time datetime=${evidence.collectedAt}>${displayTime(evidence.collectedAt)}</time>
              </summary>
              <p>${evidence.summary}</p>
              <dl><dt>观察窗口（本地时间）</dt><dd>${displayTime(evidence.observedFrom)} — ${displayTime(evidence.observedTo)}</dd></dl>
              <details><summary>原始标识与时间</summary>
                <dl>
                  <dt>证据标识</dt><dd>${evidence.id}</dd><dt>来源标识</dt><dd>${evidence.source}</dd>
                  <dt>内容哈希</dt><dd>${evidence.contentHash}</dd><dt>运行标识</dt><dd>${evidence.runId}</dd>
                  <dt>观察窗口（UTC）</dt><dd>${evidence.observedFrom ?? '未知'} — ${evidence.observedTo ?? '未知'}</dd>
                  <dt>采集时间（UTC）</dt><dd>${evidence.collectedAt}</dd>
                </dl>
              </details>
              ${evidence.status === 'available' ? html`
                <button class="btn btn-sm" type="button" ?disabled=${this.raw.locked} @click=${() => void this.readRaw(evidence)}>读取证据原文</button>
                ${this.rawId === evidence.id ? html`
                  ${this.raw.loading ? html`<p role="status">正在读取证据原文…</p>` : nothing}
                  ${this.raw.error ? html`<p role="alert">${this.raw.error}</p>` : nothing}
                  ${this.raw.data?.id === evidence.id ? this.raw.data.raw !== undefined
                    ? html`<pre>${JSON.stringify(this.raw.data.raw, null, 2)}</pre>`
                    : html`<p>当前记录未返回原文。</p>` : nothing}`
                  : nothing}`
                : nothing}
            </details>`) : this.evidenceState === 'ready' ? html`<p class="muted">暂无可查看证据。</p>` : nothing}
        </section>
      </app-card>`;
  }
}
