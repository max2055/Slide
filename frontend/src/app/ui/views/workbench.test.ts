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

it('renders investigation list subjects and outcome states from the authorized list payload', async () => {
  const base = { lifecycle: 'open', createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T01:00:00Z', resources: [{ type: 'server', id: 9, role: 'primary' }] };
  const items = [
    { ...base, id: 'active', title: '检查磁盘', activeRequestId: 'request', context: { entry: { sourceEventIds: [22899] } },
      latestOutcome: { summary: '历史观测显示使用量回落。', gaps: ['当前采集样本缺失'] } },
    { ...base, id: 'failed', title: '检查服务', derivedRunState: 'failed', latestOutcome: null },
    { ...base, id: 'missing', title: '检查连接', latestOutcome: null },
  ];
  await vi.mocked(authFetch).withImplementation(async () => ({
    ok: true, status: 200, json: async () => ({ items, authorizedCounts: { total: items.length }, nextCursor: null }),
  }) as Response, async () => {
    const page = await mount('/workbench?workspaceTab=investigations', ['chat:view', 'alert:view']);
    const list = page.querySelector('investigations-page')!;
    const row = (id: string) => list.querySelector(`[data-investigation="${id}"]`)?.closest('tr');
    await vi.waitFor(() => expect(row('active')).toBeTruthy());
    expect(row('active')?.cells[0].textContent).toContain('事件 #22899');
    expect(row('active')?.cells[0].textContent).toContain('服务器 #9');
    expect(row('active')?.cells[1].textContent).toMatch(/创建.+更新/s);
    expect(row('active')?.cells[2].textContent).toContain('调查中');
    expect(row('active')?.cells[3].textContent).toContain('来自上次已保存结果');
    expect(row('active')?.cells[3].textContent).toContain('当前采集样本缺失');
    expect(row('active')?.textContent).not.toContain('历史观测显示使用量回落。');
    expect(row('failed')?.cells[2].textContent).toContain('执行失败');
    expect(row('missing')?.cells[2].textContent).toContain('执行状态未提供');
    expect(row('missing')?.cells[3].textContent).toContain('暂无已保存结果');
    expect(vi.mocked(authFetch).mock.calls.map(([url]) => String(url))).toEqual(['/api/investigations?limit=20']);
    page.permissions = new Set(['chat:view']);
    await vi.waitFor(() => {
      expect(row('active')?.cells[0].textContent).toContain('服务器 #9');
      expect(row('active')?.cells[0].textContent).not.toContain('#22899');
    });
  });
});
