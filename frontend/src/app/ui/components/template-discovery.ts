import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { DiscoveryPreview, DiscoveryState, TemplateEditor, TemplateCapabilities } from '../../../api/generated/public-api.js';
import { apiClient } from '../../../api/index.js';
import { metricRequest, MetricRequestError } from './metric-api.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { sharedFieldStyles } from '../../styles/shared-field-styles.js';
import './app-data-table.js';
import './native-template-configuration.js';

interface ReadContext { generation:number; selected:string; version:TemplateDiscovery['version']; session:number; signal:AbortSignal; resource:{type:string;id:number} }

@customElement('template-discovery')
export class TemplateDiscovery extends LitElement {
  @property({attribute:false}) aggregate: TemplateEditor['draft']['aggregate'] | null = null;
  @property({attribute:false}) items: TemplateEditor['items'] = [];
  @property({attribute:false}) version: TemplateEditor['versions'][number] | null = null;
  @property({attribute:false}) capabilities: TemplateCapabilities | null = null;
  @property({type:Boolean}) editable = false;
  @state() private item = '';
  @state() private lost = 60;
  @state() private retire = 3600;
  @state() private max = 6;
  @state() private resources: Array<{type:string;id:number;name:string}> = [];
  @state() private selected = '';
  @state() private preview: DiscoveryPreview | null = null;
  @state() private instances: DiscoveryState | null = null;
  @state() private busy = false;
  @state() private error = '';
  private generation=0;
  private stateRead=0;
  private resourceRequests=new AbortController();
  private stateContext:ReadContext|null=null;
  private operation: {key:string;signature:string}|null=null;
  static styles=[sharedBtnStyles,sharedFieldStyles,css`
    :host{display:block;color:var(--text)} .row{display:flex;gap:var(--space-md);flex-wrap:wrap;align-items:end;margin-block:var(--space-md)}
    label{display:grid;gap:var(--space-xs);min-width:9rem;max-width:100%} input,select{font:inherit;max-width:100%;box-sizing:border-box;min-height:var(--control-height)}
    .scroll{overflow:auto} small{display:block;color:var(--muted);overflow-wrap:anywhere} :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  `];
  private readonly accessChanged=()=>{this.changeResource('');this.resources=[];this.error='登录或资源权限已变更，请重新读取模板';};
  override connectedCallback(){super.connectedCallback();window.addEventListener('slide-permissions-loaded',this.accessChanged);window.addEventListener('slide-session-expired',this.accessChanged);}
  override disconnectedCallback(){this.resourceRequests.abort();this.generation++;window.removeEventListener('slide-permissions-loaded',this.accessChanged);window.removeEventListener('slide-session-expired',this.accessChanged);super.disconnectedCallback();}
  protected updated(changes:Map<string,unknown>){if(changes.has('version')){this.changeResource('');this.resources=[];if(this.version)void this.loadResources();}}
  private failure(error:unknown){if(error instanceof MetricRequestError && [401,403].includes(error.status)){this.changeResource('');this.resources=[];this.error='登录或资源权限已变更，请重新读取模板';}
    else this.error=error instanceof Error?error.message:'操作未完成，结果未知';}
  private async loadResources(){const g=this.generation,session=apiClient.getSessionContext();this.busy=true;this.error='';try{const resources=await metricRequest<Array<{type:string;id:number;name:string}>>('template-governance/resources',undefined,this.resourceRequests.signal);if(g===this.generation){if(session===apiClient.getSessionContext())this.resources=resources;else this.accessChanged();}}catch(e){if(g===this.generation)this.failure(e);}finally{if(g===this.generation)this.busy=false;}}
  private get resource(){return this.resources.find(r=>`${r.type}:${r.id}`===this.selected);}
  private add(){if(!this.aggregate)return;const item=this.items.find(i=>i.item_id===this.item);if(!item)return;
    const keys=this.capabilities?.candidates.find(c=>c.metric.id===item.canonical_metric.id&&c.package_release===item.collector_ref.package_release)?.dimensions.map(d=>d.name)??[];
    const implementation=item.collector_ref.implementation_id;
    const dimensions=['builtin:snmp.interfaces.v1','builtin:linux.interface-discovery.v1'].includes(implementation)?['interface_epoch']:implementation==='builtin:mysql.innodb-discovery.v1'?['table_epoch']:implementation==='builtin:linux.filesystem-discovery.v1'?['filesystem_epoch']:keys;
    if(!dimensions.length){this.error='此项缺少可验证的稳定维度，请选择接口或固定维度原型';return;}
    if(!Number.isInteger(this.lost)||this.lost<1||!Number.isInteger(this.retire)||this.retire<this.lost||!Number.isInteger(this.max)||this.max<1||this.max>1000){this.error='请核对等待、退役时间和数量预算';return;}
    const rules=[...(this.aggregate.discovery_rules??[]),{rule_id:`discovery_${crypto.randomUUID().replaceAll('-','')}`,name:`${item.display_name}发现`,item_ids:[item.item_id],identity_dimensions:dimensions,timeout_ms:5000,max_instances:this.max,lost_after_ms:this.lost*1000,retire_after_ms:this.retire*1000}];
    this.dispatchEvent(new CustomEvent('discovery-change',{detail:rules,bubbles:true,composed:true}));this.item='';this.error='';}
  private changeResource(selected:string){
    this.resourceRequests.abort();this.resourceRequests=new AbortController();
    this.generation++;this.stateRead++;this.selected=selected;this.preview=null;this.instances=null;
    this.stateContext=null;this.operation=null;this.busy=false;this.error='';
  }
  private context():ReadContext|null{const resource=this.resource;return resource?{generation:this.generation,selected:this.selected,
    version:this.version,session:apiClient.getSessionContext(),signal:this.resourceRequests.signal,resource:{type:resource.type,id:resource.id}}:null;}
  private current(c:ReadContext){
    if(!this.isConnected||c.generation!==this.generation||c.selected!==this.selected||c.version!==this.version)return false;
    if(c.session!==apiClient.getSessionContext()){this.accessChanged();return false;}
    return true;
  }
  private async enumerate(){const c=this.context(),version=this.version;if(!c||!version)return;
    this.busy=true;this.error='';this.preview=null;
    const signature=`${version.content_hash}:${c.selected}`;
    if(this.operation?.signature!==signature)this.operation={key:`discovery-${crypto.randomUUID()}`,signature};
    try{const preview=await metricRequest<DiscoveryPreview>(`templates/${version.template_id}/discovery-preview`,{version:version.version,resource:c.resource,operation_key:this.operation.key},c.signal);
      if(this.current(c)){this.preview=preview;await this.loadState();}
    }catch(e){if(this.current(c))this.failure(e);}finally{if(this.current(c))this.busy=false;}}
  private async loadState(){const c=this.context();if(!c)return;const read=++this.stateRead;
    this.stateContext=null;this.busy=true;this.error='';
    try{const result=await metricRequest<DiscoveryState>(`discovery/${c.resource.type}/${c.resource.id}`,undefined,c.signal);
      if(this.current(c)&&read===this.stateRead){this.instances=result;this.stateContext=c;}
    }catch(e){if(this.current(c)&&read===this.stateRead)this.failure(e);}
    finally{if(this.current(c)&&read===this.stateRead)this.busy=false;}}
  private async stop(c:ReadContext|null,row:DiscoveryState['rows'][number],id:string,action:'disabled'|'retired'){
    // A retained/detached button may still fire after a switch or refresh.
    // The displayed snapshot, never the current selector, owns this mutation.
    if(!c||c!==this.stateContext||!this.current(c)||this.busy||!this.instances?.rows.includes(row))return;
    const read=++this.stateRead;this.busy=true;this.error='';this.stateContext=null;
    try{const result=await metricRequest<DiscoveryState>(`discovery/${c.resource.type}/${c.resource.id}/stop`,{expected_revision:row.revision,template_id:row.template_id,rule_id:row.rule_id,instance_id:id,action},c.signal);
      if(this.current(c)&&read===this.stateRead){this.instances=result;this.stateContext=c;}
    }catch(e){if(this.current(c)&&read===this.stateRead)this.failure(e);}
    finally{if(this.current(c)&&read===this.stateRead)this.busy=false;}}
  override render(){const context=this.stateContext;const rules=this.aggregate?.discovery_rules??[];const available=this.items.filter(i=>this.aggregate?.triggers.some(t=>t.scope===`item:${i.item_id}`)&&!rules.some(r=>r.item_ids.includes(i.item_id)));
    return html`<h3>发现规则与原型</h3><p>规则与项、触发器共同版本化。只有完整成功枚举才判定消失；失联、停止和退役不删除历史、不宣告恢复。</p>
      ${this.error?html`<p role="alert">${this.error}</p>`:nothing}${this.busy?html`<p role="status">正在核对权限与读取发现结果…</p>`:nothing}
      ${this.editable?html`<div class="row"><label>监控项原型<select aria-label="发现监控项原型" .value=${this.item} @change=${(e:Event)=>this.item=(e.target as HTMLSelectElement).value}><option value="">请选择已有触发器的项</option>${available.map(i=>html`<option value=${i.item_id}>${i.display_name}</option>`)}</select></label>
      <label>失联后禁用（秒）<input aria-label="失联后禁用秒数" type="number" min="1" .value=${String(this.lost)} @input=${(e:Event)=>this.lost=Number((e.target as HTMLInputElement).value)}></label>
      <label>失联后退役（秒）<input aria-label="失联后退役秒数" type="number" min="1" .value=${String(this.retire)} @input=${(e:Event)=>this.retire=Number((e.target as HTMLInputElement).value)}></label>
      <label>实例数量上限<input aria-label="发现实例上限" type="number" min="1" max="1000" .value=${String(this.max)} @input=${(e:Event)=>this.max=Number((e.target as HTMLInputElement).value)}></label>
      <button class="btn" ?disabled=${!this.item||this.busy} @click=${this.add}>添加发现规则到草稿</button></div><small>原型需先发布受限触发器。修改后保存草稿并发布新版本。</small>`:nothing}
      ${!rules.length?html`<p>此版本没有发现规则。</p>`:rules.map(rule=>html`<p><strong>${rule.name}</strong>：最多 ${rule.max_instances} 个实例，${rule.timeout_ms/1000} 秒总预算；消失 ${rule.lost_after_ms/1000} 秒禁用、${rule.retire_after_ms/1000} 秒退役。${rule.item_ids.length} 个项原型与对应触发器。<small>身份维度：${rule.identity_dimensions.join(' / ')}</small></p>`)}
      ${this.version&&this.version.aggregate.discovery_rules?.length?html`<p>枚举预览固定使用已发布 v${this.version.version}；未保存或未发布的草稿不会生效。</p><div class="row"><label>授权资源<select aria-label="发现授权资源" .value=${this.selected} @change=${(e:Event)=>{this.changeResource((e.target as HTMLSelectElement).value);void this.loadState();}}><option value="">请选择资源</option>${this.resources.map(r=>html`<option value=${`${r.type}:${r.id}`}>${r.name}</option>`)}</select></label>
      <button class="btn" ?disabled=${!this.resource||this.busy} @click=${this.enumerate}>只读枚举预览</button><button class="btn btn-refresh" ?disabled=${!this.resource||this.busy} @click=${this.loadState}>刷新生命周期</button>${this.preview?html`<button class="btn" ?disabled=${!this.resource||this.busy} @click=${()=>{this.operation=null;void this.enumerate();}}>重新发起只读枚举</button>`:nothing}</div>
      <p>发布、只读预览、绑定应用与真实采样分别反馈。预览不生成正式样本；在下方沿既有资源配置测试并应用后，正式采样生成项及触发器实例。</p>
      ${this.preview?html`<p role="status">${this.preview.state==='completed'?'只读枚举完成；此结果不代表正式生效':'枚举结果未知；不自动重放'}</p>${this.preview.rules.map(r=>html`<p>${r.rule.name}：${r.status==='complete'?`${r.count} 个实例`:`未知（${r.error}）`}；项上限 ${r.budget.item_upper_bound}，触发器上限 ${r.budget.trigger_upper_bound}</p><ul>${r.members.map(m=>html`<li>${m.name}</li>`)}</ul>`)}`:nothing}
      ${this.resource?html`<native-template-configuration .resourceType=${this.resource.type} .resourceId=${this.resource.id}></native-template-configuration>`:nothing}
      ${this.instances?html`<div class="scroll"><app-data-table .columns=${[{key:'name',label:'实例'},{key:'state',label:'生命周期'},{key:'prototypes',label:'项 / 触发器'},{key:'actions',label:'保留历史操作'}]} .rows=${this.instances.rows.filter(row=>row.template_id===this.version!.template_id).flatMap(row=>row.state.members.map(m=>({name:html`${m.name}<small>${m.id.slice(0,24)} · v${row.state.template_version}</small>`,state:{active:'已发现 / 正式采样',waiting:'失联等待',disabled:'已禁用',retired:'已退役'}[m.state],prototypes:`${row.state.items.length} / ${row.state.triggers.length}`,actions:html`<button class="btn btn-sm" ?disabled=${!context||this.busy||m.state==='disabled'||m.state==='retired'} @click=${()=>this.stop(context,row,m.id,'disabled')}>禁用</button><button class="btn btn-sm" ?disabled=${!context||this.busy||m.state==='retired'} @click=${()=>this.stop(context,row,m.id,'retired')}>退役并保留历史</button>`})))}></app-data-table></div>${!this.instances.rows.some(row=>row.state.members.length)?html`<p>尚无正式发现实例；预览不会冒充实际生效。</p>`:nothing}`:nothing}`:nothing}`;}
}
