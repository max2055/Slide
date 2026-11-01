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
