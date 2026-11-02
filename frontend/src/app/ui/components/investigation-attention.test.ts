import {authFetch} from '../../../api/index.ts';
vi.mock('../../../api/index.ts',()=>({authFetch:vi.fn()}));
import {afterEach,expect,it,vi} from 'vitest';
import {InvestigationAttention,attentionUrl,type WorkspaceAttentionItem} from './investigation-attention.ts';
const item:WorkspaceAttentionItem={investigationId:'inv',investigationVersion:8,scopeVersion:'scope',resultId:'result',resultVersion:2,title:'跨页调查',updatedAt:'2026-11-02T00:00:00.000Z',kind:'continue',planId:null,planVersion:null,planHash:null,approvalId:null,executionId:null};
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});
const reply=(data:unknown)=>({ok:true,status:200,json:async()=>data}) as Response;
it('reads its own server page and preserves exact original references and safe return destination',async()=>{
 const api=vi.mocked(authFetch);api.mockResolvedValue(reply({items:[item],nextCursor:'next',unavailable:false}));
 const view=new InvestigationAttention();document.body.append(view);await vi.waitFor(()=>expect(view.shadowRoot!.textContent).toContain('跨页调查'));await view.updateComplete;
 expect(api).toHaveBeenCalledTimes(1);expect(String(api.mock.calls[0][0])).toContain('/api/operations/workspace-attention');
 const link=new URL(view.shadowRoot!.querySelector('a')!.href);expect(link.searchParams.get('attentionVersion')).toBe('8');expect(link.searchParams.get('attentionResult')).toBe('result');expect(link.searchParams.get('returnTo')).toBe('/investigations');
 const next=[...view.shadowRoot!.querySelectorAll('button')].find(b=>b.textContent==='下一页待处理事项')!;next.click();await vi.waitFor(()=>expect(api).toHaveBeenCalledTimes(2));expect(String(api.mock.calls[1][0])).toContain('cursor=next');
 expect(api.mock.calls.every(([,init])=>!init?.method)).toBe(true);
});
it('action URLs bind current plan hash/version and original approval/execution',()=>{
 const url=new URL(attentionUrl({...item,kind:'reconcile',planId:'plan',planVersion:4,planHash:'hash',approvalId:'11',executionId:'send'}),'http://localhost');
 expect(url.pathname).toBe('/operations-actions');expect(Object.fromEntries(url.searchParams)).toMatchObject({plan:'plan',attentionPlanVersion:'4',attentionPlanHash:'hash',attentionExecution:'send',attentionApproval:'11',sourceInvestigation:'inv'});
});
it('clears records on revocation, including an in-flight late response',async()=>{
 let done!:(r:Response)=>void;const api=vi.mocked(authFetch);api.mockImplementation(()=>new Promise(r=>done=r));
 const view=new InvestigationAttention();document.body.append(view);await view.updateComplete;
 window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}}));done(reply({items:[item],nextCursor:null}));
 await vi.waitFor(()=>expect(view.shadowRoot!.textContent).toContain('内容已清除'));expect(view.shadowRoot!.querySelector('a')).toBeNull();
});
it('refresh projects disappearance of processed originals and exposes partial errors',async()=>{
 const api=vi.mocked(authFetch);api.mockResolvedValueOnce(reply({items:[item],nextCursor:null})).mockResolvedValueOnce(reply({items:[],nextCursor:null,unavailable:true}));
 const view=new InvestigationAttention();document.body.append(view);await vi.waitFor(()=>expect(view.shadowRoot!.querySelector('a')).not.toBeNull());
 view.shadowRoot!.querySelector('button')!.click();await vi.waitFor(()=>expect(view.shadowRoot!.textContent).toContain('部分行动资格暂无法核验'));expect(view.shadowRoot!.querySelector('a')).toBeNull();
});
