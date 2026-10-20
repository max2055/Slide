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
