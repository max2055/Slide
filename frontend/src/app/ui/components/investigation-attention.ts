import { LitElement, html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { OperationsResource, authorizedJson } from '../controllers/operations-api.ts';
import { operationsStyles } from '../views/operations-styles.ts';
import './app-card.ts';
export interface WorkspaceAttentionItem {
  investigationId:string; investigationVersion:number; scopeVersion:string; resultId:string|null; resultVersion:number|null;
  context?:{from?:string;to?:string;entry?:{sourceEventIds?:number[]}}|null;
  reportId?:string|null;reportVersion?:number|null;
  title:string; updatedAt:string; kind:'continue'|'approve'|'execute'|'verify'|'reconcile';
  planId:string|null; planVersion:number|null; planHash:string|null; approvalId:string|null; executionId:string|null;
}
interface Page {items:WorkspaceAttentionItem[];nextCursor:string|null;unavailable:boolean}
const labels={continue:'继续原调查',approve:'独立审批当前计划',execute:'核对已批准计划',verify:'核对原执行与效果验证',reconcile:'核对原执行回执'};
export function attentionUrl(item:WorkspaceAttentionItem) {
  const q=new URLSearchParams({investigation:item.investigationId,attentionVersion:String(item.investigationVersion),returnTo:'/investigations'});
  if(item.resultId)q.set('attentionResult',item.resultId);
  if(item.resultVersion!==null)q.set('attentionResultVersion',String(item.resultVersion));
  if(item.reportId){q.set('attentionReport',item.reportId);q.set('attentionReportVersion',String(item.reportVersion));}
  if(item.executionId)q.set('attentionExecution',item.executionId);
  if(item.kind==='continue'&&item.planId){q.set('attentionSourcePlan',item.planId);q.set('attentionSourcePlanVersion',String(item.planVersion));}
  if(!item.planId||item.kind==='continue')return `/investigations?${q}`;
  q.delete('investigation');q.set('sourceInvestigation',item.investigationId);q.set('plan',item.planId);
  q.set('attentionPlanVersion',String(item.planVersion));q.set('attentionPlanHash',item.planHash!);
  if(item.executionId)q.set('attentionExecution',item.executionId);
  if(item.approvalId)q.set('attentionApproval',item.approvalId);
  return `/operations-actions?${q}`;
}
/** A read projection, with its own server page. No client-wide list scan or task state. */
@customElement('investigation-attention')
export class InvestigationAttention extends LitElement {
  static styles=operationsStyles;
  private page=new OperationsResource<Page>(this,undefined,authorizedJson);
  protected firstUpdated(){void this.load();}
  private load(cursor?:string){return this.page.load(`/api/operations/workspace-attention?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);}
  render(){const p=this.page;return html`<app-card><span slot="header">需要你处理 · 原记录</span>
    <p>仅显示当前授权下可处理的原调查、审批与验证记录。打开后核对来源、范围及版本。</p>
    <button class="btn btn-refresh" ?disabled=${p.loading||p.accessInvalidated} @click=${()=>this.load()}>刷新待处理事项</button>
    ${p.loading?html`<p role="status">正在核对原记录…</p>`:nothing}${p.error?html`<p role="alert">${p.error}</p>`:nothing}
    ${p.data&&!p.loading?html`${p.data.items.map(item=>html`<div class="row"><a href=${attentionUrl(item)}>${labels[item.kind]} · ${item.title}</a>
      <p class="muted">${item.context?.entry?.sourceEventIds?.length?"来源：原事件 · ":""}${item.context?.from&&item.context?.to?`原窗口 ${item.context.from} — ${item.context.to} · `:""}原调查 V${item.investigationVersion}${item.resultVersion!==null?` · 结果 V${item.resultVersion}`:''}${item.planVersion!==null?` · 计划 V${item.planVersion}`:''} ${item.reportVersion?` · 验证报告 V${item.reportVersion}`:""} · 更新于 <time datetime=${item.updatedAt}>${item.updatedAt}</time></p></div>`)}
      ${!p.data.items.length?html`<p>此页没有可处理原记录。</p>`:nothing}
      ${p.data.unavailable?html`<p role="status">部分行动资格暂无法核验；请打开原调查核对，不代表没有待处理行动。</p>`:nothing}
      ${p.data.nextCursor?html`<p>当前为有界原记录页，继续翻页查看后续授权事项。</p><button class="btn" @click=${()=>this.load(p.data!.nextCursor!)}>下一页待处理事项</button>`:nothing}`:nothing}
  </app-card>`;}
}
