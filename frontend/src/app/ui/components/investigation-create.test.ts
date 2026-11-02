import { afterEach, expect, it, vi } from 'vitest';
import type { AppDialog } from './app-dialog.ts';
import { InvestigationCreate } from './investigation-create.ts';
import { investigationApi, InvestigationApiError } from '../controllers/investigation-api.ts';
vi.mock('../controllers/investigation-api.ts', async importOriginal => ({ ...await importOriginal<object>(), investigationApi: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });
async function form() {
  const view = new InvestigationCreate(); view.sessionId = 'one'; document.body.append(view);
  view.open = true; await view.updateComplete;
  for (const [name, value] of [['调查标题', 'sensitive title'], ['调查目标', 'sensitive goal'], ['资源 ID', '101']]) {
    const input = view.querySelector(`[aria-label="${name}"]`) as HTMLInputElement;
    input.value = value; input.dispatchEvent(new Event('input')); await view.updateComplete;
  }
  return view;
}
it.each(['slide-session-expired', 'slide-permissions-loaded'])('%s erases create/conversion drafts', async event => {
  const view = await form();
  window.dispatchEvent(new CustomEvent(event, { detail: { permissions: [] } })); await view.updateComplete;
  expect(view.open).toBe(false);
  for (const input of view.querySelectorAll('input,textarea')) expect((input as HTMLInputElement).value).toBe('');
});
it('switching the Chat Session closes the form and erases the prior draft', async () => {
  const view = await form(); view.sessionId = 'two'; await view.updateComplete;
  expect(view.open).toBe(false); expect((view.querySelector('[aria-label="调查目标"]') as HTMLInputElement).value).toBe('');
});
it('authority withdrawal ignores a late accepted create instead of navigating to its data', async () => {
  let release!: (value: any) => void;
  vi.mocked(investigationApi).mockImplementation(() => new Promise(resolve => release = resolve));
  const view = await form(), created = vi.fn(); view.addEventListener('investigation-created', created);
  const pending = (view as any).submit();
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } }));
  release({ id: 'sensitive' }); await pending; await view.updateComplete;
  expect(created).not.toHaveBeenCalled(); expect(view.open).toBe(false);
});
it.each([401, 403, 404])('HTTP %s reading authority rejection erases the independent form draft', async status => {
  vi.mocked(investigationApi).mockRejectedValue(new InvestigationApiError(status, 'INVESTIGATION_NOT_FOUND'));
  const view = await form(), created = vi.fn(); view.addEventListener('investigation-created', created);
  await (view as any).submit(); await view.updateComplete;
  expect(view.open).toBe(false);
  for (const input of view.querySelectorAll('input,textarea')) expect((input as HTMLInputElement).value).toBe('');
  expect(created).not.toHaveBeenCalled();
});
it('operator-only rejection keeps readable drafts and does not navigate', async () => {
  vi.mocked(investigationApi).mockRejectedValue(new InvestigationApiError(403, 'INVESTIGATION_OPERATION_FORBIDDEN'));
  const view = await form(); await (view as any).submit(); await view.updateComplete;
  expect(view.open).toBe(true);
  expect((view.querySelector('[aria-label="调查目标"]') as HTMLInputElement).value).toBe('sensitive goal');
  expect(view.querySelector('[role="alert"]')?.textContent).toContain('操作权限');
});
it('unknown acceptance retries the same body and idempotency key', async () => {
  vi.mocked(investigationApi).mockRejectedValueOnce(new InvestigationApiError(503, 'INVESTIGATION_QUEUE_UNAVAILABLE')).mockResolvedValueOnce({ id: 'accepted' });
  const view = await form(); await (view as any).submit(); await view.updateComplete;
  expect(view.open).toBe(true);
  expect((view.querySelector('[aria-label="调查目标"]') as HTMLInputElement).value).toBe('sensitive goal');
  await (view as any).submit();
  const [first, retry] = vi.mocked(investigationApi).mock.calls;
  expect(retry).toEqual(first);
});

it('ignores an outside click without losing the investigation draft', async () => {
  const view = await form();
  const dialog = view.querySelector<AppDialog>('app-dialog')!;
  await dialog.updateComplete;
  dialog.shadowRoot!.querySelector('.dialog-overlay')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await view.updateComplete;
  expect(view.open).toBe(true);
  expect((view.querySelector('[aria-label="调查目标"]') as HTMLInputElement).value).toBe('sensitive goal');
});
it('common resource and platform scenarios generate bounded title, goal and absolute window with zero free text', async () => {
  for (const profile of ['ops','system']) {
    const view = new InvestigationCreate(); document.body.append(view);view.open=true;await view.updateComplete;
    (view as any).profile=profile;(view as any).selected=profile==='ops'?['server:12','instance:8']:[];
    (view as any).resourceNames={'server:12':'演练服务器','instance:8':'测试库'};
    vi.mocked(investigationApi).mockResolvedValueOnce({id:'created'});
    const before=Date.now(); await (view as any).submit();
    const body=JSON.parse(vi.mocked(investigationApi).mock.calls.at(-1)![1]!.body as string);
    expect(body.title).toContain(profile==='ops'?'演练服务器':'Slide 平台');
    expect(body.goal).toContain('只读');expect(Date.parse(body.to)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(body.to)-Date.parse(body.from)).toBe(30*60_000);
    expect(body.resourceRefs).toHaveLength(profile==='ops'?2:0);view.remove();
  }
});
it('custom question requires just one description and derives its title', async () => {
  const view=new InvestigationCreate();document.body.append(view);view.open=true;await view.updateComplete;
  (view as any).scenario='custom';(view as any).profile='system';
  const before=vi.mocked(investigationApi).mock.calls.length;await (view as any).submit();
  expect(vi.mocked(investigationApi).mock.calls).toHaveLength(before);
  (view as any).goal='核对最近启动失败';vi.mocked(investigationApi).mockResolvedValueOnce({id:'created'});
  await (view as any).submit();const body=JSON.parse(vi.mocked(investigationApi).mock.calls.at(-1)![1]!.body as string);
  expect(body.title).toBe('Slide 平台 · 自定义调查');expect(body.goal).toBe('核对最近启动失败');
});
