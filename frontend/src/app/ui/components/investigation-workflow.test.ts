import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {InvestigationWorkflowView,type WorkflowPage} from './investigation-workflow.ts';
import {investigationApi,InvestigationApiError} from '../controllers/investigation-api.ts';
vi.mock('../controllers/investigation-api.ts',async original=>({...await original<object>(),investigationApi:vi.fn()}));
const api=vi.mocked(investigationApi);
const page=():WorkflowPage=>({investigationId:'one',version:2,scopeVersion:'scope',resources:[{type:'instance',id:1,role:'primary'}],suggestions:[{relationId:'10',version:1,hash:'a'.repeat(64),resource:{type:'server',id:2},origin:'manual',state:'suggested',relationType:'runs_on',observedAt:'2026-11-01T00:00:00.000Z',validUntil:null}],partial:false,receipts:[],nextBefore:null});
let view:InvestigationWorkflowView;
const flush=async()=>{await new Promise(r=>setTimeout(r,0));await view.updateComplete;};
const check=(name:string)=>(view.shadowRoot!.querySelector(`[aria-label="${name}"]`) as HTMLInputElement).click();
const button=(name:string)=>[...view.shadowRoot!.querySelectorAll('button')].find(b=>b.textContent===name)!;
async function mount(){view=new InvestigationWorkflowView();view.investigationId='one';view.version=2;view.eventIds=[8];document.body.append(view);await flush();}
beforeEach(()=>{api.mockReset();api.mockResolvedValue(page());localStorage.setItem('user','{"id":1}');sessionStorage.clear();});
afterEach(()=>{view?.remove();localStorage.clear();sessionStorage.clear();});
it('requires an explicit sourced selection and confirmation; same-value parent renders keep one accepted command',async()=>{
 await mount();expect(api.mock.calls.every(c=>!c[1]?.method)).toBe(true);
 expect(button('保存确认的范围').disabled).toBe(true);check('纳入关联对象 server:2');await flush();check('确认关联范围变化');await flush();
 let resolve!:(v:any)=>void;api.mockImplementation((_,init)=>init?.method==='POST'?new Promise(r=>resolve=r):Promise.resolve(page()));
 const accepted=vi.fn();view.addEventListener('investigation-workflow-saved',accepted);button('保存确认的范围').click();await flush();view.version=3;view.eventIds=[8];await flush();
 resolve({id:'receipt',version:3});await flush();await flush();
 const posts=api.mock.calls.filter(c=>c[1]?.method==='POST');expect(posts).toHaveLength(1);
 expect(JSON.parse(posts[0][1]!.body as string)).toEqual({expectedVersion:2,confirmed:true,add:[{relationId:'10',version:1,hash:'a'.repeat(64)}],remove:[]});expect(accepted).toHaveBeenCalledTimes(1);
});
it('unknown acceptance survives refresh and reconciles the original body/key despite a newer displayed version',async()=>{
 await mount();check('纳入关联对象 server:2');await flush();check('确认关联范围变化');await flush();
 api.mockRejectedValueOnce(new InvestigationApiError(503,'INVESTIGATION_QUEUE_UNAVAILABLE'));button('保存确认的范围').click();await flush();
 const first=api.mock.calls.find(c=>c[1]?.method==='POST')!;expect(button('核对原范围提交').disabled).toBe(false);
 view.remove();await mount();view.version=4;await flush();api.mockResolvedValue(page());button('核对原范围提交').click();await flush();
 const posts=api.mock.calls.filter(c=>c[1]?.method==='POST');expect(posts).toHaveLength(2);expect(posts[1]).toEqual(first);
});
it('withdrawal erases source, unknown command and late responses',async()=>{
 await mount();check('纳入关联对象 server:2');await flush();check('确认关联范围变化');await flush();
 let resolve!:(v:any)=>void;api.mockImplementationOnce(()=>new Promise(r=>resolve=r));button('保存确认的范围').click();await flush();
 window.dispatchEvent(new Event('slide-session-expired'));resolve({id:'late'});await flush();
 expect(view.shadowRoot!.textContent).not.toContain('纳入下一调查范围');expect(sessionStorage.length).toBe(0);expect(button('刷新范围与复测记录').disabled).toBe(false);
 api.mockResolvedValue(page());button('刷新范围与复测记录').click();await flush();expect(view.shadowRoot!.textContent).toContain('纳入下一调查范围');expect(button('保存确认的范围').disabled).toBe(true);
});
it('a changed relation version requires reviewing the new source instead of silently rebinding confirmation',async()=>{
 await mount();check('纳入关联对象 server:2');await flush();check('确认关联范围变化');await flush();
 api.mockResolvedValue({...page(),suggestions:[{...page().suggestions[0],version:2,hash:'b'.repeat(64)}]});button('刷新范围与复测记录').click();await flush();
 expect(button('保存确认的范围').disabled).toBe(true);expect((view.shadowRoot!.querySelector('[aria-label="纳入关联对象 server:2"]') as HTMLInputElement).checked).toBe(false);
});
