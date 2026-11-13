import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));
import './servers-page.js';

const server = { id: 391001, label: 'MAX391独占样本', os_type: 'unrecognized-os', host: '192.0.2.87', port: 3306, username: 'test' };
const response = (ok = true, body: unknown = []) => ({ ok, json: async () => body });
const settle = async (page: any) => { await page.updateComplete; await new Promise(resolve => setTimeout(resolve, 0)); await page.updateComplete; };
const deletes = () => authFetch.mock.calls.filter(([, options]) => options?.method === 'DELETE');
async function mount() {
  const page = document.createElement('servers-page') as any;
  document.body.append(page); await settle(page);
  page._confirmDelete(server); await settle(page);
  return page;
}
beforeEach(() => {
  authFetch.mockReset(); showToast.mockReset();
  localStorage.setItem('permissions', JSON.stringify(['servers:view', 'servers:manage']));
  authFetch.mockResolvedValue(response());
});
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

it('MAX391: delayed duplicate events send one DELETE and cannot switch or close the target', async () => {
  const page = await mount(); authFetch.mockClear();
  let resolve!: (value: unknown) => void;
  authFetch.mockImplementation((_url, options) => options?.method === 'DELETE' ? new Promise(done => { resolve = done; }) : Promise.resolve(response()));
  const pending = page._handleDelete();
  void page._handleDelete();
  expect(deletes()).toHaveLength(1);
  await settle(page);
  expect(page.shadowRoot.querySelector('app-dialog button.danger').disabled).toBe(true);
  expect(page.shadowRoot.querySelector('app-dialog').closable).toBe(false);
  page._confirmDelete({ ...server, id: 391002 }); page._closeDeleteDialog();
  expect(page._deletingServer.id).toBe(server.id);
  expect(page._showDeleteDialog).toBe(true);
  resolve(response()); await pending; await settle(page);
  expect(page._showDeleteDialog).toBe(false);
  expect(page._isDeleting).toBe(false);
  expect(showToast).toHaveBeenCalledWith('服务器已删除', 'success');
  expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/servers' && !options?.method)).toHaveLength(1);
  page._confirmDelete({ ...server, id: 391002 }); await settle(page);
  expect(page._deletingServer.id).toBe(391002);
  expect(page.shadowRoot.querySelector('app-dialog button.danger').disabled).toBe(false);
});

it.each(['http', 'network', 'invalid-json'])('MAX391: %s failure retains target, clears busy and retries only on explicit confirmation', async failure => {
  const page = await mount(); authFetch.mockClear();
  authFetch.mockImplementation(async (_url, options) => {
    if (options?.method !== 'DELETE') return response();
    if (failure === 'network') throw new Error('网络中断');
    if (failure === 'invalid-json') return { ok: false, json: async () => { throw new Error('bad JSON'); } };
    return response(false, { error: '服务器仍在使用' });
  });
  await page._handleDelete(); await settle(page);
  expect(page._showDeleteDialog).toBe(true);
  expect(page._deletingServer.id).toBe(server.id);
  expect(page._isDeleting).toBe(false);
  expect(page.shadowRoot.querySelector('app-dialog button.danger').disabled).toBe(false);
  expect(showToast.mock.calls[0][0]).toMatch(/^删除失败：/);
  expect(page.shadowRoot.querySelector('[role="alert"]').textContent).toContain('删除失败');
  expect(deletes()).toHaveLength(1);
  authFetch.mockResolvedValue(response());
  await page._handleDelete(); await settle(page);
  expect(deletes()).toHaveLength(2);
  expect(page._showDeleteDialog).toBe(false);
  expect(showToast).toHaveBeenLastCalledWith('服务器已删除', 'success');
});

it('MAX391: cancellation before submission sends nothing and a later target has no old error', async () => {
  const page = await mount(); authFetch.mockClear();
  page._closeDeleteDialog();
  await page._handleDelete();
  expect(deletes()).toHaveLength(0);
  page._confirmDelete(server);
  authFetch.mockResolvedValue(response(false, { error: '服务器仍在使用' }));
  await page._handleDelete();
  expect(page._deleteError).toContain('服务器仍在使用');
  page._closeDeleteDialog();
  page._confirmDelete({ ...server, id: 391002 });
  expect(page._deleteError).toBe('');
  authFetch.mockResolvedValue(response());
  await page._handleDelete();
  expect(deletes().map(([url]) => url)).toEqual(['/api/servers/391001', '/api/servers/391002']);
});

it('MAX391: a late failure belongs to the locked target and a close event is vetoed before rerender', async () => {
  const page = await mount(); authFetch.mockClear();
  let reject!: (reason: Error) => void;
  authFetch.mockImplementation((_url, options) => options?.method === 'DELETE'
    ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve(response()));
  const pending = page._handleDelete();
  const event = new Event('app-dialog-close', { cancelable: true });
  page.shadowRoot.querySelector('app-dialog').dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  page._confirmDelete({ ...server, id: 391002 });
  reject(new Error('结果未知'));
  await pending; await settle(page);
  expect(page._deletingServer.id).toBe(server.id);
  expect(page._showDeleteDialog).toBe(true);
  expect(page._isDeleting).toBe(false);
  expect(page._deleteError).toContain('刷新列表核对后再重试');
  expect(deletes()).toHaveLength(1);
});
