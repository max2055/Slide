import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));
import './instances-db.js';

const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
const instance = { id: 41, name: 'prod-db', host: 'db.example', port: 3306, username: 'dba', password: '', db_type: 'mysql', environment: 'production' };
const settle = async (page: any) => { await page.updateComplete; await new Promise(resolve => setTimeout(resolve, 0)); await page.updateComplete; };
async function mount(edit = false) {
  const page = document.createElement('instances-page') as any;
  document.body.append(page); await settle(page);
  if (edit) page._editInstance(instance); else page._addInstance();
  await settle(page); return page;
}
const save = (page: any) => page.shadowRoot.querySelector('.basic-actions .btn-primary') as HTMLButtonElement;
beforeEach(() => {
  authFetch.mockReset(); showToast.mockReset();
  localStorage.setItem('permissions', JSON.stringify(['instance:manage']));
  authFetch.mockResolvedValue(response([]));
});
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

it.each([false, true])('validates before collection confirmation (configure=%s), exposes Chinese errors and focuses the first invalid control', async configure => {
  const page = await mount();
  const section = page.shadowRoot.querySelector('resource-collection-section');
  const confirm = vi.spyOn(section, 'confirmDiscard');
  page.editorTab = 'collection';
  await page._handleSubmit(false, configure); await settle(page);
  expect(page.editorTab).toBe('basic');
  expect(confirm).not.toHaveBeenCalled();
  expect(page.shadowRoot.activeElement.name).toBe('name');
  for (const [field, message] of [['name', '请输入实例名称'], ['host', '请输入主机地址'], ['username', '请输入用户名']]) {
    const control = page.shadowRoot.querySelector(`[name="${field}"]`);
    expect(control.getAttribute('aria-invalid')).toBe('true');
    const description = page.shadowRoot.getElementById(control.getAttribute('aria-describedby'));
    expect(description.textContent).toBe(message);
  }
  expect(authFetch.mock.calls.some(([, options]) => options?.method)).toBe(false);
  page._updateForm('name', '已纠正'); await settle(page);
  expect(page.shadowRoot.querySelector('[name="name"]').hasAttribute('aria-invalid')).toBe(false);
  await page._handleSubmit(false);
  expect(page.shadowRoot.activeElement.name).toBe('host');
});

it.each([0, 65536, 1.5, NaN])('rejects invalid port %s without a write and retains input', async port => {
  const page = await mount(true); page._updateForm('port', port);
  await page._handleSubmit(true); await settle(page);
  expect(page.shadowRoot.activeElement.name).toBe('port');
  expect(page.formErrors.port).toContain('1～65535');
  expect(page.formData.name).toBe(instance.name);
  expect(authFetch.mock.calls.some(([, options]) => options?.method)).toBe(false);
});

it('rejects whitespace-only required values', async () => {
  const page = await mount(true);
  for (const field of ['name', 'host', 'username']) page._updateForm(field, '   ');
  await page._handleSubmit(true);
  expect(page.formErrors).toMatchObject({ name: '请输入实例名称', host: '请输入主机地址', username: '请输入用户名' });
});

it('retains a failed edit, locks fields during saving, prevents duplicate writes and supports retry', async () => {
  const page = await mount(true);
  let resolve!: (value: unknown) => void;
  const pending = new Promise(done => { resolve = done; });
  authFetch.mockImplementation((_url, options) => options?.method === 'PUT' ? pending : Promise.resolve(response([instance])));
  const submission = page._handleSubmit(true); await settle(page);
  expect(save(page).disabled).toBe(true);
  expect(save(page).textContent).toContain('保存中');
  expect([...page.shadowRoot.querySelectorAll('.instance-form input, .instance-form select, .instance-form textarea')].every((control: any) => control.disabled)).toBe(true);
  await page._handleSubmit(true);
  expect(authFetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  resolve(response({ error: '连接信息保存失败' }, false)); await submission; await settle(page);
  expect(page.editorTab).toBe('basic'); expect(page.showEditDialog).toBe(true);
  expect(page.formData).toMatchObject({ name: instance.name, host: instance.host, username: instance.username, password: '' });
  expect(page.shadowRoot.querySelector('[role="alert"]').textContent).toContain('输入已保留');
  expect(save(page).disabled).toBe(false);
  authFetch.mockImplementation(async (_url, options) => options?.method === 'PUT' ? response({ ok: true }) : response([instance]));
  await page._handleSubmit(true);
  expect(page.showEditDialog).toBe(false);
});

it.each([false, true])('protects a real collection draft before save (configure=%s), and continues only after discard', async configure => {
  const page = await mount(true);
  const section = page.shadowRoot.querySelector('resource-collection-section'); await settle(section);
  const editor = section.shadowRoot.querySelector('metric-configuration'); await settle(editor);
  editor.dirty = true;
  authFetch.mockClear();
  await page._handleSubmit(true, configure); await settle(page); await settle(editor);
  expect(page.editorTab).toBe('collection'); expect(editor.discardPending).toBe(true);
  expect(authFetch.mock.calls.some(([, options]) => options?.method)).toBe(false);
  const buttons = () => [...editor.shadowRoot.querySelectorAll('button')] as HTMLButtonElement[];
  buttons().find(button => button.textContent?.trim() === '继续编辑')!.click();
  await settle(editor); expect(editor.dirty).toBe(true); expect(page.showEditDialog).toBe(true);
  await page._handleSubmit(true, configure); await settle(editor);
  authFetch.mockImplementation(async (_url, options) => options?.method === 'PUT' ? response({ ok: true }) : response([instance]));
  buttons().find(button => button.textContent?.trim() === '放弃修改并继续')!.click();
  await settle(page);
  expect(authFetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  expect(page.showEditDialog).toBe(configure);
  if (configure) expect(page.editorTab).toBe('collection');
});

it('returns directly and restores the add button focus when collection is clean', async () => {
  const page = await mount(); page._closeDialogs(); await settle(page);
  expect(page.showAddDialog).toBe(false);
  expect(page.shadowRoot.activeElement.classList.contains('resource-action--add')).toBe(true);
});
