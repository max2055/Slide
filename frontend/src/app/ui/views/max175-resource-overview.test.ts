import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { authFetch } from '../../../api/index.js';
import { InstanceDetailPage } from './instance-detail.js';
vi.mock('../../../api/index.js', () => ({authFetch:vi.fn()}));
const fetch = vi.mocked(authFetch);
const roots: HTMLElement[] = [];
const snapshot = (overrides = {}) => ({resource:{type:'instance',id:1},label:'订单库',status:'healthy',quality:'good',freshness:'fresh',observedAt:new Date().toISOString(),unresolvedAlerts:0,relationCount:0,impactScope:[],gaps:[], ...overrides});
function page() { const el=new InstanceDetailPage() as any; el.instanceId=1; el.instance={name:'订单库',db_type:'mysql',host:'local',port:3306}; return el; }
function text(el:any) {const root=document.createElement('div');roots.push(root);render(el._renderOverview(),root);return root.textContent!;}
afterEach(()=>{fetch.mockReset();roots.forEach(root=>root.remove());roots.length=0;});
it('keeps overview distinct from metrics and exposes the next evidence steps',()=>{
  const el=page();el.overview=snapshot();const content=text(el);
  expect(content).toContain('当前需要关注'); expect(content).toContain('核对指标与时间范围');expect(content).toContain('查看日志与完整事件');
  expect(roots[0].querySelector('semantic-metrics')).toBeNull();
});
it.each([
  {freshness:'stale',observedAt:new Date(Date.now()-600_000).toISOString(),gaps:['OBSERVATIONS_STALE']},
  {freshness:'missing',observedAt:null,gaps:['OBSERVATIONS_EMPTY']},
  {quality:'partial',gaps:[]},
  {gaps:['ALERTS_UNAVAILABLE']},
])('never promotes incomplete snapshot evidence to healthy: %j',overrides=>{
  const el=page();el.overview=snapshot(overrides);expect(text(el)).toContain('当前证据不足以判断运行状态');
});
it('discards a previous resource response even after returning to its id',async()=>{
  let finish!:(response:Response)=>void;
  fetch.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
  const el=page();const old=el.loadOverview();
  el.instanceId=2;fetch.mockResolvedValue(new Response(JSON.stringify({items:[snapshot({resource:{type:'instance',id:2}})]})));await el.loadOverview();
  el.instanceId=1;fetch.mockResolvedValue(new Response(JSON.stringify({items:[snapshot({label:'current'})]})));await el.loadOverview();
  finish(new Response(JSON.stringify({items:[snapshot({label:'obsolete'})]})));await old;
  expect(el.overview.label).toBe('current');
});
it('clears previous evidence on failed/forbidden reads and malformed success',async()=>{
  const el=page();
  for(const response of [new Response('{}',{status:403}),new Response('{}',{status:503}),new Response('{}'),new Response(JSON.stringify({items:[{resource:{type:'instance',id:1},status:'healthy'}]}))]) {
    el.overview=snapshot();fetch.mockResolvedValue(response);await el.loadOverview();
    expect(el.overview).toBeNull();expect(el.overviewError).not.toBe('');expect(text(el)).not.toContain('当前观测未提示运行异常');
  }
});
