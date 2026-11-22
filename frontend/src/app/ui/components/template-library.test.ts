import {afterEach,expect,it,vi} from 'vitest';
const {authFetch}=vi.hoisted(()=>({authFetch:vi.fn()}));
vi.mock('../../../api/index.js',()=>({authFetch}));
import './template-library.js';
import type { TemplateLibraryPage } from './template-library.js';
import type { AppDialog } from './app-dialog.js';
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
 expect(element.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain('暂时无法完成操作');
 expect(element.shadowRoot!.textContent).not.toContain('没有匹配的模板');
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
it('keeps edit fields out of the published view and confirms leaving an unsaved edit', async () => {
  const element = await mounted();
  const root = element.shadowRoot!;
  expect(root.querySelector('input[aria-label="模板名称"]')).toBeNull();
  await element.open('custom', true);
  const input = root.querySelector('input[aria-label="模板名称"]') as HTMLInputElement;
  input.value = '未保存名称'; input.dispatchEvent(new Event('input'));
  await settle();
  await element.leave();
  expect(element.discard).toBe(true);
  expect(element.editor).not.toBeNull();
  await element.back();
  expect(element.editor).toBeNull();
});

it.each([false, true])('explains removed trigger dependencies when saving with publish=%s', async publish => {
  const element = await mounted();
  await element.open('custom', true);
  authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'TRIGGER_DEPENDENCY_UNKNOWN' }), { status: 422 }));
  await element.save(publish);
  await element.updateComplete;
  expect(authFetch.mock.calls.at(-1)?.[0]).toBe('/api/metrics/templates/custom/save');
  expect(JSON.parse(authFetch.mock.calls.at(-1)?.[1].body).publish).toBe(publish);
  expect(element.shadowRoot.querySelector('[role="alert"]')?.textContent).toContain('先在已发布模板中解除触发器依赖');
  expect(element.editing).toBe(true);
  expect(element.retry).toBeNull();
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

it('creates and opens a draft from an empty library and safely retries an uncertain response', async () => {
  const writes: Array<{ name: string; operation_key: string }> = [];
  authFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path.endsWith('/templates') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)));
      return Promise.resolve(writes.length === 1 ? new Response('{}', { status: 503 })
        : Response.json({ template: fixture().template }));
    }
    if (path.endsWith('/library')) return Promise.resolve(Response.json({ can_manage: true, templates: [] }));
    if (path.endsWith('/capabilities')) return Promise.resolve(Response.json({ candidates: [], unavailable: [] }));
    return Promise.resolve(Response.json(fixture()));
  });
  const element = document.createElement('template-library') as TemplateLibraryPage;
  document.body.append(element);
  await settle();
  const root = element.shadowRoot!;
  [...root.querySelectorAll('button')].find(button => button.textContent === '新建模板')!.click();
  await element.updateComplete;
  const field = root.querySelector<HTMLInputElement>('input[aria-label="新模板名称"]')!;
  field.value = '原名称';
  field.dispatchEvent(new Event('input'));
  await element.updateComplete;
  root.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await settle();
  expect(field.disabled).toBe(true);
  [...root.querySelectorAll('button')].find(button => button.textContent === '重试同一操作')!.click();
  await settle();
  expect(writes).toEqual([{ name: '原名称', operation_key: expect.any(String) }, writes[0]]);
  expect(root.querySelector<AppDialog>('app-dialog')?.open).toBe(false);
  expect(root.querySelector<HTMLInputElement>('input[aria-label="模板名称"]')?.value).toBe('原名称');
});

it('disables opening another template until the pending create result is known', async () => {
  const template = fixture().template;
  authFetch.mockImplementation((path: string) => {
    if (path.endsWith('/library')) return Promise.resolve(Response.json({
      can_manage: true, templates: [{ template, builtin: false, resource_types: ['instance'], item_count: 1 }],
    }));
    if (path.endsWith('/capabilities')) return Promise.resolve(Response.json({ candidates: [], unavailable: [] }));
    return Promise.resolve(new Response('{}', { status: 503 }));
  });
  const element = document.createElement('template-library') as TemplateLibraryPage;
  document.body.append(element);
  await settle();
  const root = element.shadowRoot!;
  [...root.querySelectorAll('button')].find(button => button.textContent === '新建模板')!.click();
  await element.updateComplete;
  const field = root.querySelector<HTMLInputElement>('input[aria-label="新模板名称"]')!;
  field.value = '另一个模板';
  field.dispatchEvent(new Event('input'));
  await element.updateComplete;
  root.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await settle();
  expect(root.querySelector<HTMLButtonElement>('button[data-template-id]')?.disabled).toBe(true);
});

it('keeps an acknowledged draft in the list when the first editor read fails', async () => {
  authFetch.mockImplementation((path: string) => {
    if (path.endsWith('/templates')) return Promise.resolve(Response.json({ template: fixture().template }));
    if (path.endsWith('/library')) return Promise.resolve(Response.json({ can_manage: true, templates: [] }));
    if (path.endsWith('/capabilities')) return Promise.resolve(Response.json({ candidates: [], unavailable: [] }));
    return Promise.resolve(new Response('{}', { status: 503 }));
  });
  const element = document.createElement('template-library') as TemplateLibraryPage;
  document.body.append(element);
  await settle();
  const root = element.shadowRoot!;
  [...root.querySelectorAll('button')].find(button => button.textContent === '新建模板')!.click();
  await element.updateComplete;
  const field = root.querySelector<HTMLInputElement>('input[aria-label="新模板名称"]')!;
  field.value = '原名称';
  field.dispatchEvent(new Event('input'));
  await element.updateComplete;
  root.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await settle();
  expect(root.querySelector('[role="status"]')?.textContent).toContain('草稿已创建');
  expect(root.querySelector('button[data-template-id="custom"]')).not.toBeNull();
  expect(root.querySelector('[role="alert"]')).not.toBeNull();
  expect(authFetch.mock.calls.filter(([path]) => path.endsWith('/library'))).toHaveLength(1);
});
