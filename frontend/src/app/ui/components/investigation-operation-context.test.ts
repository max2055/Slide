import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import './investigation-operation-context.ts';
vi.mock('../../../api/index.ts',()=>({authFetch:vi.fn()}));
const api=vi.mocked(authFetch);
const json=(value:unknown)=>({ok:true,status:200,json:async()=>value}) as Response;
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
beforeEach(()=>{api.mockReset();});
afterEach(()=>{document.body.replaceChildren();});
it('strips investigation roles from strict correlation resource refs, renders partial and unknown score bounds',async()=>{
  api.mockResolvedValueOnce(json({id:'snapshot'})).mockResolvedValueOnce(json({id:'snapshot',version:1,from:'from',until:'until',ruleVersion:'rule',partial:true,authorizedCounts:{total:1},nextCursor:null,
    items:[{id:'group',eventIds:['one','two'],investigationIds:[],severity:'warning',reasons:[],missing:['baseline'],currentValidity:'unknown',score:{lower:45,upper:60,coverage:0.85,components:{baseline:null}}}]}));
  const view=document.createElement('investigation-operation-context') as any;view.investigationId='inv';view.resources=[{type:'server',id:3,role:'primary'}];document.body.append(view);await flush();
  [...view.shadowRoot.querySelectorAll('button')].find((b:any)=>b.textContent.includes('评估当前关联事项')).click();await flush();
  expect(JSON.parse(api.mock.calls[0][1]!.body as string).resources).toEqual([{type:'server',id:3}]);
  expect(view.shadowRoot.textContent).toContain('45–60');expect(view.shadowRoot.textContent).toContain('部分数据不可用');expect(view.shadowRoot.textContent).toContain('有效性未知');
  window.dispatchEvent(new Event('slide-session-expired'));await flush();expect(view.shadowRoot.textContent).not.toContain('45–60');
});
it('an unqualified baseline never becomes a normal comparison and static evidence remains separate',async()=>{
  api.mockResolvedValueOnce(json({id:'b',version:1,contentHash:'hash',result:{state:'not_qualified',status:'unknown',mode:'weekly',reason:'insufficient_valid_days',validUntil:new Date(Date.now()+60000).toISOString(),
    quality:{validDays:9,coverage:0.78,samples:100,missing:20},training:{from:'start',until:'split'},validation:{from:'split',until:'end'},
    comparison:{value:42,baselineAnomaly:false,reference:{lower:40,upper:50,median:45}},staticComparison:{status:'known',anomaly:true,value:42}}}));
  const view=document.createElement('operations-behavior-baseline') as any;view.resourceId=3;view.metric='host.cpu.utilization';view.dimensions={cpu:'all'};document.body.append(view);await flush();
  [...view.shadowRoot.querySelectorAll('button')].find((b:any)=>b.textContent.includes('评估此指标基线')).click();await flush();
  expect(JSON.parse(api.mock.calls[0][1]!.body as string)).toMatchObject({resource:{type:'instance',id:3},metric:'host.cpu.utilization',dimensions:{cpu:'all'},mode:'weekly'});
  expect(view.shadowRoot.textContent).toContain('偏离状态未知');expect(view.shadowRoot.textContent).toContain('有效观测天数不足');
  expect(view.shadowRoot.textContent).not.toContain('位于参考区间内');expect(view.shadowRoot.textContent).toContain('触发阈值');expect(view.shadowRoot.querySelector('metric-chart')).toBeNull();
});
it('relation suggestions retain provenance and never render as confirmed',async()=>{
  api.mockResolvedValueOnce(json({resource:{type:'server',id:3},partial:true,edges:[{relationId:'7',version:1,contentHash:'hash',source:{type:'instance',id:2},target:{type:'server',id:3},relationType:'runs_on',provenance:'model',verification:'suggested',state:'suggested',validFrom:'from',validUntil:null}]}));
  const view=document.createElement('operations-resource-relations') as any;view.resourceType='server';view.resourceId=3;document.body.append(view);await flush();
  view.shadowRoot.querySelector('button').click();await flush();
  expect(view.shadowRoot.textContent).toContain('模型建议');expect(view.shadowRoot.textContent).toContain('待确认');expect(view.shadowRoot.textContent).toContain('仅部分可见');
  const badge=view.shadowRoot.querySelector('app-badge');expect(badge.textContent).not.toContain('已确认');
});
