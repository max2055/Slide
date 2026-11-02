import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import { approvalPlanBinding, type OperationsActions } from './operations-actions.ts';
vi.mock('../../../api/index.ts',()=>({authFetch:vi.fn()}));
const api=vi.mocked(authFetch);
const hash='a'.repeat(64);
const plan=()=>({id:'p',version:3,contentHash:hash,state:'pending_approval',content:{
  investigationId:'i',resultVersion:2,target:{type:'server',id:501},parameters:{unit:'slide-action-demo.service'},
  author:{kind:'user',id:11},requester:{kind:'user',id:11},validUntil:new Date(Date.now()+600000).toISOString(),
  risk:'medium',impact:'Synthetic',preconditions:[],verifier:{beforeSeconds:120,readinessSeconds:60,observationSeconds:300,intervalSeconds:10,maxExtraRestarts:0},
  rollback:{capability:'none',description:'不可恢复原进程状态'},evidence:[],relations:[],baselines:[],tool:{name:'restart_demo_service'},
}});
const row=(version=3)=>({id:72,status:'pending',kind:'agent',tool_name:'operations_action_plan',args_redacted:{kind:'operations-action-plan-v1',planId:'p',version,contentHash:hash}});
const json=(v:unknown,status=200)=>({ok:status<400,status,json:async()=>v}) as Response;
let view:OperationsActions;
async function flush(){await new Promise(r=>setTimeout(r,0));await view?.updateComplete;}
async function mount(){
  history.replaceState({},'','/operations-actions?plan=p');
  view=document.createElement('operations-actions') as OperationsActions;
  view.permissions=new Set(['approval:view','operations:actions:view','operations:actions:approve']);
  document.body.append(view);await flush();return view.shadowRoot!;
}
beforeEach(()=>{api.mockReset();localStorage.setItem('user',JSON.stringify({id:22}));});
afterEach(()=>{view?.remove();localStorage.clear();history.replaceState({},'','/');});
it('discovers a matching approval even when its feed arrives after the plan',async()=>{
  let release!:(v:Response)=>void;
  api.mockImplementation(url=>String(url).includes('/unified')?new Promise(r=>release=r):Promise.resolve(json({plan:plan()})));
  const root=await mount();release(json({items:[row(2),row()]}));await flush();
  expect((root.querySelector('[aria-label="审批记录号"]') as HTMLInputElement).value).toBe('72');
  const note=root.querySelector('[aria-label="审批备注"]') as HTMLTextAreaElement;note.value='独立核对';note.dispatchEvent(new Event('input'));await flush();
  [...root.querySelectorAll('button')].find(b=>b.textContent==='批准当前版本')!.click();await flush();
  api.mockResolvedValue(json({},503));
  [...root.querySelectorAll('button')].find(b=>b.textContent==='确认批准当前版本')!.click();await flush();
  const review=api.mock.calls.find(([url])=>String(url).endsWith('/review'))!;
  expect(JSON.parse(review[1]!.body as string)).toEqual({expectedVersion:3,approvalId:'72',action:'approve',note:'独立核对'});
  expect(root.textContent).toContain('操作接受结果未知');expect(root.textContent).not.toContain('Synthetic');
  expect(api.mock.calls.filter(([url])=>String(url).endsWith('/review'))).toHaveLength(1);
});
it('does not bind a prior version and author cannot approve even with a matching record',async()=>{
  localStorage.setItem('user',JSON.stringify({id:11}));
  api.mockImplementation(url=>Promise.resolve(json(String(url).includes('/unified')?{items:[row(2)]}:{plan:plan()})));
  const root=await mount();expect((root.querySelector('[aria-label="审批记录号"]') as HTMLInputElement).value).toBe('');
  expect([...root.querySelectorAll('button')].find(b=>b.textContent==='批准当前版本')!.disabled).toBe(true);
  window.dispatchEvent(new Event('slide-session-expired'));await flush();
  expect(root.textContent).not.toContain('Synthetic');expect(root.textContent).not.toContain('计划 p ·');
});
it('only recognizes the formal action-plan approval payload',()=>{
  expect(approvalPlanBinding({...row(),tool_name:'arbitrary_tool'})).toBeNull();
  expect(approvalPlanBinding({...row(),args_redacted:{kind:'other',planId:'p',version:3,contentHash:hash}})).toBeNull();
  expect(approvalPlanBinding(row())).toMatchObject({planId:'p',version:3,approvalId:'72',contentHash:hash});
});

