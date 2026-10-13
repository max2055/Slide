import { afterEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import { InvestigationProfilesPage } from './investigation-profiles.ts';
vi.mock('../../../api/index.ts', () => ({ authFetch: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });
async function view() {
  const element = new InvestigationProfilesPage(); document.body.append(element);
  await vi.waitFor(() => expect((element as any).loading).toBe(false)); await element.updateComplete;
  return element;
}
it.each([401, 403, 503])('HTTP %s clears old facts and exposes a recoverable state', async status => {
  vi.mocked(authFetch).mockResolvedValue(new Response('{}', { status }));
  const element = await view();
  expect((element as any).facts).toBeNull();
  expect(element.shadowRoot!.textContent).toContain(status === 401 ? '登录已失效' : status === 403 ? '无权访问' : '加载失败');
  expect(vi.mocked(authFetch)).toHaveBeenCalledWith('/api/investigation-profiles', { cache: 'no-store' });
});
it('empty service facts show the unconfigured state', async () => {
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ items: [] })));
  const element = await view();
  expect(element.shadowRoot!.querySelector('app-empty-state')?.getAttribute('title')).toBe('尚未配置 Profiles');
});
it.each(['slide-session-expired', 'slide-permissions-loaded', 'disconnect'])('%s invalidates a late successful read', async boundary => {
  let deliver!: (response: Response) => void;
  vi.mocked(authFetch).mockImplementation(() => new Promise(resolve => deliver = resolve));
  const element = new InvestigationProfilesPage(); document.body.append(element); await element.updateComplete;
  const pending = (element as any).load();
  if (boundary === 'disconnect') element.remove();
  else window.dispatchEvent(new CustomEvent(boundary, { detail: { permissions: [] } }));
  deliver(new Response(JSON.stringify({ items: [{ profileHash: 'secret' }] }))); await pending; await element.updateComplete;
  expect((element as any).facts).toBeNull(); expect(element.shadowRoot!.textContent).not.toContain('secret');
});
