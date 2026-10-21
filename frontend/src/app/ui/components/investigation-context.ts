import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { InvestigationEvidence, InvestigationResultPage } from '../controllers/investigation-api.ts';
import './app-card.ts';
import './app-badge.ts';
import './app-empty-state.ts';
import './app-data-table.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';

@customElement('investigation-context')
export class InvestigationContext extends LitElement {
  @property({ attribute: false }) results: InvestigationResultPage = { items: [], nextBefore: null };
  @property({ attribute: false }) evidence: InvestigationEvidence[] = [];
  @property({ attribute: false }) onMore = () => {};
  @state() private selected = '';
  createRenderRoot() { return this; }
  render() {
    const version = this.results.items.find(r => r.id === this.selected) ?? this.results.items[0];
    const result = version?.result;
    const refs = (ids: string[]) => ids.map(id => html`<a href=${`#evidence-${id}`} @click=${(event: Event) => { event.preventDefault(); (event.currentTarget as HTMLElement).closest('investigation-context')?.querySelector(`[data-evidence="${id}"]`)?.scrollIntoView({ block: 'nearest' }); }}>证据 ${id.slice(0, 8)}</a> `);
    return html`
      <style>${sharedBtnStyles.cssText}
        investigation-context { display:block; min-width:0; overflow-wrap:anywhere; }
        investigation-context .context-stack { display:grid; gap:var(--space-md); }
        investigation-context select { max-width:100%; background:var(--input); color:var(--text); padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); }
        investigation-context h3 { font-size:var(--text-md); margin:var(--space-md) 0 var(--space-sm); }
        investigation-context p { white-space:pre-wrap; }
        investigation-context a { color:var(--accent); }
        investigation-context app-data-table { display:block; overflow:auto; }
        investigation-context .evidence-entry { border-top:1px solid var(--border); padding:var(--space-md) 0; scroll-margin-top:var(--space-xl); }
        investigation-context dt { color:var(--muted); } investigation-context dd { margin:0 0 var(--space-sm); }
      </style>
      <div class="context-stack">
        <app-card><span slot="header">证据与成果</span>
          ${result ? html`
            <label>结果版本 <select aria-label="结果版本" .value=${version.id} @change=${(e: Event) => this.selected = (e.target as HTMLSelectElement).value}>
              ${this.results.items.map(row => html`<option value=${row.id}>V${row.version} · ${row.runId.slice(0, 8)}</option>`)}
            </select></label>
            <p>${result.summary}</p>
            <app-badge variant="warn">${({ unverified: '根因待验证', supported: '有证据支持，待验证', human_confirmed: '人工确认', experimentally_verified: '实验验证' })[result.rootCauseVerification.status]}</app-badge>
            <h3>事实</h3>
            ${result.facts.length ? result.facts.map(fact => html`<p>${fact.statement}<br>${refs(fact.evidenceIds)}</p>`) : html`<p>暂无已绑定事实。</p>`}
            <h3>假设与反证</h3>
            ${result.hypotheses.map(h => html`<p>${h.statement}（${({ supported: '支持', refuted: '反驳', unknown: '未知' })[h.status]}）<br>支持：${refs(h.supportingEvidenceIds)}<br>反证：${refs(h.contradictingEvidenceIds)}</p>`)}
            ${result.claims.map(c => html`<p>${c.kind === 'fact' ? '事实' : '推断'}：${c.statement}<br>${refs(c.supportingEvidenceIds)} ${refs(c.contradictingEvidenceIds)}</p>`)}
            <h3>待确认问题</h3>${result.unresolvedQuestions.map(q => html`<p>${q}</p>`)}
            <h3>建议</h3>${result.recommendations.map(r => html`<p>${r.action}</p>`)}
            <details><summary>结果来源与技术详情</summary>
              <p>停止原因：${result.execution?.reasonCode ?? '历史记录未保留具体停止原因'}</p>
              <p>模型配置标识：${result.provenance.modelVersion === 'unavailable' ? '历史记录未保留' : result.provenance.modelVersion}</p>
              <p>提示词版本与哈希：${result.provenance.promptVersion === 'unavailable' ? '历史记录未保留' : result.provenance.promptVersion}</p>
              <p>用量记录：${({ available: '可用', unavailable: '不可用', partial: '部分可用' })[result.provenance.usageStatus]}</p>
            </details>
          ` : html`<app-empty-state title="暂无持久化成果" description="执行结束与业务恢复分别记录。"></app-empty-state>`}
          ${this.results.nextBefore ? html`<button class="btn" @click=${this.onMore}>加载更早结果版本</button>` : nothing}
        </app-card>
        <app-card><span slot="header">证据记录</span>
          <app-data-table .columns=${[{ key: 'source', label: '来源' }, { key: 'status', label: '状态' }]}
            .rows=${this.evidence.map((e, index) => ({ source: e.source.startsWith('tool:') ? `工具检查记录 ${index + 1}` : e.source, status: e.status === 'expired' ? '原文已过期' : '可用' }))} emptyMessage="暂无证据"></app-data-table>
          ${this.evidence.map((e, index) => html`<section class="evidence-entry" data-evidence=${e.id} aria-label=${`证据 ${e.id.slice(0, 8)}`}>
            <h3>${e.source.startsWith('tool:') ? `工具检查记录 ${index + 1}` : e.source}</h3><p>${e.summary}</p>
            <app-badge variant=${e.status === 'expired' ? 'warn' : 'muted'}>${e.status === 'expired' ? '原文已过期' : '引用已关联；不代表根因验证'}</app-badge>
            <dl><dt>观察窗口</dt><dd>${e.observedFrom ?? '未知'} — ${e.observedTo ?? '未知'}</dd><dt>采集时间</dt><dd>${e.collectedAt}</dd></dl>
            <details><summary>证据技术详情</summary><dl><dt>原始来源标识</dt><dd>${e.source}</dd><dt>内容哈希</dt><dd>${e.contentHash}</dd><dt>运行标识</dt><dd>${e.runId}</dd></dl></details>
          </section>`)}
        </app-card>
      </div>`;
  }
}