it('carries the exact source result version into a draft and returns to the source investigation',async()=>{
  history.replaceState({},'','/operations-actions?sourceInvestigation=source-one&resultVersion=4&targetId=501');
  api.mockImplementation(url=>Promise.resolve(json(String(url).includes('/api/investigations/')?{id:'source-one',title:'来源调查',resources:[{type:'server',id:501}],latestResult:{id:'result',version:4,result:{summary:'夹具结果'}}}:String(url).includes('/plans?')?{items:[],authorizedCounts:{total:0},nextCursor:null}:{plan:plan()})));
  view=document.createElement('operations-actions') as OperationsActions;
  view.permissions=new Set(['operations:actions:view','operations:actions:propose']);
  document.body.append(view);await flush();
  const root=view.shadowRoot!;
  expect(root.textContent).toContain('结果 V4');expect(root.querySelector('[aria-label="草案结果版本"]')).toBeNull();
  expect(root.querySelector('a[href="/investigations?investigation=source-one"]')).not.toBeNull();
  const target=root.querySelector('[aria-label="草案目标服务器"]') as HTMLSelectElement;
  expect(target.value).toBe('501');
  const impact=root.querySelector('[aria-label="草案预计影响"]') as HTMLSelectElement;
  impact.selectedIndex=1;impact.dispatchEvent(new Event('change'));await flush();
  [...root.querySelectorAll('button')].find(b=>b.textContent==='创建可信来源草案')!.click();await flush();
  const call=api.mock.calls.find(([url])=>String(url).endsWith('/actions/drafts'))!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({investigationId:'source-one',resultVersion:4,targetId:501,impact:'重启专用演练服务可能短暂中断服务，原进程内存不可恢复；需独立审批及后续实际观测验证。'});
});
it('refuses stale source results and clears draft context after live authority withdrawal',async()=>{
 history.replaceState({},'','/operations-actions?sourceInvestigation=source-one&resultVersion=4&targetId=501');
 api.mockImplementation(url=>Promise.resolve(json(String(url).includes('/api/investigations/')?{id:'source-one',title:'来源调查',resources:[{type:'server',id:501}],latestResult:{id:'r5',version:5,result:{summary:'新结果'}}}:{items:[],authorizedCounts:{total:0}})));
 view=document.createElement('operations-actions') as OperationsActions;view.permissions=new Set(['operations:actions:view','operations:actions:propose']);document.body.append(view);await flush();
 const root=view.shadowRoot!;expect(root.textContent).toContain('来源结果已变化');
 const create=[...root.querySelectorAll('button')].find(b=>b.textContent==='创建可信来源草案')!;expect(create.disabled).toBe(true);
 expect(api.mock.calls.some(([url])=>String(url).endsWith('/actions/drafts'))).toBe(false);
 window.dispatchEvent(new Event('slide-session-expired'));await flush();expect(root.textContent).not.toContain('新结果');
});
it('permits explicit independent approval with an optional note and server-bound approval ID',async()=>{
 api.mockImplementation(url=>Promise.resolve(json(String(url).includes('/unified')?{items:[row()]}:{plan:plan()})));
 const root=await mount();
 const approve=[...root.querySelectorAll('button')].find(b=>b.textContent==='批准当前版本')!;
 expect(approve.disabled).toBe(false);approve.click();await flush();
 api.mockResolvedValue(json({},503));[...root.querySelectorAll('button')].find(b=>b.textContent==='确认批准当前版本')!.click();await flush();
 const call=api.mock.calls.find(([url])=>String(url).endsWith('/review'))!;
 expect(JSON.parse(call[1]!.body as string)).toEqual({expectedVersion:3,approvalId:'72',action:'approve',note:''});
});
it('stale reminder plan bindings expose current-record confirmation and never render approval controls',async()=>{
 history.replaceState({},'','/operations-actions?plan=p&attentionPlanVersion=2&attentionPlanHash=old&returnTo=/investigations');
 api.mockImplementation(url=>Promise.resolve(json(String(url).includes('/unified')?{items:[row()]}:{plan:plan()})));
 view=document.createElement('operations-actions') as OperationsActions;view.permissions=new Set(['operations:actions:view','operations:actions:approve']);document.body.append(view);await flush();
 const root=view.shadowRoot!;expect(root.textContent).toContain('提醒引用的计划版本已变化');expect([...root.querySelectorAll('button')].some(b=>b.textContent==='批准当前版本')).toBe(false);
 expect(root.querySelector('a[href="/operations-actions?plan=p"]')).not.toBeNull();expect(api.mock.calls.every(([,init])=>!init?.method)).toBe(true);
});
