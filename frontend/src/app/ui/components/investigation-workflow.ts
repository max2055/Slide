import {LitElement,html,nothing} from 'lit';
import {customElement,property,state} from 'lit/decorators.js';
import {investigationApi,InvestigationApiError,investigationErrorText} from '../controllers/investigation-api.ts';
import {operationsStyles} from '../views/operations-styles.ts';
import type {InvestigationCreateRequest} from '../../../api/generated/public-api.ts';
import {currentUserId} from '../controllers/operations-api.ts';
import './app-card.ts';import './app-form-field.ts';
export interface WorkflowPage {
  canOperate?:boolean;investigationId:string;version:number;scopeVersion:string;resources:InvestigationCreateRequest['resourceRefs'];
  suggestions:Array<{relationId:string;version:number;hash:string;resource:{type:'instance'|'server'|'network_device';id:number};origin:string;state:string;relationType:string;observedAt:string;validUntil:string|null}>;
  partial:boolean;receipts:Array<{id:string;kind:string;version:number;scopeVersion:string;conclusion?:string;from?:string;to?:string;gaps?:string[];createdAt:string;observations?:unknown[]}>;nextBefore:number|null;
}
const labels={recovered:'恢复',not_improved:'未改善',insufficient_evidence:'证据不足'};
const localDate=(value:string)=>value?new Date(Date.parse(value)-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,23):'';
@customElement('investigation-workflow')
export class InvestigationWorkflowView extends LitElement {
  static styles=operationsStyles;
  @property() investigationId='';
  @property({type:Number}) version=0;
  @property({attribute:false}) eventIds:number[]=[];
  @property() originUntil='';
  @property({type:Boolean}) active=false;
  @property({type:Boolean}) readonly=false;
  @state() private accessWithdrawn=false;
  @state() private data:WorkflowPage|null=null;
  @state() private selected:string[]=[];
  @state() private removed:string[]=[];
  @state() private scopeConfirmed=false;
  @state() private retestConfirmed=false;
  @state() private eventId=0;
  @state() private from='';
  @state() private to='';
  @state() private busy=false;
  @state() private loading=false;
  @state() private error='';
  @state() private pending:{kind:'scope'|'retest';body:unknown;key:string}|null=null;
  private ownerKey='';
  private epoch=0;private readOrdinal=0;
  private storageKey(){return this.ownerKey||=( `slide-investigation-workflow:${currentUserId()??'unknown'}:${this.investigationId}`);}
  private erase=()=>{try{sessionStorage.removeItem(this.storageKey());}catch{}this.ownerKey='';this.epoch++;this.readOrdinal++;this.data=null;this.selected=[];this.removed=[];this.pending=null;this.scopeConfirmed=false;this.retestConfirmed=false;this.from='';this.to='';this.error='权限或登录状态已变化，请重新打开调查核验。';this.accessWithdrawn=true;this.busy=false;this.loading=false;};
  connectedCallback(){super.connectedCallback();window.addEventListener('slide-session-expired',this.erase);window.addEventListener('slide-permissions-loaded',this.erase);}
  disconnectedCallback(){this.epoch++;this.readOrdinal++;window.removeEventListener('slide-session-expired',this.erase);window.removeEventListener('slide-permissions-loaded',this.erase);super.disconnectedCallback();}
  protected updated(changed:Map<string,unknown>){
    if(changed.has('investigationId')){
      this.ownerKey='';this.epoch++;this.data=null;this.pending=null;this.selected=[];this.removed=[];this.scopeConfirmed=false;this.retestConfirmed=false;this.eventId=this.eventIds[0]??0;this.window();
      try{const saved=JSON.parse(sessionStorage.getItem(this.storageKey())||'null');if(saved&&['scope','retest'].includes(saved.kind)&&typeof saved.key==='string'&&saved.body&&typeof saved.body==='object')this.pending=saved;}catch{this.error='未能读取原请求标识，暂不提交新请求。';this.accessWithdrawn=true;}
      void this.load();
    }else if(changed.has('version')&&!this.busy)void this.load();
  }
  private window(){const now=Date.now();this.to=new Date(now).toISOString();this.from=new Date(Math.max(Date.parse(this.originUntil)||now-300000,now-86400000)).toISOString();}
  private async load(before?:number){
    if(!this.investigationId)return;const epoch=this.epoch,ordinal=++this.readOrdinal;this.loading=true;
    try{const value=await investigationApi<WorkflowPage>(`/${encodeURIComponent(this.investigationId)}/workflow${before?`?before=${before}`:''}`);
      if(epoch===this.epoch&&ordinal===this.readOrdinal){
        const identity=(v:WorkflowPage)=>JSON.stringify([v.scopeVersion,v.suggestions.map(s=>[s.relationId,s.version,s.hash])]);
        if(this.data&&!this.pending&&identity(this.data)!==identity(value)){this.selected=[];this.removed=[];this.scopeConfirmed=false;this.retestConfirmed=false;}
        this.accessWithdrawn=false;this.error='';
        this.data=before&&this.data?{...value,receipts:[...this.data.receipts,...value.receipts]}:value;
      }
    }catch(e){if(epoch===this.epoch&&ordinal===this.readOrdinal){if(e instanceof InvestigationApiError&&[401,403,404].includes(e.status))this.erase();else this.error=investigationErrorText(e);}}
    finally{if(epoch===this.epoch&&ordinal===this.readOrdinal)this.loading=false;}
  }
  private async send(kind:'scope'|'retest'){
    if(!currentUserId()||this.busy||this.readonly||this.accessWithdrawn||this.data?.canOperate===false||this.active||!this.data||this.pending&&this.pending.kind!==kind)return;
    if(!this.pending){
      if(kind==='scope'&&(!this.scopeConfirmed||!this.selected.length&&!this.removed.length)||kind==='retest'&&(!this.retestConfirmed||!this.eventId||!this.from||!this.to))return;
      const body=kind==='scope'?{expectedVersion:this.version,confirmed:true,add:this.data.suggestions.filter(s=>this.selected.includes(s.relationId)).map(s=>({relationId:s.relationId,version:s.version,hash:s.hash})),remove:this.data.resources.filter(r=>this.removed.includes(`${r.type}:${r.id}`)).map(({type,id})=>({type,id}))}
        :{expectedVersion:this.version,eventId:this.eventId,from:this.from,to:this.to,confirmed:true};
      this.pending={kind,body,key:crypto.randomUUID()};
      try{sessionStorage.setItem(this.storageKey(),JSON.stringify(this.pending));}catch{this.pending=null;this.error='无法保存原请求标识，未提交。';return;}
    }
    const pending=this.pending,epoch=this.epoch;this.busy=true;this.error='';
    try{await investigationApi(`/${encodeURIComponent(this.investigationId)}/${kind}`,{method:'POST',headers:{'Idempotency-Key':pending.key},body:JSON.stringify(pending.body)});
      if(epoch!==this.epoch)return;sessionStorage.removeItem(this.storageKey());this.pending=null;this.scopeConfirmed=false;this.retestConfirmed=false;this.selected=[];this.removed=[];
      await this.load();this.dispatchEvent(new CustomEvent('investigation-workflow-saved',{bubbles:true,composed:true}));
    }catch(e){if(epoch!==this.epoch)return;
      if(e instanceof InvestigationApiError&&e.status<500){sessionStorage.removeItem(this.storageKey());this.pending=null;if([401,403,404].includes(e.status))this.erase();else this.error=investigationErrorText(e);}
      else this.error='提交结果未知，请核对原请求；不会使用新标识重复提交。';
    }finally{if(epoch===this.epoch)this.busy=false;}
  }
  render(){const locked=this.busy||!!this.pending||this.readonly||this.accessWithdrawn||this.data?.canOperate===false||this.active,d=this.data;
    return html`<app-card><span slot="header">关联范围与无行动复测</span><p>确认范围后只影响后续调查。复测读取原事件规则和后续正式观测，不执行行动、不关闭事件。</p>
      ${this.error?html`<p role="alert">${this.error}</p>`:nothing}${this.loading?html`<p role="status">正在核对原记录…</p>`:nothing}
      <button class="btn btn-refresh" ?disabled=${this.busy} @click=${()=>this.load()}>刷新范围与复测记录</button>
      ${d?html`<h3>当前调查范围</h3><ul>${d.resources.map(r=>html`<li>${r.type}:${r.id} · ${r.role==='primary'?'主对象':html`<label><input aria-label=${`移除关联对象 ${r.type}:${r.id}`} type="checkbox" .checked=${this.removed.includes(`${r.type}:${r.id}`)} ?disabled=${locked} @change=${(e:Event)=>{const key=`${r.type}:${r.id}`;this.removed=(e.target as HTMLInputElement).checked?[...this.removed,key]:this.removed.filter(k=>k!==key);this.scopeConfirmed=false;}}>下一范围移除此关联对象</label>`}</li>`)}</ul>
        <h3>有来源的关联建议</h3>${d.suggestions.length?d.suggestions.map(s=>html`<app-form-field label=${`${s.resource.type}:${s.resource.id}`} hint=${`来源：${s.origin} · ${s.relationType} · ${s.state==='confirmed'?'关系已确认':'建议关系，纳入不代表事实确认'} · ${s.observedAt}`}><label><input aria-label=${`纳入关联对象 ${s.resource.type}:${s.resource.id}`} type="checkbox" .checked=${this.selected.includes(s.relationId)} ?disabled=${locked} @change=${(e:Event)=>{this.selected=(e.target as HTMLInputElement).checked?[...this.selected,s.relationId]:this.selected.filter(k=>k!==s.relationId);this.scopeConfirmed=false;}}>纳入下一调查范围</label></app-form-field>`):html`<p>没有可用的授权关联建议，不自动添加对象。</p>`}
        ${d.partial?html`<p>仅展示当前有界关联页，不推定已枚举全部关系。</p>`:nothing}
        <label><input aria-label="确认关联范围变化" type="checkbox" .checked=${this.scopeConfirmed} ?disabled=${locked} @change=${(e:Event)=>this.scopeConfirmed=(e.target as HTMLInputElement).checked}>确认所选加入/移除；原请求与结果保留，旧批准不适用于新范围。</label>
        <button class="btn-primary" ?disabled=${this.busy||this.readonly||this.accessWithdrawn||this.data?.canOperate===false||this.active||!this.pending&&(!this.scopeConfirmed||!this.selected.length&&!this.removed.length)||!!this.pending&&this.pending.kind!=='scope'} @click=${()=>this.send('scope')}>${this.pending?.kind==='scope'?'核对原范围提交':'保存确认的范围'}</button>
        <h3>无行动复测</h3>${this.eventIds.length?html`
          <app-form-field label="原事件规则"><select aria-label="原事件规则" .value=${String(this.eventId)} ?disabled=${locked} @change=${(e:Event)=>{this.eventId=Number((e.target as HTMLSelectElement).value);this.retestConfirmed=false;}}>${this.eventIds.map(id=>html`<option value=${id}>原事件 ${id} 的固定规则</option>`)}</select></app-form-field>
          <button class="btn" ?disabled=${locked} @click=${()=>{this.window();this.retestConfirmed=false;}}>使用原窗口之后至现在</button>
          ${(['from','to'] as const).map(field=>html`<app-form-field label=${field==='from'?'复测开始时间':'复测结束时间'}><input aria-label=${field==='from'?'复测开始时间':'复测结束时间'} type="datetime-local" step="0.001" .value=${localDate(this[field])} ?disabled=${locked} @input=${(e:Event)=>{const value=(e.target as HTMLInputElement).value;this[field]=value&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():'';this.retestConfirmed=false;}}></app-form-field>`)}
          <p>绝对窗口：${this.from} — ${this.to}。额外关联对象、缺测或不完整数据仍为证据不足。</p>
          <label><input aria-label="确认无行动复测窗口" type="checkbox" .checked=${this.retestConfirmed} ?disabled=${locked} @change=${(e:Event)=>this.retestConfirmed=(e.target as HTMLInputElement).checked}>确认读取此后续窗口；调查恢复状态与原事件状态分别保留。</label>
          <button class="btn-primary" ?disabled=${this.busy||this.readonly||this.accessWithdrawn||this.data?.canOperate===false||this.active||!this.pending&&!this.retestConfirmed||!!this.pending&&this.pending.kind!=='retest'} @click=${()=>this.send('retest')}>${this.pending?.kind==='retest'?'核对原复测提交':'按后续观测复测'}</button>`:html`<p>未关联可核验的原资源事件规则；此处不凭空设置阈值。平台异常使用其原异常复测入口。</p>`}
        ${this.active?html`<p role="status">本轮执行中，范围与复测等待其结束；正式采集和事件保持原状态。</p>`:nothing}
        <h3>原范围与复测回执</h3>${d.receipts.length?d.receipts.map(r=>html`<details><summary>${r.kind==='scope'?'范围确认':`${labels[r.conclusion as keyof typeof labels]??'待核对'}（观测结论，人工确认另记）`} · 调查 V${r.version} · ${r.createdAt}</summary><p>${r.from??''} — ${r.to??''}；${r.observations?.length??0}条观测</p>${r.gaps?.map(g=>html`<p>${g}</p>`)}<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${JSON.stringify(r,null,2)}</pre></details>`):html`<p>暂无范围或复测回执；分析结束不代表恢复。</p>`}
        ${d.nextBefore?html`<button class="btn" ?disabled=${this.loading} @click=${()=>this.load(d.nextBefore!)}>加载更早范围与复测记录</button>`:nothing}`:nothing}</app-card>`;
  }
}
