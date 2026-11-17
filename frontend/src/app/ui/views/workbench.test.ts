import { afterEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import { WorkbenchPage } from './workbench.ts';
vi.mock('../../../api/index.ts',()=>({authFetch:vi.fn(async()=>({ok:true,status:200,json:async()=>({items:[],partial:false,nextCursor:null})}))}));
afterEach(()=>{ document.body.replaceChildren();vi.mocked(authFetch).mockClear();history.replaceState({},'','/'); });
async function mount(path:string, permissions:string[]) {
  history.replaceState({},'',path);
  const page=new WorkbenchPage();page.permissions=new Set(permissions);document.body.append(page);
  await page.updateComplete;await new Promise(r=>setTimeout(r,0));return page;
}
it('action-only role enters without fetching investigation content or writing',async()=>{
  const page=await mount('/workbench',['operations:actions:view']);
  expect(page.querySelector('operations-actions')).not.toBeNull();
  expect(page.querySelector('investigations-page')).toBeNull();
  expect(vi.mocked(authFetch).mock.calls.every(([url,opts])=>!String(url).startsWith('/api/investigations')&&(!opts?.method||opts.method==='GET'))).toBe(true);
});
it('investigation-only role cannot mount actions from a deep link',async()=>{
  const page=await mount('/workbench?workspaceTab=actions&plan=secret',['chat:view']);
  expect(page.querySelector('operations-actions')).toBeNull();
  expect(page.textContent).toContain('无访问权限');expect(authFetch).not.toHaveBeenCalled();
});
it('revocation unmounts action records, retains disabled labelled controls',async()=>{
  const page=await mount('/workbench?workspaceTab=actions',['operations:actions:view']);
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}}));await page.updateComplete;
  expect(page.querySelector('operations-actions')).toBeNull();
  expect([...page.querySelectorAll('nav button')].every(b=>(b as HTMLButtonElement).disabled)).toBe(true);
  expect(page.querySelector('nav')?.getAttribute('aria-label')).toBe('工作台页签');
});
for (const delivery of ['event', 'property']) it(`selects actions when initial permissions arrive by ${delivery}`,async()=>{
  const page=await mount('/workbench',[]);
  if(delivery==='event') window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:['operations:actions:view']}}));
  else page.permissions=new Set(['operations:actions:view']);
  await page.updateComplete;
  expect(page.querySelector('operations-actions')).not.toBeNull();
  expect(new URL(location.href).searchParams.get('workspaceTab')).toBe('actions');
});
for (const query of ['investigation=exact&version=7', 'entry=exact', 'workspaceTab=investigations']) it(`retains explicit investigation context ${query} on async permissions`,async()=>{
  const page=await mount(`/workbench?${query}`,[]);
  page.permissions=new Set(['operations:actions:view']);await page.updateComplete;
  expect(page.querySelector('operations-actions')).toBeNull();
  expect(location.search).toBe(`?${query}`);
  expect(page.textContent).toContain('无访问权限');
});
it('retains a manually selected home tab after authority changes',async()=>{
  const page=await mount('/workbench',['chat:view','operations:actions:view']);
  page.querySelector<HTMLButtonElement>('nav button')!.click();
  page.permissions=new Set(['operations:actions:view']);await page.updateComplete;
  expect(page.querySelector('operations-actions')).toBeNull();
  expect(location.search).toBe('');expect(page.textContent).toContain('无访问权限');
});

it('separates the summary homepage from the full investigation list',async()=>{
 const page=await mount('/workbench',['chat:view']);
 expect(page.querySelector('investigation-attention')).not.toBeNull();
 expect(page.querySelector('investigations-page')).toBeNull();
 const list=[...page.querySelectorAll<HTMLButtonElement>('nav button')].find(b=>b.textContent==='调查列表')!;
 list.click();await page.updateComplete;
 expect(page.querySelector('investigation-attention')).toBeNull();
 expect(page.querySelector('investigations-page')).not.toBeNull();
 expect(location.search).toBe('?workspaceTab=investigations');
});
