import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { OperationsResource, authorizedJson, operationLabels, resourceLabel, currentUserId, validRecord, type PlanRecord } from '../controllers/operations-api.ts';
import { hasSlidePermission } from '../app-settings.ts';
import { resourceDetailUrl } from '../components/resource-investigation-links.ts';
import { operationsStyles } from './operations-styles.ts';
import '../components/app-card.ts';
import '../components/app-badge.ts';
import '../components/app-empty-state.ts';
import '../components/app-dialog.ts';

interface PlanApproval { id: number | string; status: string; args_redacted: unknown; tool_name: string }
interface ApprovalPage { items: Array<PlanApproval & { kind?: string }> }
export function approvalPlanBinding(row: PlanApproval) {
  if (row.tool_name !== 'operations_action_plan' || !row.args_redacted || typeof row.args_redacted !== 'object') return null;
  const args = row.args_redacted as Record<string,unknown>;
  if (args.kind !== 'operations-action-plan-v1' || typeof args.planId !== 'string' || typeof args.version !== 'number' || typeof args.contentHash !== 'string') return null;
  return { planId:args.planId,version:args.version,contentHash:args.contentHash,approvalId:String(row.id),status:row.status };
}
@customElement('operations-actions')
export class OperationsActions extends LitElement {
  static styles = operationsStyles;
  @property({ attribute:false }) permissions: Set<string> | null = null;
  @state() private planId = '';
  @state() private approvalId = '';
  @state() private note = '';
  @state() private filter = 'pending';
  @state() private confirmAction: 'approve' | 'reject' | '' = '';
  @state() private editing = false;
  @state() private impact = '';
  @state() private formError = '';
  private plans = new OperationsResource<{plan:PlanRecord}>(this, () => this.clearDrafts());
  private approvals = new OperationsResource<ApprovalPage>(this, () => this.clearDrafts(), authorizedJson);
  private clearDrafts() { this.approvalId='';this.note='';this.confirmAction='';this.editing=false;this.impact='';this.formError=''; }
  private can(action:string) { return hasSlidePermission(this.permissions,`operations:actions:${action}`); }
  private pop = () => { this.plans.reset();this.planId=new URL(location.href).searchParams.get('plan') ?? '';if(this.planId) void this.open(this.planId,false); };
  connectedCallback() { super.connectedCallback();window.addEventListener('popstate',this.pop); }
  disconnectedCallback() { window.removeEventListener('popstate',this.pop);super.disconnectedCallback(); }
  protected firstUpdated() {
    this.planId=new URL(location.href).searchParams.get('plan') ?? '';
    if (this.planId) void this.open(this.planId,false);
    if (hasSlidePermission(this.permissions,'approval:view')) void this.loadApprovals();
  }
  private async loadApprovals() {
    await this.approvals.load(`/api/approval/unified?status=${this.filter}`);
    const p=this.plans.data?.plan;
    if(p) this.bindApproval(p);
  }
  private bindApproval(p:PlanRecord) {
    const binding=this.approvals.data?.items.filter(row=>row.kind==='agent').map(approvalPlanBinding).find(b=>b?.planId===p.id && b.version===p.version && b.contentHash===p.contentHash);
    this.approvalId=binding?.approvalId ?? '';
  }
  private async open(id:string,push=true) {
    this.clearDrafts();this.planId=id;
    if(push) { const u=new URL(location.href);u.searchParams.set('plan',id);history.pushState({},'',u); }
    const result=await this.plans.load(`/actions/plans/${encodeURIComponent(id)}`);
    if(result) this.bindApproval(result.plan);
  }
  private async submit() {
    const p=this.plans.data?.plan;if(!p)return;
    const result=await this.plans.write<{plan:PlanRecord;approvalId:string}>(`/actions/plans/${encodeURIComponent(p.id)}/submit`,{expectedVersion:p.version});
    if(result) { this.plans.data={plan:result.plan};this.approvalId=result.approvalId;this.requestUpdate();void this.loadApprovals(); }
  }
  private async review() {
    const p=this.plans.data?.plan, action=this.confirmAction;
    if(!p || !action || !this.note.trim() || !/^[1-9]\d{0,19}$/.test(this.approvalId)) return;
    this.confirmAction='';
    const result=await this.plans.write<{plan:PlanRecord}>(`/actions/plans/${encodeURIComponent(p.id)}/review`,{expectedVersion:p.version,approvalId:this.approvalId,action,note:this.note.trim()});
    if(result) { this.plans.data=result;this.note='';this.requestUpdate();void this.loadApprovals(); }
  }
  private async revise() {
    const p=this.plans.data?.plan;if(!p || !this.impact.trim())return;
    const {author:_a,requester:_r,validFrom:_f,validUntil:_u,...content}=p.content;
    const result=await this.plans.write<{plan:PlanRecord}>(`/actions/plans/${encodeURIComponent(p.id)}/versions`,{expectedVersion:p.version,content:{...content,impact:this.impact.trim()}});
    if(result) {this.plans.data=result;this.clearDrafts();this.requestUpdate();}
  }
  private renderPlan(p:PlanRecord) {
    const c=p.content,own=[c.author.id,c.requester.id].includes(currentUserId() ?? -1),fresh=validRecord(c);
    return html`<div class="layout"><div class="stack"><app-card><span slot="header">重启专用演练服务</span>
      <div class="toolbar" aria-label="行动步骤"><span>1 确认计划</span><span>2 独立审批</span><span>3 受控执行</span><span>4 效果验证</span></div>
      <dl><dt>目标资源</dt><dd><a href=${resourceDetailUrl(c.target.type,c.target.id)}>${resourceLabel(c.target)}</a></dd><dt>目标服务</dt><dd>${c.parameters.unit}</dd>
      <dt>预计影响</dt><dd>${c.impact}</dd><dt>风险</dt><dd>${operationLabels[c.risk] ?? c.risk}</dd><dt>有效期至</dt><dd>${new Date(c.validUntil).toLocaleString('zh-CN')}</dd><dt>回退能力</dt><dd>${c.rollback.description}</dd></dl>
      <p class="notice warn">重启不能恢复原进程状态。再次重启属于新的行动，需要新计划和新批准。</p>
      <a href=${`/investigations?investigation=${encodeURIComponent(c.investigationId)}`}>返回来源调查 · 结果版本 ${c.resultVersion}</a>
    </app-card><app-card><span slot="header">执行前置与验证标准</span><ul>${c.preconditions.map(v=>html`<li>${v.kind}：${v.expected}</li>`)}</ul>
      <dl><dt>执行前观测</dt><dd>${c.verifier.beforeSeconds} 秒</dd><dt>就绪等待</dt><dd>${c.verifier.readinessSeconds} 秒</dd><dt>恢复观察</dt><dd>${c.verifier.observationSeconds} 秒 · 每 ${c.verifier.intervalSeconds} 秒采样</dd><dt>额外重启上限</dt><dd>${c.verifier.maxExtraRestarts}</dd></dl>
      <p>执行成功与业务恢复分别判断；缺数据保持无法确认，未改善为验证失败。</p>
    </app-card><app-card><span slot="header">执行与恢复</span><app-empty-state title="执行入口尚未接入当前服务" description="批准不会自动执行。当前服务尚未提供执行请求、状态查询与原回执核对入口；不能据此推断已执行或已恢复。"></app-empty-state>
      <p class="muted">未知结果不重发。效果验证与人工结案需使用绑定本次执行的正式报告。</p>
    </app-card></div><aside class="stack"><app-card><span slot="header">不可变计划与职责分离</span><dl><dt>计划状态</dt><dd><app-badge variant=${p.state==='approved'&&fresh?'ok':'warn'}>${fresh?operationLabels[p.state]:'已过期'}</app-badge></dd><dt>当前版本</dt><dd>v${p.version}</dd><dt>作者</dt><dd>#${c.author.id}</dd><dt>提交者</dt><dd>#${c.requester.id}</dd></dl>
      <details><summary>计划标识、摘要与来源</summary><pre>${JSON.stringify({id:p.id,version:p.version,hash:p.contentHash,tool:c.tool,evidence:c.evidence,relations:c.relations,baselines:c.baselines},null,2)}</pre></details>
      ${p.state==='draft'&&this.can('propose') ? html`<button class="btn-primary" ?disabled=${this.plans.locked||!fresh} @click=${this.submit}>提交当前版本审批</button>`:nothing}
      ${this.can('propose') ? html`<button class="btn" ?disabled=${this.plans.locked} @click=${()=>{this.editing=true;this.impact=c.impact;}}>编辑为新计划版本</button>`:nothing}
      ${this.editing ? html`<label>预计影响<textarea aria-label="预计影响" maxlength="2000" .value=${this.impact} ?disabled=${this.plans.locked} @input=${(e:Event)=>this.impact=(e.target as HTMLTextAreaElement).value}></textarea></label><p class="notice warn">保存新版本使旧批准失效，必须重新提交审核。</p><button class="btn-primary" ?disabled=${this.plans.locked||!this.impact.trim()} @click=${this.revise}>保存新计划版本</button>`:nothing}
    </app-card>${p.state==='pending_approval'&&this.can('approve') ? html`<app-card><span slot="header">独立人工审批</span><p>提交者与作者不能自批。批准仅绑定当前内容版本，且仍需显式执行。</p>
      <label>审批记录号<input aria-label="审批记录号" inputmode="numeric" maxlength="20" .value=${this.approvalId} ?disabled=${this.plans.locked} @input=${(e:Event)=>this.approvalId=(e.target as HTMLInputElement).value}></label>
      <label>审批备注<textarea aria-label="审批备注" maxlength="1000" .value=${this.note} ?disabled=${this.plans.locked} @input=${(e:Event)=>this.note=(e.target as HTMLTextAreaElement).value}></textarea></label>
      <button class="btn-primary" ?disabled=${this.plans.locked||own||!fresh||!this.note.trim()||!/^[1-9]\d{0,19}$/.test(this.approvalId)} @click=${()=>this.confirmAction='approve'}>批准当前版本</button>
      <button class="btn" ?disabled=${this.plans.locked||own||!fresh||!this.note.trim()||!/^[1-9]\d{0,19}$/.test(this.approvalId)} @click=${()=>this.confirmAction='reject'}>驳回当前版本</button>
    </app-card>`:nothing}</aside></div>`;
  }
  render() {
    const p=this.plans, bindings=this.approvals.data?.items.filter(row=>row.kind==='agent').map(approvalPlanBinding).filter(b=>b!==null) ?? [];
    return html`<div class="heading"><div><h1>行动中心</h1><p class="muted">明确目标、独立批准、受控执行，分别核对执行与恢复。</p></div></div>
      <form class="toolbar" @submit=${(e:Event)=>{e.preventDefault();if(this.planId.trim())void this.open(this.planId.trim());}}><label>打开计划<input aria-label="打开计划" placeholder="输入计划标识" required maxlength="128" .value=${this.planId} @input=${(e:Event)=>this.planId=(e.target as HTMLInputElement).value}></label><button class="btn" ?disabled=${p.loading||p.writing||p.accessInvalidated}>读取计划</button>${p.data?html`<button class="btn btn-refresh" type="button" ?disabled=${p.loading||p.writing||p.accessInvalidated} @click=${()=>void this.open(p.data!.plan.id,false)}>刷新原计划</button>`:nothing}</form>
      ${p.error?html`<p role="alert">${p.error}</p>`:nothing}${p.mutationUnknown?html`<p class="notice warn" role="status">操作接受结果未知。仅可只读刷新核对原计划，当前页面不会重发。</p>`:nothing}${p.loading?html`<div class="skeleton" role="status">正在读取计划…</div>`:nothing}
      ${p.data?this.renderPlan(p.data.plan):html`<div class="layout"><section><app-card><span slot="header">已提交的行动计划</span><p class="muted">从现有统一审批记录发现已提交计划；未提交草稿与完整执行队列尚不可在此列出。</p>
        ${hasSlidePermission(this.permissions,'approval:view')?html`<div class="toolbar"><label>审批状态<select aria-label="行动审批状态" .value=${this.filter} ?disabled=${this.approvals.loading||this.approvals.accessInvalidated} @change=${(e:Event)=>{this.filter=(e.target as HTMLSelectElement).value;void this.loadApprovals();}}><option value="pending">待审批</option><option value="processed">已处理</option></select></label><button class="btn btn-refresh" ?disabled=${this.approvals.loading||this.approvals.accessInvalidated} @click=${this.loadApprovals}>刷新已提交计划</button></div>`:html`<p>需要审批查看权限才能发现已提交记录；仍可按计划标识读取授权内容。</p>`}
        ${this.approvals.loading?html`<p role="status">正在读取审批记录…</p>`:nothing}${this.approvals.error?html`<p role="alert">${this.approvals.error}</p>`:nothing}
        ${bindings.map(b=>html`<div class="row"><button class="btn-ghost" @click=${()=>void this.open(b.planId)}>计划 ${b.planId} · v${b.version}</button><span class="muted">${operationLabels[b.status]??b.status} · 打开后核对当前版本</span></div>`)}
        ${this.approvals.data&&!bindings.length?html`<app-empty-state title="没有可见的已提交计划" description="此结果不包含未提交草稿，也不代表没有在途执行。"></app-empty-state>`:nothing}
      </app-card></section><aside><app-card><span slot="header">行动边界</span><p>仅支持专用演练服务；计划变更后旧批准失效。未知回执需核对原动作，不提供执行重试。</p><a href="/investigations">返回 AI 工作空间</a></app-card></aside></div>`}
      <app-dialog .open=${!!this.confirmAction} title="确认当前计划审批" @app-dialog-close=${()=>this.confirmAction=''}><p>目标：${p.data?resourceLabel(p.data.plan.content.target):''} · 版本 ${p.data?.plan.version}</p><p class="notice warn">${p.data?.plan.content.rollback.description}</p><p>此批准不执行动作；更改版本后需重新审批。</p><div slot="footer"><button class="btn" @click=${()=>this.confirmAction=''}>取消</button><button class="btn-primary" ?disabled=${p.locked} @click=${this.review}>确认${this.confirmAction==='approve'?'批准':'驳回'}当前版本</button></div></app-dialog>`;
  }
}
