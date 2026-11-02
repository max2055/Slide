import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('./native-template-configuration.js',()=>({}));
import './template-discovery.js';
import {apiClient,authFetch} from '../../../api/index.js';
const settle=()=>new Promise(r=>setTimeout(r,0));
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const row=(name='port',state='active')=>({template_id:'tpl',rule_id:'rule',revision:1,state:{template_version:1,items:[],triggers:[],members:[{id:'instance',name,state}]}});
const result=()=>({rows:[row()]});
const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>resolve=r);return{promise,resolve};};
async function mount(){
 const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>String(url).endsWith('/resources')?json([{type:'network_device',id:1,name:'A'}]):json(result()));
 const el:any=document.createElement('template-discovery');el.version={template_id:'tpl',version:1,content_hash:'hash',aggregate:{discovery_rules:[]}};
 document.body.append(el);await settle();await el.updateComplete;el.changeResource('network_device:1');await el.loadState();return{el,fetch};
}
beforeEach(()=>{localStorage.clear();sessionStorage.clear();apiClient.setToken('old-access');apiClient.setRefreshToken('refresh');});
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();localStorage.clear();sessionStorage.clear();});
for(const action of ['read','preview','stop'] as const)for(const rotation of ['own','parallel'] as const){
 it(`Chief R3 refresh: ${action} completes after ${rotation} request refresh using actual authFetch`,async()=>{
  const {el,fetch}=await mount(),held=deferred(),seen=deferred();let reads=0,refreshes=0,targets=0;
  const target=action==='preview'?'/discovery-preview':action==='stop'?'/stop':'/discovery/network_device/1';
  const expected=action==='preview'?{state:'completed',rules:[]}:action==='stop'?{rows:[row('stopped','disabled')]}:result();
  fetch.mockImplementation(async(url)=>{
   const path=String(url);
   if(path==='/api/auth/refresh'){refreshes++;return json({token:'renewed-access',refreshToken:'renewed-refresh'});}
   if(path.endsWith('/concurrent-refresh'))return ++reads===1?json({},401):json({ok:true});
   if(path.endsWith(target)){targets++;if(rotation==='parallel'){seen.resolve(null);return held.promise;}return targets===1?json({},401):json(expected);}
   return json(result());
  });
  const pending=action==='read'?el.loadState():action==='preview'?el.enumerate():el.stop(el.stateContext,el.instances.rows[0],'instance','disabled');
  if(rotation==='parallel'){await seen.promise;await authFetch('/api/metrics/concurrent-refresh');held.resolve(json(expected));}
  await pending;await el.updateComplete;
  expect(refreshes).toBe(1);expect(apiClient.getToken()).toBe('renewed-access');expect(el.busy).toBe(false);
  expect(el.selected).toBe('network_device:1');expect(el.error).toBe('');
  if(action==='preview')expect(el.preview).toEqual(expected);else expect(el.instances).toEqual(expected);
  expect(targets).toBe(rotation==='own'?2:1);
 });
}
it.each(['user','logout','permissions','version'])('Chief R3 refresh: a real %s context change rejects old results and finishes loading',async change=>{
 const {el,fetch}=await mount(),held=deferred();fetch.mockReturnValue(held.promise);const pending=el.loadState();
 if(change==='user')apiClient.setToken('other-user');
 if(change==='logout')apiClient.setToken(null);
 if(change==='permissions')window.dispatchEvent(new Event('slide-permissions-loaded'));
 if(change==='version'){el.version={...el.version,version:2};fetch.mockResolvedValue(json([]));await el.updateComplete;}
 held.resolve(json({rows:[row('obsolete')]}));await pending;await el.updateComplete;
 expect(el.instances).toBeNull();expect(el.busy).toBe(false);
});
it('Chief R3 refresh: unknown committed stop response is never automatically replayed',async()=>{
 const {el,fetch}=await mount();fetch.mockRejectedValue(new TypeError('response lost'));
 await el.stop(el.stateContext,el.instances.rows[0],'instance','disabled');await settle();
 expect(fetch).toHaveBeenCalledTimes(3); // two mount reads and exactly one stop
 expect(fetch.mock.calls.filter(([url])=>String(url).endsWith('/stop'))).toHaveLength(1);
 expect(el.busy).toBe(false);expect(el.stateContext).toBeNull();expect(el.error).toContain('response lost');
});
