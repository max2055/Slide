import { afterEach, expect, it, vi } from 'vitest';
import { InvestigationCreate } from './investigation-create.ts';
import { investigationApi } from '../controllers/investigation-api.ts';
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
