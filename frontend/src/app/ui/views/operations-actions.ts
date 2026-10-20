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
import '../components/investigation-feedback.ts';

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
  @state() private investigation = '';
  @state() private stateFilter = '';
  @state() private draftResult = 1;
  @state() private draftTarget = 0;
  @state() private draftImpact = '';
  @state() private executionIds: string[] = [];
  private discovery = new OperationsResource<{items:PlanRecord[];partial:boolean;nextCursor:string|null;authorizedCounts:{total:number}}>(this);

  private plans = new OperationsResource<{plan:PlanRecord}>(this, () => this.clearDrafts());
  private approvals = new OperationsResource<ApprovalPage>(this, () => this.clearDrafts(), authorizedJson);
  private clearDrafts() { this.approvalId='';this.note='';this.confirmAction='';this.editing=false;this.impact='';this.formError=''; }
  private can(action:string) { return hasSlidePermission(this.permissions,`operations:actions:${action}`); }
  private pop = () => { this.plans.reset();this.planId=new URL(location.href).searchParams.get('plan') ?? '';if(this.planId) void this.open(this.planId,false); };
  connectedCallback() { super.connectedCallback();window.addEventListener('popstate',this.pop); }
  disconnectedCallback() { window.removeEventListener('popstate',this.pop);super.disconnectedCallback(); }
  protected firstUpdated() {
    this.planId=new URL(location.href).searchParams.get('plan') ?? '';
    this.investigation=new URL(location.href).searchParams.get('sourceInvestigation') ?? '';
    if (this.planId) void this.open(this.planId,false); else void this.discover();
    if (hasSlidePermission(this.permissions,'approval:view')) void this.loadApprovals();
  }
  private async loadApprovals() {
    await this.approvals.load(`/api/approval/unified?status=${this.filter}`);
    const p=this.plans.data?.plan;
    if(p) this.bindApproval(p);
  }
  private bindApproval(p:PlanRecord) {
    const binding=this.approvals.data?.items.filter(row=>row.kind==='agent').map(approvalPlanBinding).find(b=>b?.planId===p.id && b.version===p.version && b.contentHash===p.contentHash);
    if(binding)this.approvalId=binding.approvalId;
  }
  private async open(id:string,push=true) {
    this.clearDrafts();this.executionIds=[];this.planId=id;
    if(push) { const u=new URL(location.href);u.searchParams.set('plan',id);history.pushState({},'',u); }
    const result=await this.plans.load(`/actions/plans/${encodeURIComponent(id)}`);
    if(result) {
      this.bindApproval(result.plan);
      if(result.plan.state==='approved' && this.filter!=='processed'){this.filter='processed';void this.loadApprovals();}
      const page=await this.discovery.load(`/actions/plans?planId=${encodeURIComponent(id)}`);
      if(this.plans.data?.plan.id===id) {const current=page?.items?.find(p=>p.id===id);this.executionIds=current?.executions?.map(e=>e.id) ?? [];if(current?.approvalId)this.approvalId=current.approvalId;}
    }
  }
  private async discover(cursor?:string) {
    const q=new URLSearchParams({limit:'20'});
    if(this.investigation.trim())q.set('investigationId',this.investigation.trim());
    if(this.stateFilter)q.set('state',this.stateFilter);
    if(cursor)q.set('cursor',cursor);
    await this.discovery.load(`/actions/plans?${q}`);
  }
  private async draft() {
    if(!this.investigation.trim()||!this.draftTarget||!this.draftImpact.trim())return;
    const value=await this.plans.write<{plan:PlanRecord}>('/actions/drafts',{investigationId:this.investigation.trim(),resultVersion:this.draftResult,targetId:this.draftTarget,impact:this.draftImpact.trim()});
    if(value)await this.open(value.plan.id);
  }
  private discoveryView() {
    const d=this.discovery;
    return html`<app-card><span slot="header">行动计划</span><div class="toolbar"><label>来源调查<input aria-label="计划来源调查" .value=${this.investigation} @input=${(e:Event)=>this.investigation=(e.target as HTMLInputElement).value}></label>
      <label>计划状态<select aria-label="计划状态筛选" .value=${this.stateFilter} @change=${(e:Event)=>{this.stateFilter=(e.target as HTMLSelectElement).value;void this.discover();}}><option value="">全部状态</option>${['draft','pending_approval','approved','rejected','expired'].map(s=>html`<option value=${s}>${operationLabels[s]}</option>`)}</select></label><button class="btn btn-refresh" ?disabled=${d.locked} @click=${()=>this.discover()}>查找计划</button></div>
      ${d.loading?html`<p role="status">正在查找计划…</p>`:nothing}${d.error?html`<p role="alert">${d.error}</p>`:nothing}
      ${d.data?.items?.map(p=>html`<div class="row"><button class="btn-ghost" @click=${()=>void this.open(p.id)}>计划 ${p.id} · v${p.version}</button><span>${operationLabels[p.state]}</span><p>${p.content.impact}</p><p class="muted">${p.executions?.map(e=>`v${e.planVersion} · ${operationLabels[e.state]??e.state}`).join('；')||'暂无可见执行记录'}</p></div>`)}
      ${d.data?.items?.length===0?html`<app-empty-state title="没有匹配计划" description="仅显示当前授权范围。"></app-empty-state>`:nothing}
      ${d.data?.partial?html`<p class="notice warn">当前窗口不完整；本页 ${d.data.authorizedCounts.total} 条可见计划，请继续翻页。</p>`:nothing}
      ${d.data?.nextCursor?html`<button class="btn" ?disabled=${d.locked} @click=${()=>this.discover(d.data!.nextCursor!)}>下一页计划</button>`:nothing}
    </app-card>${this.can('propose')?html`<app-card><span slot="header">从当前调查创建草案</span><p>服务器解析已注册工具、策略和验证器；创建草案后仍需独立审批与显式执行。</p>
      <label>当前结果版本<input aria-label="草案结果版本" type="number" min="1" .value=${String(this.draftResult)} @input=${(e:Event)=>this.draftResult=Number((e.target as HTMLInputElement).value)}></label>
      <label>目标服务器<input aria-label="草案目标服务器" type="number" min="1" .value=${String(this.draftTarget||'')} @input=${(e:Event)=>this.draftTarget=Number((e.target as HTMLInputElement).value)}></label>
      <label>预计影响<textarea aria-label="草案预计影响" maxlength="2000" .value=${this.draftImpact} @input=${(e:Event)=>this.draftImpact=(e.target as HTMLTextAreaElement).value}></textarea></label>
      <button class="btn-primary" ?disabled=${this.plans.locked||!this.investigation||!this.draftTarget||!this.draftImpact.trim()} @click=${this.draft}>创建可信来源草案</button></app-card>`:nothing}`;
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
    </app-card><operations-action-outcome .plan=${p} .approvalId=${this.approvalId} .executionIds=${this.executionIds} .canExecute=${this.can("execute")} .blocked=${this.plans.locked}></operations-action-outcome></div><aside class="stack"><app-card><span slot="header">不可变计划与职责分离</span><dl><dt>计划状态</dt><dd><app-badge variant=${p.state==='approved'&&fresh?'ok':'warn'}>${fresh?operationLabels[p.state]:'已过期'}</app-badge></dd><dt>当前版本</dt><dd>v${p.version}</dd><dt>作者</dt><dd>#${c.author.id}</dd><dt>提交者</dt><dd>#${c.requester.id}</dd></dl>
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
      ${p.data?this.renderPlan(p.data.plan):html`<div class="layout"><section>${this.discoveryView()}<app-card><span slot="header">统一审批记录</span><p class="muted">审批记录保留审核历史；计划与执行请使用上方授权列表。</p>
        ${hasSlidePermission(this.permissions,'approval:view')?html`<div class="toolbar"><label>审批状态<select aria-label="行动审批状态" .value=${this.filter} ?disabled=${this.approvals.loading||this.approvals.accessInvalidated} @change=${(e:Event)=>{this.filter=(e.target as HTMLSelectElement).value;void this.loadApprovals();}}><option value="pending">待审批</option><option value="processed">已处理</option></select></label><button class="btn btn-refresh" ?disabled=${this.approvals.loading||this.approvals.accessInvalidated} @click=${this.loadApprovals}>刷新已提交计划</button></div>`:html`<p>需要审批查看权限才能发现已提交记录；仍可按计划标识读取授权内容。</p>`}
        ${this.approvals.loading?html`<p role="status">正在读取审批记录…</p>`:nothing}${this.approvals.error?html`<p role="alert">${this.approvals.error}</p>`:nothing}
        ${bindings.map(b=>html`<div class="row"><button class="btn-ghost" @click=${()=>void this.open(b.planId)}>审批记录 ${b.approvalId} · 计划 ${b.planId} · v${b.version}</button><span class="muted">${operationLabels[b.status]??b.status} · 打开后核对当前版本</span></div>`)}
        ${this.approvals.data&&!bindings.length?html`<app-empty-state title="没有可见的已提交计划" description="此结果不包含未提交草稿，也不代表没有在途执行。"></app-empty-state>`:nothing}
      </app-card></section><aside><app-card><span slot="header">行动边界</span><p>仅支持专用演练服务；计划变更后旧批准失效。未知回执需核对原动作，不提供执行重试。</p><a href="/investigations">返回 AI 工作空间</a></app-card></aside></div>`}
      <app-dialog .open=${!!this.confirmAction} title="确认当前计划审批" @app-dialog-close=${()=>this.confirmAction=''}><p>目标：${p.data?resourceLabel(p.data.plan.content.target):''} · 版本 ${p.data?.plan.version}</p><p class="notice warn">${p.data?.plan.content.rollback.description}</p><p>此批准不执行动作；更改版本后需重新审批。</p><div slot="footer"><button class="btn" @click=${()=>this.confirmAction=''}>取消</button><button class="btn-primary" ?disabled=${p.locked} @click=${this.review}>确认${this.confirmAction==='approve'?'批准':'驳回'}当前版本</button></div></app-dialog>`;
  }
}

interface ExecutionView { id:string; version:number; planId:string; planVersion:number; operationId:string; state:string; sentAt:string|null; receipt:unknown; errorCode:string|null; cancelRequestedAt:string|null }
interface ReportView {planId:string;planVersion:number;id:string;version:number;contentHash:string;state:string;reason:string|null;executionId:string;investigationId:string;resultVersion:number;investigationVersion:number;
  observedFrom:string|null;observedUntil:string|null;validUntil:string;missingSamples:number;evidence:Array<{id:string}>;before:unknown[];readiness:unknown[];observation:unknown[]}
interface OutcomeInvestigation {id:string;version:number;lifecycle:string;activeRequestId:string|null;latestResult:{id:string;version:number}|null}
/** Explicit commands only. Reading a receipt never enqueues another action. */
@customElement('operations-action-outcome')
export class OperationsActionOutcome extends LitElement {
  static styles=operationsStyles;
  @property({attribute:false}) plan!:PlanRecord;
  @property() approvalId='';
  @property({attribute:false}) executionIds:string[]=[];
  @property({type:Boolean}) canExecute=false;
  @property({type:Boolean}) blocked=false;
  @state() private selected='';
  @state() private confirm=false;
  @state() private reportVersion=0;
  private execution=new OperationsResource<{execution:ExecutionView}>(this,()=>{this.confirm=false;});
  private report=new OperationsResource<{verification:ReportView}>(this);
  private investigation=new OperationsResource<OutcomeInvestigation>(this,()=>{},authorizedJson);
  protected willUpdate(changed:Map<string,unknown>) {
    if(changed.has('plan')) {this.execution.reset();this.report.reset();this.investigation.reset();this.selected='';this.reportVersion=0;this.confirm=false;}
  }
  private async read(id=this.selected) {
    if(!id)return;this.selected=id;this.reportVersion=0;this.report.reset();
    const result=await this.execution.load(`/action-executions/${encodeURIComponent(id)}`);
    if(result && result.execution.planId===this.plan.id) {
      await this.report.load(`/action-executions/${encodeURIComponent(id)}/verification`);
      if(this.selected===id)await this.investigation.load(`/api/investigations/${encodeURIComponent(this.plan.content.investigationId)}`);
    } else if(result) this.execution.invalidate('执行不属于当前计划版本。');
  }
  private async execute() {
    if(!this.canExecute||this.blocked||this.execution.locked||this.plan.state!=='approved'||!validRecord(this.plan.content)||!this.approvalId)return;
    this.confirm=false;
    const result=await this.execution.write<{execution:ExecutionView}>(`/action-plans/${encodeURIComponent(this.plan.id)}/versions/${this.plan.version}/execute`,{approvalId:this.approvalId,requestKey:crypto.randomUUID()});
    if(result) {this.selected=result.execution.id;this.execution.data=result;this.requestUpdate();}
  }
  private async command(kind:'cancel'|'reconcile') {
    if(!this.selected||!this.canExecute)return;
    const result=await this.execution.write<{execution:ExecutionView}>(`/action-executions/${encodeURIComponent(this.selected)}/${kind}`,{});
    if(result) {this.execution.data=result;this.requestUpdate();await this.report.load(`/action-executions/${encodeURIComponent(this.selected)}/verification`);}
    else if(!this.execution.mutationUnknown&&!this.execution.accessInvalidated) {
      // A rejected receipt check grants no result. Restore the original record
      // with a read so an explicit rejection cannot erase the unknown state.
      const error=this.execution.error;await this.read();
      this.execution.error=kind==='reconcile'?'尚无可核验的原回执，执行结果保持未知。':error;this.requestUpdate();
    }
  }
  private async reopen() {
    const inv=this.investigation.data;if(!inv)return;
    const value=await this.investigation.write<OutcomeInvestigation>(`/api/investigations/${encodeURIComponent(inv.id)}`,{expectedVersion:inv.version,lifecycle:'open'},'PATCH');
    if(value){this.investigation.data=value;this.report.invalidate('调查已重开，原报告不能再用于确认恢复或结案。');this.requestUpdate();}
  }
  private async history(version:number) {
    if(!this.selected||version<1)return;
    const value=await this.report.load(`/action-executions/${encodeURIComponent(this.selected)}/verification/versions/${version}`);
    if(value)this.reportVersion=version;
  }
  render() {
    if(!this.plan)return nothing;
    const x=this.execution,e=x.data?.execution,r=this.report.data?.verification,inv=this.investigation.data;
    const bound=r&&e&&r.executionId===e.id&&r.investigationId===this.plan.content.investigationId&&r.resultVersion===this.plan.content.resultVersion;
    const valid=!this.reportVersion&&bound&&r.planId===this.plan.id&&r.planVersion===this.plan.version&&e.planVersion===this.plan.version&&r.state==='passed'&&e.state==='succeeded'&&validRecord(r)&&inv?.version===r.investigationVersion&&inv?.latestResult?.version===r.resultVersion&&inv.lifecycle==='open';
    return html`<app-card><span slot="header">执行与恢复</span><p>批准不会自动执行。执行状态与业务恢复分别核对，未知结果不重发。</p>
      <div class="toolbar">${this.executionIds.map(id=>html`<button class="btn-ghost" ?disabled=${x.loading||x.writing||x.accessInvalidated} @click=${()=>this.read(id)}>读取执行 ${id}</button>`)}
      ${this.canExecute&&this.plan.state==='approved'?html`<button class="btn-primary" ?disabled=${this.blocked||x.locked||!!e||!validRecord(this.plan.content)||!this.approvalId} @click=${()=>this.confirm=true}>执行当前批准版本</button>`:nothing}
      ${this.selected?html`<button class="btn btn-refresh" ?disabled=${x.loading||x.writing||x.accessInvalidated} @click=${()=>this.read()}>只读刷新原执行</button>`:nothing}</div>
      ${x.loading?html`<p role="status">正在读取原执行…</p>`:nothing}${x.error?html`<p role="alert">${x.error}</p>`:nothing}${x.mutationUnknown?html`<p class="notice warn" role="status">执行操作接受结果未知，禁止重发。请刷新原计划发现已持久化执行，再只读核对。</p>`:nothing}
      ${e?html`<dl><dt>执行绑定版本</dt><dd>v${e.planVersion}${e.planVersion!==this.plan.version?' · 历史版本，仅供核对':''}</dd><dt>执行状态</dt><dd>${operationLabels[e.state]??e.state}</dd><dt>恢复状态</dt><dd>${bound?operationLabels[r.state]??r.state:'尚无可用验证报告'}</dd><dt>取消申请</dt><dd>${e.cancelRequestedAt?'已提出，需核对实际终态':'未提出'}</dd></dl>
      ${e.state==='outcome_unknown'?html`<p class="notice warn">发送结果未知不等于未执行或已取消。只核对原 operation，不创建新行动。</p>`:nothing}
      <div class="toolbar">${this.canExecute&&['queued','prechecking','dispatching','outcome_unknown'].includes(e.state)?html`<button class="btn" ?disabled=${x.locked} @click=${()=>this.command('cancel')}>申请取消原执行</button>`:nothing}
      ${this.canExecute&&e.state==='outcome_unknown'?html`<button class="btn" ?disabled=${x.locked} @click=${()=>this.command('reconcile')}>核对原回执（不重发）</button>`:nothing}</div>
      <details><summary>原执行与回执</summary><pre>${JSON.stringify(e,null,2)}</pre></details>`:html`<p class="muted">尚未选择执行记录；不能据此判断目标是否已执行。</p>`}
    </app-card><app-card><span slot="header">不可变效果报告与人工结案</span>
      ${this.report.loading?html`<p role="status">正在读取报告…</p>`:nothing}${this.report.error?html`<p role="alert">${this.report.error}</p>`:nothing}
      ${r?html`<dl><dt>报告结论</dt><dd>${operationLabels[r.state]??r.state}</dd><dt>版本</dt><dd>v${r.version}</dd><dt>缺失采样</dt><dd>${r.missingSamples}</dd><dt>观测窗口</dt><dd>${r.observedFrom??'未知'} — ${r.observedUntil??'未知'}</dd><dt>有效期至</dt><dd>${r.validUntil}</dd></dl>
      <p class="notice warn">${r.reason??'执行前 120 秒、就绪 60 秒、恢复观察 300 秒、间隔 10 秒。'} 执行返回成功不能替代恢复验证；报告仅证明观测关联。</p>
      ${!valid?html`<p class="notice warn">此报告不能直接用于当前调查结案。历史版本、过期、调查重开或结果变化需重新核验。</p>`:nothing}
      <div class="toolbar"><label>报告历史版本<input aria-label="报告历史版本" type="number" min="1" max=${r.version} .value=${String(this.reportVersion||r.version)} @input=${(event:Event)=>this.reportVersion=Number((event.target as HTMLInputElement).value)}></label><button class="btn" ?disabled=${this.report.locked} @click=${()=>this.history(this.reportVersion||r.version)}>读取历史报告</button><button class="btn btn-refresh" ?disabled=${x.loading||x.writing} @click=${()=>this.read()}>读取最新报告</button></div>
      <details><summary>报告摘要、证据与逐窗采样</summary><pre>${JSON.stringify(r,null,2)}</pre></details>
      ${valid&&inv?.latestResult?html`<investigation-feedback .investigationId=${inv.id} .resultId=${inv.latestResult.id} .resultVersion=${inv.latestResult.version} .investigationVersion=${inv.version} .activeRequest=${!!inv.activeRequestId} .actionReport=${r} .readonly=${!this.canExecute} @investigation-feedback-saved=${()=>void this.read()}></investigation-feedback>`:nothing}`:html`<app-empty-state title="尚无可用验证报告" description="缺数据时保持无法确认恢复，不提供虚构结案依据。"></app-empty-state>`}
      ${this.investigation.error?html`<p role="alert">${this.investigation.error}</p>`:nothing}${this.canExecute&&inv&&['closed','archived'].includes(inv.lifecycle)?html`<p>重开后旧恢复确认失效。</p><button class="btn" ?disabled=${this.investigation.locked} @click=${this.reopen}>重新打开调查并使旧确认失效</button>`:nothing}
    </app-card><app-dialog .open=${this.confirm} title="确认执行当前批准版本" @app-dialog-close=${()=>this.confirm=false}><p>${resourceLabel(this.plan.content.target)} · ${this.plan.content.parameters.unit} · v${this.plan.version}</p><p>${this.plan.content.impact}</p><p class="notice warn">${this.plan.content.rollback.description}</p><div slot="footer"><button class="btn" @click=${()=>this.confirm=false}>取消</button><button class="btn-primary" ?disabled=${this.blocked||x.locked} @click=${this.execute}>确认执行一次</button></div></app-dialog>`;
  }
}
