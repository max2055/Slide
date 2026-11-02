import {authFetch} from '../../../api/index.ts';
vi.mock('../../../api/index.ts',()=>({authFetch:vi.fn()}));
import {afterEach,expect,it,vi} from 'vitest';
import {handoffText, InvestigationHandoff} from './investigation-handoff.ts';
import './investigation-handoff.ts';
afterEach(()=>{document.body.replaceChildren();vi.clearAllMocks();});
const detail:any={id:'investigation',title:'服务调查',goal:'原绝对窗口的调查',version:8,lifecycle:'open',problemStatus:'unconfirmed',resources:[{type:'server',id:12}]};
const result:any={id:'result',version:3,runId:'run',result:{createdAt:'2026-01-01T00:00:00Z',summary:'<script>未验证</script>',facts:[{statement:'响应失败',evidenceIds:['proof']}],claims:[{contradictingEvidenceIds:['counter']}],unresolvedQuestions:['缺后续观测'],recommendations:[{action:'读取后续观测'}]}};
it('projects versioned facts, evidence, counterevidence and missing data without claiming recovery',()=>{
 const text=handoffText(detail,result);expect(text).toContain('结果 V3');expect(text).toContain('proof');expect(text).toContain('counter');expect(text).toContain('缺后续观测');expect(text).toContain('不作恢复证明');
 expect(handoffText(detail)).toContain('暂无已保存结果');
});
it('renders untrusted summary as text and clears the projection when parent access is withdrawn',async()=>{
 const view=new InvestigationHandoff();view.detail=detail;view.result=result;document.body.append(view);await view.updateComplete;
 expect(view.shadowRoot!.querySelector('script')).toBeNull();expect(view.shadowRoot!.textContent).toContain('<script>');
 view.detail=undefined;view.result=undefined;await view.updateComplete;expect(view.shadowRoot!.textContent).not.toContain('响应失败');
});

it('reads action and feedback originals only on explicit request and marks partial/old records in the copied projection',async()=>{
 const api=vi.mocked(authFetch);api.mockImplementation(async url=>({ok:true,status:200,json:async()=>String(url).includes('/workflow')?{receipts:[{id:'measure',kind:'retest',version:4,createdAt:'2026-01-01',conclusion:'insufficient_evidence',gaps:['缺观测']}],nextBefore:null}:String(url).includes('/operations/')?{items:[{id:'plan',version:2,state:'pending_approval',content:{resultVersion:1},executions:[]}],nextCursor:'next'}:{items:[{id:'feedback',createdAt:'2026-01-01',command:{kind:'rating',resultVersion:1,note:'人工待核实'},staleResult:true}],nextBefore:null}} as Response));
 const view=new InvestigationHandoff();view.detail=detail;view.result=result;document.body.append(view);await view.updateComplete;
 expect(api).not.toHaveBeenCalled();await (view as any).readReferences();await view.updateComplete;
 expect(api).toHaveBeenCalledTimes(3);expect(api.mock.calls.every(([,init])=>!init?.method)).toBe(true);
 expect(view.shadowRoot!.textContent).toContain('旧结果计划');expect(view.shadowRoot!.textContent).toContain('存在未展开');
 expect(view.shadowRoot!.textContent).toContain('人工待核实');expect(view.shadowRoot!.querySelector('a')!.getAttribute('href')).toBe('/operations-actions?plan=plan');
});
