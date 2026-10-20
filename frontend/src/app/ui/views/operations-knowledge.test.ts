import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import type { OperationsKnowledge } from './operations-knowledge.ts';
import './operations-knowledge.ts';
import type { CaseRecord } from '../controllers/operations-api.ts';
vi.mock('../../../api/index.ts',()=>({authFetch:vi.fn()}));
const api=vi.mocked(authFetch);
vi.mock('../controllers/operations-api.ts',async importOriginal=>({...await importOriginal<any>(),watchCase:()=>()=>{}}));
const record=():CaseRecord=>({id:'case',revision:4,version:2,contentHash:'a'.repeat(64),state:'pending_review',author:{kind:'user',id:11},resources:[],validUntil:new Date(Date.now()+600000).toISOString(),tombstone:false,referenceOnly:true,
  content:{title:'合成案例：服务无响应',symptoms:'当前症状',faultType:'服务异常',confirmedCause:'已确认事实',actions:'隔离测试',actualEffect:'恢复',counterexamples:'依赖故障不适用'},applicability:{conditions:'有证据',productVersion:'1',resourceVersion:'1'},source:{investigationId:'inv',resultId:'result',resultVersion:3,evidence:[]}});
const json=(v:unknown,status=200)=>({ok:status<400,status,json:async()=>v}) as Response;
let view:OperationsKnowledge;
async function mount(r=record()){
  history.replaceState({},'','/operations-knowledge?case=case');api.mockResolvedValueOnce(json(r));
  view=document.createElement('operations-knowledge') as OperationsKnowledge;view.permissions=new Set(['operations:cases:view','operations:cases:review']);
  document.body.append(view);await flush();return view.shadowRoot!;
}
async function flush(){await new Promise(r=>setTimeout(r,0));await view?.updateComplete;}
beforeEach(()=>{api.mockReset();localStorage.setItem('user',JSON.stringify({id:22}));});
afterEach(()=>{view?.remove();localStorage.clear();history.replaceState({},'','/');});
it('review submits the exact displayed revision, content version and hash',async()=>{
  const root=await mount();const textarea=root.querySelector('textarea[aria-label="审核或撤回依据"]') as HTMLTextAreaElement;
  textarea.value='独立人工审核';textarea.dispatchEvent(new Event('input'));await flush();
  api.mockResolvedValueOnce(json({id:'case'})).mockResolvedValueOnce(json({...record(),state:'published'}));
  [...root.querySelectorAll('button')].find(b=>b.textContent?.includes('审核发布当前版本'))!.click();await flush();
  const review=api.mock.calls.find(([url])=>String(url).endsWith('/review'))!;
  expect(JSON.parse(review[1]!.body as string)).toEqual({expectedRevision:4,version:2,contentHash:'a'.repeat(64),decision:'approved',note:'独立人工审核'});
});
it('author cannot self review and expired tombstones expose no content or publish action',async()=>{
  localStorage.setItem('user',JSON.stringify({id:11}));const root=await mount();
  expect([...root.querySelectorAll('button')].find(b=>b.textContent?.includes('审核发布当前版本'))?.disabled).toBe(true);
  view.remove();await mount({...record(),state:'expired',tombstone:true,content:undefined,source:undefined,applicability:undefined});
  expect(view.shadowRoot!.textContent).not.toContain('已确认事实');expect(view.shadowRoot!.textContent).toContain('正文不可引用');
  expect([...view.shadowRoot!.querySelectorAll('button')].some(b=>b.textContent?.includes('审核发布当前版本'))).toBe(false);
});
it('permission changes clear the article and open draft before a late response can restore them',async()=>{
  const root=await mount();expect(root.textContent).toContain('已确认事实');
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}}));await flush();
  expect(root.textContent).not.toContain('已确认事实');expect(root.textContent).not.toContain('当前症状');expect(root.textContent).toContain('内容已清除');
});
