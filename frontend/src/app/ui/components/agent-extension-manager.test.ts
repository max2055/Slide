import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), toast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ apiClient: mocks }));
vi.mock('./app-toast-container.js', () => ({ showToast: mocks.toast }));
import { AgentExtensionManager } from './agent-extension-manager.js';
const extension = { id: 1, kind: 'skill', name: 'sample-skill', description: 'stored', definition: {}, sourceText: null, status: 'draft', version: 1 };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function permissions(value: string[]) { localStorage.setItem('permissions', JSON.stringify(value)); window.dispatchEvent(new Event('slide-permissions-loaded')); }
async function mount(value = ['*']) {
  permissions(value); const el = new AgentExtensionManager(); el.kind = 'skill'; document.body.append(el); await tick(); await el.updateComplete; return el;
}
beforeEach(() => { mocks.get.mockResolvedValue({ extensions: [extension] }); });
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.resetAllMocks(); });
it.each([['ai:view'], ['ai:*'], ['*:view']])('#415 %j can read without write controls', async permission => {
  const el = await mount([permission]); expect(el.shadowRoot!.textContent).toContain('sample-skill');
  expect(el.shadowRoot!.querySelectorAll('button')).toHaveLength(0);
  await (el as any).save(); await (el as any).publish(extension); await (el as any).archive(extension);
  expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.delete).not.toHaveBeenCalled();
});
it.each([['*'], ['ai:view', 'admin:*']].map(value => ({ value })))('#415 admin $value sees controls; no ai:view sends no list request', async ({ value }) => {
  const el = await mount(value); expect(el.shadowRoot!.textContent).toContain('编辑');
  mocks.get.mockClear(); permissions([]); await el.updateComplete;
  expect(el.shadowRoot!.querySelector('.header')).toBeNull(); expect(mocks.get).not.toHaveBeenCalled();
});
it('#415 refresh revokes controls, erases editor and rejects a late list response', async () => {
  const el = await mount(); (el as any).beginEdit(extension); await el.updateComplete;
  let release!: (value: unknown) => void;
  mocks.get.mockImplementationOnce(() => new Promise(resolve => release = resolve)); permissions(['ai:view']);
  permissions([]); release({ extensions: [extension] }); await tick(); await el.updateComplete;
  expect((el as any).extensions).toEqual([]); expect((el as any).open).toBe(false); expect((el as any).name).toBe('');
  permissions(['ai:view']); await tick(); await el.updateComplete;
  expect(el.shadowRoot!.textContent).toContain('sample-skill'); expect(el.shadowRoot!.querySelectorAll('button')).toHaveLength(0);
});
it('#415 backend 403 clears cached rows; session expiry hides content', async () => {
  const el = await mount(); mocks.get.mockRejectedValueOnce({ status: 403 }); await (el as any).load(); await el.updateComplete;
  expect(el.shadowRoot!.textContent).not.toContain('sample-skill'); expect(mocks.toast).toHaveBeenCalledWith('加载扩展列表失败', 'error');
  window.dispatchEvent(new Event('slide-session-expired')); await el.updateComplete; expect(el.shadowRoot!.querySelector('.header')).toBeNull();
});
it.each([false, true])('#645 synchronous double save sends one request (editing=%s), failure permits retry', async editing => {
  const el = await mount(); if (editing) (el as any).beginEdit(extension); else (el as any).beginCreate();
  let reject!: (error: Error) => void;
  const request = editing ? mocks.put : mocks.post; request.mockImplementationOnce(() => new Promise((_, fail) => reject = fail));
  const first = (el as any).save(); const second = (el as any).save(); expect(request).toHaveBeenCalledTimes(1);
  reject(new Error('failed')); await Promise.all([first, second]); expect((el as any).open).toBe(true);
  request.mockResolvedValueOnce({ extension }); await (el as any).save(); expect(request).toHaveBeenCalledTimes(2); expect((el as any).open).toBe(false);
});
it('#645 invalid JSON allows correction without a request', async () => {
  const el = await mount(); (el as any).beginCreate(); (el as any).definition = '{'; await (el as any).save(); expect(mocks.post).not.toHaveBeenCalled();
  (el as any).definition = '{}'; await (el as any).save(); expect(mocks.post).toHaveBeenCalledOnce();
});
