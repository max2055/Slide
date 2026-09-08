import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './resource-invariants.js';
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); authFetch.mockReset(); });
async function mount() {
  localStorage.setItem('permissions', JSON.stringify(['admin:*']));
  const view = document.createElement('resource-invariants') as HTMLElement & { resourceType: string; resourceId: number };
  view.resourceType = 'server'; view.resourceId = 2; document.body.append(view); await settle(); return view;
}
function input(view: HTMLElement, name: string, value: string) {
  const field = view.shadowRoot!.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
  field.value = value; field.dispatchEvent(new Event('input'));
}
it('saves structured rules with the loaded optimistic version and announces refresh', async () => {
  authFetch.mockImplementation(async (_url: string, options?: RequestInit) => ({ ok: true, json: async () => options ? { schemaVersion: 1, version: 4, rules: JSON.parse(String(options.body)).rules } : { schemaVersion: 1, version: 3, rules: [] } }));
  const view = await mount();
  expect(view.shadowRoot?.querySelector('form')).toBeTruthy();
  input(view, '规则 ID', 'cpu-limit'); input(view, '指标 ID', 'cpu'); input(view, '下界', '0'); input(view, '上界', '100'); input(view, '维度 JSON', '{"core":"all"}');
  const refreshed = vi.fn(); view.addEventListener('rules-saved', refreshed);
  view.shadowRoot!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  expect(authFetch).toHaveBeenCalledWith('/api/resources/server/2/invariants', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ expectedVersion: 3, rules: [{ id: 'cpu-limit', version: 1, metricId: 'cpu', min: 0, max: 100, dimensions: { core: 'all' } }] }) }));
  expect(refreshed).toHaveBeenCalledOnce();
});
it('preserves the edit and reports an optimistic concurrency conflict without retrying', async () => {
  authFetch.mockImplementation(async (_url: string, options?: RequestInit) => options ? { ok: false, status: 409, json: async () => ({ error: 'RULES_VERSION_CONFLICT' }) } : { ok: true, json: async () => ({ schemaVersion: 1, version: 2, rules: [] }) });
  const view = await mount();
  expect(view.shadowRoot?.querySelector('form')).toBeTruthy();
  input(view, '规则 ID', 'cpu-limit'); input(view, '指标 ID', 'cpu'); input(view, '上界', '90');
  view.shadowRoot!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  expect(view.shadowRoot?.textContent).toContain('RULES_VERSION_CONFLICT');
  expect(view.shadowRoot?.querySelector<HTMLInputElement>('[aria-label="规则 ID"]')?.value).toBe('cpu-limit');
  expect(authFetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
});
it('removes mutation controls immediately after admin permission is revoked', async () => {
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ schemaVersion: 1, version: 0, rules: [] }) });
  const view = await mount();
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: ['servers:view'] } })); await settle();
  expect(view.shadowRoot?.querySelector('form')).toBeNull();
  expect(authFetch.mock.calls.every(([, options]) => !options)).toBe(true);
});
it('rejects non-string structured dimensions before submitting', async () => {
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ schemaVersion: 1, version: 0, rules: [] }) });
  const view = await mount();
  input(view, '规则 ID', 'cpu-limit'); input(view, '指标 ID', 'cpu'); input(view, '上界', '90'); input(view, '维度 JSON', '{"core":1}');
  view.shadowRoot!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  expect(view.shadowRoot?.textContent).toContain('维度必须为字符串键值对象');
  expect(authFetch.mock.calls.every(([, options]) => !options)).toBe(true);
});
