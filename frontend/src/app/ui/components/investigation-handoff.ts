import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { InvestigationRecord } from '../controllers/investigation-api.ts';
import type { InvestigationResultPage } from '../../../api/generated/public-api.ts';
import type { InvestigationFeedbackRecord } from '../../../api/generated/public-api.ts';
import {OperationsResource,authorizedJson,operationLabels,type PlanRecord} from '../controllers/operations-api.ts';
import { operationsStyles } from '../views/operations-styles.ts';
import './app-card.ts';

type Result = InvestigationResultPage['items'][number];
/** A projection of persisted records. No model, new fact, case publication or lifecycle write. */
export function handoffText(detail: InvestigationRecord, result?: Result): string {
  const lines = [`调查交接草案：${detail.title}`, `来源调查：${detail.id} · 调查版本 ${detail.version}`,
    `绝对窗口：${detail.context?.from??'未记录'} — ${detail.context?.to??'未记录'}`,
    `来源事件：${detail.context?.entry?.sourceEventIds.join('、')||'未关联事件'}`, `返回来源：${detail.context?.entry?.returnTo??'原调查'}`,
    `目标：${detail.goal}`, `对象：${detail.resources.map(r => `${r.type}:${r.id}`).join('、') || '平台范围以原调查为准'}`,
    `调查状态：${detail.lifecycle}；业务状态：${detail.problemStatus}；执行与恢复分别核对。`,
    '影响边界：此草案不新增影响结论；按原对象、窗口和证据独立核对。',
    '下一位处理人：尚未指定，交接前确认；本草案不分配权限。'];
  if (!result) return [...lines, '暂无已保存结果；不得推定根因或恢复。'].join('\n');
  const r = result.result;
  lines.push(`结果 V${result.version}：${result.id} · Run ${result.runId}`, `保存时间：${r.createdAt}`, `当前判断（原结果）：${r.summary}`,
    '原结果陈述与证据引用（尚需核对，模型输出不等于事实）：', ...r.facts.map(f => `- ${f.statement}；证据：${f.evidenceIds.join('、') || '未绑定'}`),
    '反证引用：', ...(r.claims??[]).filter(c => c.contradictingEvidenceIds.length).map(c => `- ${c.contradictingEvidenceIds.join('、')}`),
    '尚待核实的缺口：', ...(r.unresolvedQuestions.length ? r.unresolvedQuestions.map(q => `- ${q}`) : ['未记录具体缺口，不代表证据充分。']),
    '原结果建议（未执行）：', ...r.recommendations.map(item => `- ${item.action}`),
    '证据有效期、后续批准、行动执行与恢复报告请在原记录核对；本草案不作恢复证明。');
  return lines.join('\n');
}
@customElement('investigation-handoff')
export class InvestigationHandoff extends LitElement {
  static styles = operationsStyles;
  @property({attribute:false}) detail?: InvestigationRecord;
  @property({attribute:false}) result?: Result;
  @state() private copied = false;
  @state() private error = '';
  private epoch = 0;
  private workflow = new OperationsResource<import('./investigation-workflow.ts').WorkflowPage>(this,undefined,authorizedJson);
  private actions = new OperationsResource<{items:PlanRecord[];nextCursor:string|null;partial?:boolean}>(this,undefined,authorizedJson);
  private feedback = new OperationsResource<{items:InvestigationFeedbackRecord[];nextBefore:number|null}>(this,undefined,authorizedJson);
  private async readReferences() {
    if(!this.detail)return;
    this.epoch++;this.copied=false;this.error='';
    const id=encodeURIComponent(this.detail.id);
    await Promise.allSettled([this.workflow.load(`/api/investigations/${id}/workflow`),this.actions.load(`/api/operations/actions/plans?investigationId=${id}&limit=20`),
      this.feedback.load(`/api/investigations/${id}/feedback`)]);
  }
  private text() {
    if(!this.detail)return '';
    const plans=this.actions.data,records=this.feedback.data;
    return [handoffText(this.detail,this.result), '范围与无行动复测（原回执）：',...(this.workflow.data?this.workflow.data.receipts.map(r=>`- ${r.kind} · 调查 V${r.version} · ${r.createdAt} · ${r.conclusion??'范围已确认'} · ${r.from??''} — ${r.to??''}；缺口 ${(r.gaps??[]).join('、')}`):[this.workflow.error?'范围/复测记录读取失败。':'尚未读取范围与复测记录。']),...(this.workflow.data?.nextBefore?['范围/复测仅载入当前页。']:[]), '关联行动（原记录投影）：',
      ...(plans?plans.items.length?plans.items.map(p=>`- 计划 ${p.id} V${p.version} · 来源结果 V${p.content.resultVersion} · ${operationLabels[p.state]??p.state}；执行记录 ${p.executions?.map(e=>`${e.id}：${operationLabels[e.state]??e.state}`).join('；')||'本页未载入'}；执行与恢复分别核对。`):['本次授权查询未返回计划，不推定没有不可见记录。']:[this.actions.error?'行动读取失败或无权限，请核对原记录。':'尚未读取关联行动。']),
      ...(plans?.nextCursor||plans?.partial?['行动仅载入当前页，存在未展开的记录。']:[]),
      '人工记录（原记录投影）：',
      ...(records?records.items.length?records.items.map(r=>`- 记录 ${r.id} · 结果 V${r.command.resultVersion} · ${r.command.kind} · ${r.createdAt}：${r.command.note}${r.staleResult?'（旧结果）':''}${r.staleVerification?'（验证已失效，不能证明当前恢复）':''}`):['当前页暂无人工记录。']:[this.feedback.error?'人工记录读取失败或无权限。':'尚未读取人工记录。']),
      ...(records?.nextBefore?['人工记录仅载入当前页，存在更早记录。']:[]),
    ].join('\n');
  }
  protected willUpdate(changed:Map<string,unknown>) {
    if(changed.has('detail')||changed.has('result')) {
      this.epoch++;this.copied=false;this.error='';
      const previous=changed.get('detail') as InvestigationRecord|undefined;
      const previousResult=changed.get('result') as Result|undefined;
      if(changed.has('detail')&&(previous?.id!==this.detail?.id||previous?.version!==this.detail?.version)
        ||changed.has('result')&&previousResult?.id!==this.result?.id){this.actions.reset();this.feedback.reset();this.workflow.reset();}
    }
  }
  disconnectedCallback() {this.epoch++;super.disconnectedCallback();}
  private async copy() {
    if(!this.detail)return;
    const epoch=this.epoch, text=this.text();
    try {await navigator.clipboard.writeText(text);if(epoch===this.epoch)this.copied=true;}
    catch {if(epoch===this.epoch)this.error='未能复制，请展开草案后选择文字复制。';}
  }
  render() {
    if(!this.detail)return nothing;
    return html`<app-card><span slot="header">交接草案</span><p>从当前已加载记录整理，交接前核对原始证据与最新行动记录；不会调用模型或发布案例。</p>
      <button class="btn btn-refresh" ?disabled=${this.actions.locked||this.feedback.locked||this.workflow.locked} @click=${this.readReferences}>读取关联行动与人工记录</button>
      ${this.actions.loading||this.feedback.loading||this.workflow.loading?html`<p role="status">正在读取原记录…</p>`:nothing}
      ${this.actions.error?html`<p role="status">${this.actions.error}</p>`:nothing}${this.feedback.error?html`<p role="status">${this.feedback.error}</p>`:nothing}
      ${this.actions.data?.items.length?html`<section aria-label="原计划待办投影"><h3>关联原计划记录</h3>${this.actions.data.items.filter(p=>['pending_approval','approved'].includes(p.state)).map(p=>html`<p><a href=${`/operations-actions?plan=${encodeURIComponent(p.id)}`}>${p.content.resultVersion!==this.result?.version?'旧结果计划，仅供核对':p.state==='pending_approval'?'计划等待独立审批':'计划已批准，请核对原执行与验证状态'} · V${p.version}</a></p>`)}</section>`:nothing}
      <details><summary>核对交接内容</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${this.text()}</pre></details>
      <button class="btn" @click=${this.copy}>复制交接草案</button>${this.copied?html`<p role="status">已复制当前草案。</p>`:nothing}
      ${this.error?html`<p role="alert">${this.error}</p>`:nothing}</app-card>`;
  }
}
