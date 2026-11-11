import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));
import './instances-db.js';

const instance = { id: 387001, name: 'MAX387独占样本', db_type: 'mysql', host: '192.0.2.87', port: 3306, username: 'test' };
const response = (ok = true, body: unknown = []) => ({ ok, json: async () => body });
const settle = async (page: any) => { await page.updateComplete; await new Promise(resolve => setTimeout(resolve, 0)); await page.updateComplete; };
const deletes = () => authFetch.mock.calls.filter(([, options]) => options?.method === 'DELETE');
async function mount() {
  const page = document.createElement('instances-page') as any;
  document.body.append(page); await settle(page);
  page._deleteInstance(instance); await settle(page);
  return page;
}
beforeEach(() => {
  authFetch.mockReset(); showToast.mockReset();
  localStorage.setItem('permissions', JSON.stringify(['instance:view', 'instance:delete']));
  authFetch.mockResolvedValue(response());
});
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

it('MAX387: delayed duplicate events send one DELETE and cannot switch or close the target', async () => {
  const page = await mount(); authFetch.mockClear();
  let resolve!: (value: unknown) => void;
  authFetch.mockImplementation((_url, options) => options?.method === 'DELETE' ? new Promise(done => { resolve = done; }) : Promise.resolve(response()));
  const pending = page._handleDelete();
  void page._handleDelete();
  expect(deletes()).toHaveLength(1);
  await settle(page);
  expect(page.shadowRoot.querySelector('app-dialog button.danger').disabled).toBe(true);
  expect(page.shadowRoot.querySelector('app-dialog').closable).toBe(false);
  page._deleteInstance({ ...instance, id: 387002 }); page._closeDialogs();
  expect(page.deletingInstance.id).toBe(instance.id);
  expect(page.showDeleteDialog).toBe(true);
  resolve(response()); await pending; await settle(page);
  expect(page.showDeleteDialog).toBe(false);
  expect(page.isDeleting).toBe(false);
  expect(showToast).toHaveBeenCalledWith('实例删除成功', 'success');
  expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances' && !options?.method)).toHaveLength(1);
  page._deleteInstance({ ...instance, id: 387002 }); await settle(page);
  expect(page.deletingInstance.id).toBe(387002);
  expect(page.shadowRoot.querySelector('app-dialog button.danger').disabled).toBe(false);
});

it.each(['http', 'network', 'invalid-json'])('MAX388: %s failure retains target, clears busy and retries only on explicit confirmation', async failure => {
  const page = await mount(); authFetch.mockClear();
  authFetch.mockImplementation(async (_url, options) => {
    if (options?.method !== 'DELETE') return response();
    if (failure === 'network') throw new Error('网络中断');
    if (failure === 'invalid-json') return { ok: false, json: async () => { throw new Error('bad JSON'); } };
    return response(false, { error: '实例仍在使用' });
  });
  await page._handleDelete(); await settle(page);
  expect(page.showDeleteDialog).toBe(true);
  expect(page.deletingInstance.id).toBe(instance.id);
  expect(page.isDeleting).toBe(false);
  expect(page.shadowRoot.querySelector('app-dialog button.danger').disabled).toBe(false);
  expect(showToast.mock.calls[0][0]).toMatch(/^删除失败：/);
  expect(page.shadowRoot.querySelector('[role="alert"]').textContent).toContain('删除失败');
  expect(deletes()).toHaveLength(1);
  authFetch.mockResolvedValue(response());
  await page._handleDelete(); await settle(page);
  expect(deletes()).toHaveLength(2);
  expect(page.showDeleteDialog).toBe(false);
  expect(showToast).toHaveBeenLastCalledWith('实例删除成功', 'success');
});
