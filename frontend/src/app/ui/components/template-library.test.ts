import {afterEach,expect,it,vi} from 'vitest';
const {authFetch}=vi.hoisted(()=>({authFetch:vi.fn()}));
vi.mock('../../../api/index.js',()=>({authFetch}));
import './template-library.js';
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
afterEach(()=>{document.body.replaceChildren();authFetch.mockReset();});
it('discards a late library response after session revocation',async()=>{
 let release!:(value:Response)=>void;
 authFetch.mockImplementation((path:string)=>path.endsWith('/library')?new Promise(resolve=>{release=resolve;}):Promise.resolve(new Response(JSON.stringify({candidates:[],unavailable:[]}))));
 const element=document.createElement('template-library');document.body.append(element);await settle();
 window.dispatchEvent(new Event('slide-session-expired'));
 release(new Response(JSON.stringify({can_manage:true,templates:[{template:{name:'旧主体的模板',template_id:'old'},builtin:true,resource_types:['instance'],item_count:1}]})));await settle();
 expect(element.shadowRoot!.textContent).not.toContain('旧主体的模板');expect(element.shadowRoot!.textContent).toContain('登录或权限已变更');
});
it('explains read failure and offers refresh instead of claiming an empty library',async()=>{
 authFetch.mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({error:'TEMPLATE_STORE_UNAVAILABLE'}),{status:503})));
 const element=document.createElement('template-library');document.body.append(element);await settle();
 expect(element.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain('TEMPLATE_STORE_UNAVAILABLE');
 expect(element.shadowRoot!.textContent).not.toContain('没有匹配的原生模板');
 expect([...element.shadowRoot!.querySelectorAll('button')].some(button=>button.textContent?.includes('刷新模板库'))).toBe(true);
});

const fixture=()=>({can_manage:true,builtin:false,template:{template_id:'custom',name:'原名称',revision:1},versions:[],
 items:[{item_id:'item',version:1,display_name:'原监控项',canonical_metric:{id:'metric',semantic_version:'1'},unit:'count',dimensions:[],collector_ref:{package_release:'pkg@1#hash'}}],
 draft:{revision:1,aggregate:{items:[{item_id:'item',version:1}],triggers:[],parameters:{defaults:{interval_ms:60000},schema:{}}}}});
async function mounted(){
 authFetch.mockImplementation((path:string)=>Promise.resolve(new Response(JSON.stringify(path.endsWith('/library')?{can_manage:true,templates:[]}:path.endsWith('/capabilities')?{candidates:[],unavailable:[]}:fixture()))));
 const element:any=document.createElement('template-library');document.body.append(element);await settle();await element.open('custom');return element;
}
for(const read of ['load','open'])it(`R1 clears old facts after direct ${read} 403 and recovers`,async()=>{
 const element=await mounted();
 authFetch.mockResolvedValue(new Response(JSON.stringify({error:'FORBIDDEN'}),{status:403}));
 await (read==='load'?element.load():element.open('custom'));await settle();
 expect(element.library).toBeNull();expect(element.editor).toBeNull();expect(element.capabilities).toBeNull();expect(element.busy).toBe(false);
 authFetch.mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({can_manage:false,templates:[]}))));await element.load();expect(element.library.can_manage).toBe(false);
});
it('R1 ignores a late editor success after a direct read rejection',async()=>{
 const element=await mounted();let release!:(r:Response)=>void;
 authFetch.mockImplementationOnce(()=>new Promise(resolve=>release=resolve));const late=element.open('custom');
 authFetch.mockResolvedValue(new Response('{}',{status:403}));await element.load();release(new Response(JSON.stringify(fixture())));await late;
 expect(element.editor).toBeNull();expect(element.library).toBeNull();
});
it('R1 disables writes on permission rejection but preserves built-in business denial and read recovery',async()=>{
 const element=await mounted();authFetch.mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({error:'TEMPLATE_FORBIDDEN'}),{status:403})));
 await element.mutate('name',{},()=>{});expect(element.editor.can_manage).toBe(false);expect(element.library.can_manage).toBe(false);expect(element.retry).toBeNull();
 element.editor={...fixture(),builtin:true};await element.mutate('name',{},()=>{});expect(element.editor.can_manage).toBe(true);expect(element.error).toContain('内置模板');
 await element.mutate('copy',{},()=>{});expect(element.editor.can_manage).toBe(false);
});
for(const field of ['模板名称','监控项名称 item'])it(`R2 protects unsaved ${field} across close, draft save, publish and discard`,async()=>{
 const element=await mounted();const input=element.shadowRoot.querySelector(`input[aria-label="${field}"]`);input.value='未保存名称';input.dispatchEvent(new Event('input',{bubbles:true}));await settle();
 expect(element.unsaved).toBe(true);element.close();expect(element.editor).not.toBeNull();
 expect([...element.shadowRoot.querySelectorAll('button')].find((b:any)=>b.textContent==='发布不可变版本').disabled).toBe(true);
 authFetch.mockResolvedValueOnce(new Response(JSON.stringify({draft:fixture().draft})));await element.save();await settle();expect(element.unsaved).toBe(true);
 expect(element.shadowRoot.querySelector(`input[aria-label="${field}"]`).value).toBe('未保存名称');
 const discard=[...element.shadowRoot.querySelectorAll('button')].find((b:any)=>b.textContent==='放弃未保存修改') as HTMLButtonElement;discard.click();await settle();expect(element.unsaved).toBe(false);
 element.close();expect(element.editor).toBeNull();
});
it('R1 session rejection clears facts even on a built-in write',async()=>{
 const element=await mounted();element.editor={...fixture(),builtin:true};
 authFetch.mockResolvedValueOnce(new Response('{}',{status:401}));await element.mutate('name',{},()=>{});
 expect(element.editor).toBeNull();expect(element.library).toBeNull();expect(element.capabilities).toBeNull();expect(element.busy).toBe(false);
});
it('R1 control: unknown write retries retain the original operation key',async()=>{
 const element=await mounted();let attempt=0;const keys:string[]=[];
 authFetch.mockImplementation((_path:string,init:RequestInit)=>{keys.push(JSON.parse(String(init.body)).operation_key);return Promise.resolve(++attempt===1?new Response('{}',{status:503}):new Response('{}'));});
 await element.mutate('name',{name:'同键恢复'},()=>{});expect(element.retry).toBeTruthy();await element.retry();expect(keys[0]).toBe(keys[1]);expect(element.retry).toBeNull();
});
