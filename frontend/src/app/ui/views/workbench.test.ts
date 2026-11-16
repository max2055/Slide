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
