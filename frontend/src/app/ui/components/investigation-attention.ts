import { LitElement, html, nothing, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { OperationsResource, authorizedJson, operationLabels } from '../controllers/operations-api.ts';
import { operationsStyles } from '../views/operations-styles.ts';
import './app-card.ts';
import {openWorkbenchRecord, restoreWorkbenchPosition} from '../workbench-position.ts';
import { displayTime } from '../views/diagnosis-presentation.ts';
export interface WorkspaceDecisionSummary {
  conclusion: string|null; recommendation: string|null; asOf: string|null;
  sourceRef: {type:'investigation_result';id:string;version:number}|null;
  targetRef: {type:'server';id:number}|null; displayName:string|null; impact:string|null; stage:string|null;
}
export interface WorkspaceAttentionItem {
  decisionSummary?: WorkspaceDecisionSummary|null;
  planUpdatedAt?:string|null; expiresAt?:string|null;
  investigationId:string; investigationVersion:number; scopeVersion:string; resultId:string|null; resultVersion:number|null;
  context?:{from?:string;to?:string;entry?:{sourceEventIds?:number[]}}|null;
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
    .decision { --card:color-mix(in srgb,var(--accent) 9%,var(--bg-elevated)); --border:color-mix(in srgb,var(--accent) 24%,var(--bg-elevated)); }
    .decision h2 { font-size:clamp(24px,2vw,34px); line-height:1.43; margin:var(--space-md) 0; letter-spacing:-.7px; }
    .decision p { line-height:1.75; }
    .kicker { color:var(--accent); font-size:12px; font-weight:600; }
    .facts { border-top:1px solid var(--border); padding-top:var(--space-md); margin-top:var(--space-lg); font-size:12px; color:var(--muted); }
    .queue-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--space-md); padding-block:var(--space-md); border-bottom:1px solid var(--border); }
    .queue-row:last-child { border-bottom:0; }
    .queue-row h3 { font-size:16px; }
    .queue-row .meta { margin-top:var(--space-sm); }
    .unavailable { min-height:160px; display:grid; align-content:center; }
    .relations { display:grid; gap:var(--space-lg); }
    .relations p { margin:var(--space-xs) 0; }
    .scope { font-size:12px; color:var(--muted); }
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
    return html`<div class="toolbar"><button class="btn btn-refresh" ?disabled=${p.loading||p.accessInvalidated} @click=${()=>this.load()}>刷新待处理事项</button></div>
      ${p.loading ? html`<p role="status">正在核对原记录…</p>` : nothing}
      ${p.error ? html`<p role="alert">${p.error}</p>` : nothing}
      ${p.data && !p.loading ? html`
        ${first ? html`<div class="decision-grid">
          <app-card class="decision"><span slot="header">当前决策 · ${labels[first.kind]}</span>
            <h2>${first.decisionSummary?.conclusion || '尚未提供可靠结论'}</h2><p><b class="kicker">建议下一步</b> ${first.decisionSummary?.recommendation || '暂无可靠建议，请打开原记录核对依据与适用操作。'}</p>
            <p class="muted">计划阶段：${first.decisionSummary?.stage ? operationLabels[first.decisionSummary.stage] || '阶段未知' : '未提供'} · 有效期：${first.expiresAt ? displayTime(first.expiresAt) : '未提供'}</p>
            <a class="btn-primary" data-workbench-key=${first.investigationId} @click=${(e:MouseEvent)=>openWorkbenchRecord(e,attentionUrl(first),first.investigationId)} href=${attentionUrl(first)}>查看原记录</a>
            ${this.facts(first)}
          </app-card>
          <app-card><span slot="header">指标依据</span><div class="unavailable"><h3>暂无可信时序证据</h3><p class="muted">当前记录未提供可核对的指标、单位、观察窗口与样本，暂不展示趋势。</p></div></app-card>
        </div>` : html`<app-card><h2>本页没有可处理的事项</h2><p>当前授权范围内没有返回下一步，仍可在完整列表中查找历史记录。</p></app-card>`}
        ${p.data.unavailable ? html`<p class="notice warn" role="status">部分行动资格暂无法核验；请打开原调查核对，不代表没有待处理行动。</p>` : nothing}
        <div class="decision-grid">
          <app-card><span slot="header">其他待跟进事项 · 本页 ${Math.max(0,items.length-1)} 项</span>
            ${items.slice(1).map(item=>html`<article class="queue-row"><div><h3>${item.decisionSummary?.conclusion || '尚未提供可靠结论'}</h3><p>${item.decisionSummary?.recommendation || '建议未提供，请核对原记录。'}</p><p class="muted">${item.title}</p><div class="meta">调查更新 ${displayTime(item.updatedAt)} · ${labels[item.kind]}</div></div><a data-workbench-key=${item.investigationId} @click=${(e:MouseEvent)=>openWorkbenchRecord(e,attentionUrl(item),item.investigationId)} href=${attentionUrl(item)}>查看原记录</a></article>`)}
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
