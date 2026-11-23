import { LitElement, html, nothing, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { OperationsResource, authorizedJson, operationLabels } from '../controllers/operations-api.ts';
import { operationsStyles } from '../views/operations-styles.ts';
import './app-card.ts';
import {openWorkbenchRecord, restoreWorkbenchPosition} from '../workbench-position.ts';
import { displayTime } from '../views/diagnosis-presentation.ts';
import { investigationSubject, recordExcerpt } from '../views/record-summary.ts';
export interface WorkspaceDecisionSummary {
  conclusion: string|null; recommendation: string|null; asOf: string|null;
  sourceRef: {type:'investigation_result';id:string;version:number}|null;
  targetRef: {type:'server';id:number}|null; displayName:string|null; impact:string|null; stage:string|null;
}
export interface WorkspaceAttentionItem {
  decisionSummary?: WorkspaceDecisionSummary|null;
  planUpdatedAt?:string|null; expiresAt?:string|null;
  investigationId:string; investigationVersion:number; scopeVersion:string; resultId:string|null; resultVersion:number|null;
  context?:{from?:string;to?:string;entry?:{sourceEventIds?:number[];metric?:{id:string}}}|null;
  reportId?:string|null;reportVersion?:number|null;
  title:string; updatedAt:string; kind:'continue'|'approve'|'execute'|'verify'|'reconcile';
  planId:string|null; planVersion:number|null; planHash:string|null; approvalId:string|null; executionId:string|null;
}
interface Page {items:WorkspaceAttentionItem[];nextCursor:string|null;unavailable:boolean}
const labels={continue:'继续原调查',approve:'独立审批当前计划',execute:'核对已批准计划',verify:'核对原执行与效果验证',reconcile:'核对原执行回执'};
export function attentionUrl(item:WorkspaceAttentionItem) {
  const source=new URL(location.href);
  const returnTo=source.pathname==='/workbench' && source.searchParams.get('workspaceTab')==='home' ? source.pathname+source.search : '/workbench';
  const q=new URLSearchParams({investigation:item.investigationId,attentionVersion:String(item.investigationVersion),returnTo});
  if(item.resultId)q.set('attentionResult',item.resultId);
  if(item.resultVersion!==null)q.set('attentionResultVersion',String(item.resultVersion));
  if(item.reportId){q.set('attentionReport',item.reportId);q.set('attentionReportVersion',String(item.reportVersion));}
  if(item.executionId)q.set('attentionExecution',item.executionId);
  if(item.kind==='continue'&&item.planId){q.set('attentionSourcePlan',item.planId);q.set('attentionSourcePlanVersion',String(item.planVersion));}
  if(!item.planId||item.kind==='continue')return `/workbench?${q}`;
  q.delete('investigation');q.set('sourceInvestigation',item.investigationId);q.set('plan',item.planId);
  q.set('attentionPlanVersion',String(item.planVersion));q.set('attentionPlanHash',item.planHash!);
  if(item.executionId)q.set('attentionExecution',item.executionId);
  if(item.approvalId)q.set('attentionApproval',item.approvalId);
  return `/workbench?workspaceTab=actions&${q}`;
}
/** A read projection, with its own server page. No client-wide list scan or task state. */
@customElement('investigation-attention')
export class InvestigationAttention extends LitElement {
  @property({type:Boolean}) canViewActions = false;
  static styles=[operationsStyles, css`
    .decision-grid { display:grid; grid-template-columns:minmax(0,1.98fr) minmax(280px,1fr); gap:var(--space-lg); margin-block:var(--space-lg); align-items:start; }
    .decision { --border:color-mix(in srgb,var(--accent) 24%,var(--bg-elevated)); }
    .decision h2 { font-size:var(--text-xl); line-height:1.4; margin:0 0 var(--space-sm); overflow-wrap:anywhere; }
    .decision p { margin:var(--space-sm) 0; }
    .decision .next { border-top:1px solid var(--border); padding-top:var(--space-sm); margin-top:var(--space-md); }
    .decision details { margin-bottom:0; }
    .facts { font-size:var(--text-sm); color:var(--muted); overflow-wrap:anywhere; }
    .queue-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--space-md); padding-block:var(--space-md); border-bottom:1px solid var(--border); }
    .queue-row:last-child { border-bottom:0; }
    .queue-row h3 { font-size:16px; }
    .queue-row .meta { margin-top:var(--space-sm); }
    .relations { display:grid; gap:var(--space-lg); }
    .relations p { margin:var(--space-xs) 0; }
    .scope { font-size:12px; color:var(--muted); }
    @media(max-width:950px) { .decision-grid { grid-template-columns:minmax(0,1fr); } }
  `];
  private page=new OperationsResource<Page>(this,undefined,authorizedJson);
  protected firstUpdated(){void this.load(new URL(location.href).searchParams.get('attentionCursor') ?? undefined,false);}
  private load(cursor?:string, updateUrl=true){
    if(updateUrl && location.pathname==='/workbench') {
      const url=new URL(location.href);
      if(cursor) {url.searchParams.set('workspaceTab','home');url.searchParams.set('attentionCursor',cursor);}
      else url.searchParams.delete('attentionCursor');
      history.replaceState(history.state,'',url);
    }
    return this.page.load(`/api/operations/workspace-attention?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);}
  protected updated() { if(this.page.data && !this.page.loading) restoreWorkbenchPosition(this.shadowRoot!); }
  private facts(item: WorkspaceAttentionItem) {
    return html`<div class="facts">来源调查：${item.title} · V${item.investigationVersion}<br>
      调查更新 <time datetime=${item.updatedAt}>${displayTime(item.updatedAt)}</time>
      ${item.planId ? html`<br>计划 V${item.planVersion} · 计划更新时间：${item.planUpdatedAt ? displayTime(item.planUpdatedAt) : '未提供'}` : nothing}
      ${item.resultVersion !== null ? html` · 结果 V${item.resultVersion}` : nothing}
      ${item.decisionSummary?.sourceRef ? html`<br>摘要来源：结果 V${item.decisionSummary.sourceRef.version} · 结果记录时间 ${item.decisionSummary.asOf ? displayTime(item.decisionSummary.asOf) : '未提供'}` : nothing}
      ${item.reportVersion ? html` · 验证报告 V${item.reportVersion}` : nothing}</div>`;
  }
  render() {
    const p=this.page, items=p.data?.items ?? [], first=items[0];
    const conclusion = first?.decisionSummary?.conclusion?.trim() || '尚未提供可靠结论';
    const recommendation = first?.decisionSummary?.recommendation?.trim() || '暂无可靠建议，请打开原记录核对依据与适用操作。';
    const shortConclusion = recordExcerpt(conclusion);
    const shortRecommendation = recordExcerpt(recommendation, 100);
    return html`<div class="toolbar"><button class="btn btn-refresh" ?disabled=${p.loading||p.accessInvalidated} @click=${()=>this.load()}>刷新待处理事项</button></div>
      ${p.loading ? html`<p role="status">正在核对原记录…</p>` : nothing}
      ${p.error ? html`<p role="alert">调查与处置待办清单读取失败。${p.error}</p>` : nothing}
      ${p.data && !p.loading ? html`
        ${first ? html`<div class="decision-grid">
          <app-card class="decision"><span slot="header">当前待跟进</span>
            <h2>${recordExcerpt(investigationSubject(first.title, first.context?.entry), 80)}</h2>
            <p class="meta"><app-badge variant="info">${labels[first.kind]}</app-badge>
              ${first.decisionSummary?.stage ? html`<span>${operationLabels[first.decisionSummary.stage] || '阶段未知'}</span>` : nothing}
              ${first.resultVersion !== null ? html`<span>已保存结果 V${first.resultVersion}</span>` : html`<span>暂无已保存结果</span>`}
              ${first.expiresAt ? html`<span>有效期 ${displayTime(first.expiresAt)}</span>` : nothing}
            </p>
            <p><strong>当前结论</strong> ${shortConclusion}</p>
            <p class="next"><strong>建议下一步</strong> ${shortRecommendation}</p>
            <a class="btn-primary" data-workbench-key=${first.investigationId} @click=${(e:MouseEvent)=>openWorkbenchRecord(e,attentionUrl(first),first.investigationId)} href=${attentionUrl(first)}>查看原记录</a>
            ${shortConclusion !== conclusion || shortRecommendation !== recommendation ? html`<details><summary>展开完整结论与建议</summary>
              <p>${conclusion}</p><p>${recommendation}</p></details>` : nothing}
          </app-card>
          <app-card><span slot="header">记录来源</span>${this.facts(first)}<p class="muted">结论引用的证据可在原记录核对。</p></app-card>
        </div>` : html`<app-card><h2>本页没有可处理的事项</h2><p>当前授权范围内没有返回下一步，仍可在完整列表中查找历史记录。</p></app-card>`}
        ${p.data.unavailable ? html`<p class="notice warn" role="status">部分行动资格暂无法核验；请打开原调查核对，不代表没有待处理行动。</p>` : nothing}
        <div class="decision-grid">
          <app-card><span slot="header">其他待跟进事项 · 本页 ${Math.max(0,items.length-1)} 项</span>
            ${items.slice(1).map(item=>html`<article class="queue-row"><div><h3>${recordExcerpt(item.title, 80)}</h3><p>${recordExcerpt(item.decisionSummary?.conclusion || '尚未提供可靠结论')}</p><div class="meta">调查更新 ${displayTime(item.updatedAt)} · ${labels[item.kind]}</div></div><a data-workbench-key=${item.investigationId} @click=${(e:MouseEvent)=>openWorkbenchRecord(e,attentionUrl(item),item.investigationId)} href=${attentionUrl(item)}>查看原记录</a></article>`)}
            ${items.length <= 1 ? html`<p class="muted">本页没有其他待跟进事项。</p>` : nothing}
            <p class="scope">每调查一个当前下一步；不是完整行动清单，不代表全域总量或优先级。</p>
            ${p.data.nextCursor ? html`<button class="btn" @click=${()=>this.load(p.data!.nextCursor!)}>下一页待处理事项</button>` : nothing}
          </app-card>
          <app-card><span slot="header">关联对象与完整列表</span><div class="relations">
            ${first ? html`<div><b>${first.decisionSummary?.displayName || '目标名称未提供'}</b><p class="muted">${first.decisionSummary?.targetRef ? `server:${first.decisionSummary.targetRef.id}` : '到原记录核对授权资源。'}</p></div><div><b>${first.title}</b><p class="muted">来源调查 · ${first.investigationId}</p></div>` : nothing}
            <a href="/workbench?workspaceTab=investigations">完整调查列表</a>
            ${this.canViewActions ? html`<a href="/workbench?workspaceTab=actions">完整行动列表</a>` : nothing}
          </div></app-card>
        </div>` : nothing}`;
  }
}
