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
