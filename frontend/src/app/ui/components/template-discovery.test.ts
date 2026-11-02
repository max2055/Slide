import {afterEach,expect,it,vi} from 'vitest';
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('./metric-api.js',()=>({metricRequest:request,MetricRequestError:class extends Error {constructor(readonly status:number){super(String(status));}}}));
vi.mock('./native-template-configuration.js',()=>({}));
import './template-discovery.js';
import {MetricRequestError} from './metric-api.js';
const settle=()=>new Promise(r=>setTimeout(r,0));
const deferred=()=>{let resolve!:(v:any)=>void,reject!:(e:any)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const row=(name:string)=>({template_id:'tpl',rule_id:'rule',revision:1,state:{template_version:1,items:[{}],triggers:[{}],members:[{id:'same-instance',name,state:'active'}]}});
const state=(name:string)=>({rows:[row(name)]});
async function mount(){
  request.mockImplementation(async(path:string)=>path==='template-governance/resources'?[{type:'network_device',id:1,name:'A'},{type:'network_device',id:2,name:'B'}]:{rows:[]});
  const e:any=document.createElement('template-discovery');
  e.version={template_id:'tpl',version:1,content_hash:'hash',aggregate:{discovery_rules:[{}]}};document.body.append(e);await settle();await e.updateComplete;return e;
}
async function select(e:any,value:string){const s=e.shadowRoot.querySelector('select[aria-label="发现授权资源"]');s.value=value;s.dispatchEvent(new Event('change'));await settle();await e.updateComplete;}
afterEach(()=>{document.body.replaceChildren();request.mockReset();localStorage.clear();});
it.each([['builtin:linux.interface-discovery.v1','interface_epoch'],['builtin:mysql.innodb-discovery.v1','table_epoch'],['builtin:linux.filesystem-discovery.v1','filesystem_epoch']])('MAX245: %s fixes identity independently of display dimensions',async(implementation,identity)=>{
  const e=await mount();e.aggregate={discovery_rules:[],triggers:[]};e.item='prototype';
  e.items=[{item_id:'prototype',display_name:'动态原型',canonical_metric:{id:'test'},collector_ref:{implementation_id:implementation,package_release:'pin'}}];
  e.capabilities={candidates:[{metric:{id:'test'},package_release:'pin',dimensions:[{name:identity},{name:'display_name'}]}]};
  let rules:any;e.addEventListener('discovery-change',(event:any)=>rules=event.detail);e.add();
  expect(rules[0].identity_dimensions).toEqual([identity]);
});
it.each([200,401,403])('Chief R3: A late %s never overwrites B or clears its rows',async status=>{
  const e=await mount(),a=deferred();
  request.mockImplementation((path:string)=>path==='discovery/network_device/1'?a.promise:Promise.resolve(state('B-row')));
  await select(e,'network_device:1');await select(e,'network_device:2');
  if(status===200)a.resolve(state('A-row'));else a.reject(new MetricRequestError(status));await settle();await e.updateComplete;
  expect(e.shadowRoot.textContent).toContain('B-row');expect(e.shadowRoot.textContent).not.toContain('A-row');
  e.shadowRoot.querySelector('app-data-table').querySelector('button').click();await settle();
  expect(request).toHaveBeenLastCalledWith('discovery/network_device/2/stop',expect.objectContaining({instance_id:'same-instance'}),expect.any(AbortSignal));
});
it('Chief R3: clearing selection invalidates pending load and detached old row actions',async()=>{
  const e=await mount();request.mockResolvedValue(state('A-row'));await select(e,'network_device:1');
  const oldButton=e.shadowRoot.querySelector('app-data-table').querySelector('button');
  const a=deferred();request.mockReturnValue(a.promise);const pending=e.loadState();await select(e,'');
  const count=request.mock.calls.length;oldButton.click();expect(request.mock.calls).toHaveLength(count);
  a.resolve(state('A-row'));await pending;await e.updateComplete;expect(e.instances).toBeNull();expect(e.busy).toBe(false);
});
it('Chief R3: latest refresh wins, loading blocks stop, version/session changes invalidate stale rows',async()=>{
  const e=await mount();request.mockResolvedValue(state('old'));await select(e,'network_device:1');
  const oldStop=()=>e.stop(eContext,oldRow,'same-instance','disabled');const eContext=e.stateContext,oldRow=e.instances.rows[0];
  const a=deferred(),b=deferred();request.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const first=e.loadState(),second=e.loadState();await e.updateComplete;expect(e.busy).toBe(true);
  b.resolve(state('new'));await second;a.resolve(state('old'));await first;await e.updateComplete;
  expect(e.shadowRoot.textContent).toContain('new');expect(e.instances.rows[0].state.members[0].name).toBe('new');
  const count=request.mock.calls.length;oldStop();expect(request.mock.calls).toHaveLength(count);
  const current=e.shadowRoot.querySelector('app-data-table').querySelector('button');localStorage.setItem('token','different-session');current.click();expect(request.mock.calls).toHaveLength(count);
  request.mockResolvedValue([]);e.version={...e.version,version:2};await settle();await e.updateComplete;expect(e.instances).toBeNull();
});

it('Chief R3: stale preview never starts a state read on the new resource; permission event invalidates in-flight requests',async()=>{
  const e=await mount();request.mockResolvedValue({rows:[]});await select(e,'network_device:1');
  const pending=deferred();request.mockReturnValueOnce(pending.promise);const preview=e.enumerate();
  const previewSignal=request.mock.calls.at(-1)![2];await select(e,'network_device:2');expect(previewSignal.aborted).toBe(true);
  const count=request.mock.calls.length;pending.resolve({state:'completed',rules:[]});await preview;expect(request.mock.calls).toHaveLength(count);expect(e.preview).toBeNull();
  window.dispatchEvent(new Event('slide-permissions-loaded'));await e.updateComplete;expect(e.selected).toBe('');expect(e.instances).toBeNull();expect(e.busy).toBe(false);
});
